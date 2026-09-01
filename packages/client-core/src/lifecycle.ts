import { CsipDiscoveryError, ResourceClient } from './resource-client.js';
import type { ControlIntent } from './controls.js';
import type { SessionStore } from './session-store.js';
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
  if (!responseRequested(intent.responseRequired, status)) return 0;
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
  const ids = recipients.map((lFDI) => `${intent.internalEventId}\0${lFDI}\0${status}`);
  const existing = store.loadResponseEffects
    ? await store.loadResponseEffects(ids)
    : await Promise.all(ids.map((id) => store.loadResponseEffect(id)));
  const effects = recipients.flatMap((lFDI, index) => {
    if (existing[index]) return [];
    return [{
      id: ids[index],
      internalEventId: intent.internalEventId,
      href: replyTo,
      response: { createdDateTime, endDeviceLFDI: lFDI, status, subject: intent.wireMrid },
      sent: false,
    }];
  });
  if (store.saveResponseEffects) {
    await store.saveResponseEffects(effects);
  } else {
    for (const effect of effects) await store.saveResponseEffect(effect);
  }
  return effects.length;
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
