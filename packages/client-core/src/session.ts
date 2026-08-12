import { ControlPoller, type ControlIntent, type ControlLifecycleUpdate } from './controls.js';
import { LifecycleResponder, type LifecycleOutcome } from './lifecycle.js';
import type { ResourceClient } from './resource-client.js';
import type { AssignmentSnapshot, SessionStore } from './session-store.js';

export interface ControlSink {
  dispatch(intent: ControlIntent): Promise<void>;
  updateLifecycle(update: ControlLifecycleUpdate): Promise<void>;
}

export interface CsipSessionOptions {
  connectionId: string;
  resources: ResourceClient;
  store: SessionStore;
  sink: ControlSink;
  now?: () => number;
}

export interface SessionRunResult {
  delivered: ControlIntent[];
  lifecycleUpdates: ControlLifecycleUpdate[];
  failedDeliveries: number;
  failedLifecycleUpdates: number;
  responses: { sent: number; failed: number };
  pollRates: Array<{ controlListHref: string; seconds: number }>;
}

export class CsipSession {
  readonly #store: SessionStore;
  readonly #sink: ControlSink;
  readonly #poller: ControlPoller;
  readonly #lifecycle: LifecycleResponder;

  constructor(options: CsipSessionOptions) {
    this.#store = options.store;
    this.#sink = options.sink;
    this.#poller = new ControlPoller(options);
    this.#lifecycle = new LifecycleResponder(options);
  }

  async runOnce(snapshot: AssignmentSnapshot): Promise<SessionRunResult> {
    const polled = await this.#poller.poll(snapshot);
    const delivered: ControlIntent[] = [];
    let failedDeliveries = 0;
    for (const stored of await this.#store.listPendingControls()) {
      try {
        await this.#sink.dispatch(stored.intent);
        await this.#store.saveControl({ ...stored, intentDelivered: true });
        delivered.push(stored.intent);
      } catch {
        failedDeliveries += 1;
      }
    }

    let failedLifecycleUpdates = 0;
    const lifecycleUpdates: ControlLifecycleUpdate[] = [];
    for (const effect of await this.#store.listPendingLifecycleEffects()) {
      lifecycleUpdates.push(effect.update);
      try {
        await this.#sink.updateLifecycle(effect.update);
        await this.#store.saveLifecycleEffect({ ...effect, sent: true });
      } catch {
        failedLifecycleUpdates += 1;
      }
    }
    const responses = await this.#lifecycle.flushResponses();
    return {
      delivered,
      lifecycleUpdates,
      failedDeliveries,
      failedLifecycleUpdates,
      responses,
      pollRates: polled.pollRates,
    };
  }

  recordOutcome(
    internalEventId: string,
    outcome: LifecycleOutcome,
    endDeviceLfdi?: string,
  ): Promise<number> {
    return this.#lifecycle.recordOutcome(internalEventId, outcome, endDeviceLfdi);
  }

  flushResponses(): Promise<{ sent: number; failed: number }> {
    return this.#lifecycle.flushResponses();
  }
}
