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
    for (const effect of await this.#store.listPendingResponses()) {
      if (effect.response.status === 1) {
        const control = await this.#store.loadControl(effect.internalEventId);
        const state = control ? controlAdmissionState(control) : undefined;
        if (state !== 'accepted') {
          // A 0.3.x store may contain status 1 queued before dispatch. Keep an uncertain effect
          // owed until reconciliation; quarantine it only once admission is terminally non-accepted.
          if (state === 'terminal-rejected' || state === 'withdrawn') {
            await this.#store.saveResponseEffect({ ...effect, sent: true });
          }
          continue;
        }
      }
      try {
        await this.#resources.postControlResponse(effect.href, effect.response);
        await this.#store.saveResponseEffect({ ...effect, sent: true });
        sent += 1;
      } catch {
        failed += 1;
      }
    }
    return { sent, failed };
  }
}
