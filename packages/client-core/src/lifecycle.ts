import { CsipDiscoveryError, ResourceClient } from './resource-client.js';
import type { ControlIntent } from './controls.js';
import {
  controlAdmissionState,
  type SessionStore,
  type StoredResponseEffect,
} from './session-store.js';
import type { CsipResponseStatus } from './wire-types.js';

export type LifecycleOutcome =
  | 'accepted'
  | 'started'
  | 'completed'
  | 'declined'
  | 'cancelled'
  | 'superseded'
  | 'no_participation'
  | 'rejected'
  | 'failed';

const OUTCOME_STATUS: Readonly<Record<LifecycleOutcome, CsipResponseStatus>> = {
  accepted: 1,
  started: 2,
  completed: 3,
  declined: 4,
  cancelled: 6,
  superseded: 7,
  no_participation: 10,
  rejected: 252,
  failed: 253,
};

function requiredBit(status: CsipResponseStatus): number {
  if (status === 1) return 0;
  if (status === 11) return 2;
  return 1;
}

function responseRequested(responseRequired: string, status: CsipResponseStatus): boolean {
  return (Number.parseInt(responseRequired, 16) & (1 << requiredBit(status))) !== 0;
}

export async function queueControlResponse(
  store: SessionStore,
  intent: ControlIntent,
  status: CsipResponseStatus,
  createdDateTime: number,
  endDeviceLfdi?: string,
): Promise<number> {
  const effects = await pendingControlResponseEffects(
    store,
    intent,
    status,
    createdDateTime,
    endDeviceLfdi,
  );
  if (effects.length === 0) return 0;
  if (store.saveResponseEffects) {
    await store.saveResponseEffects(effects);
  } else {
    for (const effect of effects) await store.saveResponseEffect(effect);
  }
  return effects.length;
}

/** Builds deterministic response effects without consulting or mutating durable state. */
export function controlResponseEffects(
  intent: ControlIntent,
  status: CsipResponseStatus,
  createdDateTime: number,
  endDeviceLfdi?: string,
): StoredResponseEffect[] {
  if (!responseRequested(intent.responseRequired, status)) return [];
  if (!intent.replyTo) {
    throw new CsipDiscoveryError(`control ${intent.wireMrid} requests a response without replyTo`);
  }
  const replyTo = intent.replyTo;
  const recipients = endDeviceLfdi === undefined
    ? intent.assignedLFDIs
    : intent.assignedLFDIs.filter((lFDI) => lFDI === endDeviceLfdi);
  if (endDeviceLfdi !== undefined && recipients.length === 0) {
    throw new CsipDiscoveryError(`control ${intent.wireMrid} is not assigned to EndDevice ${endDeviceLfdi}`);
  }
  return recipients.map((lFDI) => ({
    id: `${intent.internalEventId}\0${lFDI}\0${status}`,
    internalEventId: intent.internalEventId,
    href: replyTo,
    response: { createdDateTime, endDeviceLFDI: lFDI, status, subject: intent.wireMrid },
    sent: false,
  }));
}

export async function pendingControlResponseEffects(
  store: SessionStore,
  intent: ControlIntent,
  status: CsipResponseStatus,
  createdDateTime: number,
  endDeviceLfdi?: string,
): Promise<StoredResponseEffect[]> {
  const candidates = controlResponseEffects(intent, status, createdDateTime, endDeviceLfdi);
  if (candidates.length === 0) return [];
  const ids = candidates.map((effect) => effect.id);
  const existing = store.loadResponseEffects
    ? await store.loadResponseEffects(ids)
    : await Promise.all(ids.map((id) => store.loadResponseEffect(id)));
  return candidates.flatMap((effect, index) => {
    if (existing[index]) return [];
    return [effect];
  });
}

export interface LifecycleResponderOptions {
  resources: ResourceClient;
  store: SessionStore;
  now?: () => number;
}

export class LifecycleResponder {
  readonly #resources: ResourceClient;
  readonly #store: SessionStore;
  readonly #now: () => number;

  constructor(options: LifecycleResponderOptions) {
    this.#resources = options.resources;
    this.#store = options.store;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  async recordOutcome(
    internalEventId: string,
    outcome: LifecycleOutcome,
    endDeviceLfdi?: string,
  ): Promise<number> {
    const control = await this.#store.loadControl(internalEventId);
    if (!control) throw new CsipDiscoveryError(`unknown control outcome route: ${internalEventId}`);
    return queueControlResponse(
      this.#store,
      control.intent,
      OUTCOME_STATUS[outcome],
      this.#now(),
      endDeviceLfdi,
    );
  }

  async flushResponses(): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    const pending = await this.#store.listPendingResponses();
    const controls = new Map<string, Awaited<ReturnType<SessionStore['loadControl']>>>();
    for (const eventId of new Set(pending.map((effect) => effect.internalEventId))) {
      controls.set(eventId, await this.#store.loadControl(eventId));
    }
    const blockedRoutes = new Set<string>();
    pending.sort(compareResponseEffects);
    for (const effect of pending) {
      const route = `${effect.internalEventId}\0${effect.response.endDeviceLFDI}`;
      if (blockedRoutes.has(route)) continue;
      const control = controls.get(effect.internalEventId);
      const state = control ? controlAdmissionState(control) : undefined;
      const disposition = responseDisposition(effect.response.status, state);
      if (disposition === 'hold') {
        blockedRoutes.add(route);
        continue;
      }
      if (disposition === 'discard') {
        await this.#store.saveResponseEffect({ ...effect, sent: true });
        continue;
      }
      try {
        await this.#resources.postControlResponse(effect.href, effect.response);
        await this.#store.saveResponseEffect({ ...effect, sent: true });
        sent += 1;
      } catch {
        failed += 1;
        blockedRoutes.add(route);
      }
    }
    return { sent, failed };
  }
}

type ResponseDisposition = 'send' | 'hold' | 'discard';

function responseDisposition(
  status: CsipResponseStatus,
  state: ReturnType<typeof controlAdmissionState> | undefined,
): ResponseDisposition {
  if (state === undefined || state === 'pending' || state === 'uncertain') return 'hold';
  if (status === 252) return state === 'terminal-rejected' ? 'send' : 'discard';
  if (status === 6 || status === 7) {
    return state === 'accepted' || state === 'withdrawn' ? 'send' : 'discard';
  }
  return state === 'accepted' ? 'send' : 'discard';
}

function compareResponseEffects(left: StoredResponseEffect, right: StoredResponseEffect): number {
  const leftRoute = `${left.internalEventId}\0${left.response.endDeviceLFDI}`;
  const rightRoute = `${right.internalEventId}\0${right.response.endDeviceLFDI}`;
  if (leftRoute !== rightRoute) return leftRoute.localeCompare(rightRoute);
  const rank = (effect: StoredResponseEffect): number => {
    if (effect.response.status === 1) return 0;
    if (effect.response.status === 2) return 1;
    return 2;
  };
  return rank(left) - rank(right)
    || left.response.createdDateTime - right.response.createdDateTime
    || left.response.status - right.response.status
    || left.id.localeCompare(right.id);
}
