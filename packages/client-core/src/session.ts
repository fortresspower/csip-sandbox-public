import { ControlPoller, type ControlIntent, type ControlLifecycleUpdate } from './controls.js';
import {
  controlResponseEffects,
  LifecycleResponder,
  type LifecycleOutcome,
} from './lifecycle.js';
import type { ResourceClient } from './resource-client.js';
import type {
  AssignmentSnapshot,
  SessionStore,
  StoredControl,
  StoredLifecycleEffect,
} from './session-store.js';

export interface ControlSink {
  /**
   * Return accepted only after the downstream system has durably admitted the intent.
   * Return terminal-rejected for a permanent policy or capability denial. Throw when the
   * outcome is transient or unknown so the session keeps the intent pending for retry.
   * Calls are at least once and must reconcile idempotently on intent.internalEventId: after
   * an uncertain outcome, another call returns the same durable result without repeating actuation.
   */
  dispatch(intent: ControlIntent): Promise<ControlAdmissionResult>;
  updateLifecycle(update: ControlLifecycleUpdate): Promise<void>;
}

export type ControlAdmissionResult =
  | { status: 'accepted' }
  | { status: 'terminal-rejected' };

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
  readonly #now: () => number;

  constructor(options: CsipSessionOptions) {
    this.#store = options.store;
    this.#sink = options.sink;
    this.#poller = new ControlPoller(options);
    this.#lifecycle = new LifecycleResponder(options);
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  async runOnce(snapshot: AssignmentSnapshot): Promise<SessionRunResult> {
    const polled = await this.#poller.poll(snapshot);
    const delivered: ControlIntent[] = [];
    let failedDeliveries = 0;
    for (const stored of await this.#store.listPendingControls()) {
      try {
        const attempted = stored.admissionState === 'pending'
          ? { ...stored, admissionState: 'uncertain' as const }
          : stored;
        if (attempted !== stored) await this.#store.saveControl(attempted);
        const admission = await this.#sink.dispatch(stored.intent);
        const responseEffects = [
          ...controlResponseEffects(
            stored.intent,
            admission.status === 'accepted' ? 1 : 252,
            this.#now(),
          ),
        ];
        const terminal = admission.status === 'accepted'
          ? terminalLifecycleEffect(attempted)
          : undefined;
        if (terminal) {
          responseEffects.push(...controlResponseEffects(
            stored.intent,
            terminal.update.kind === 'cancelled' ? 6 : 7,
            this.#now(),
          ));
        }
        await this.#store.completeControlAdmission(
          {
            ...attempted,
            admissionState: admission.status === 'accepted' ? 'accepted' : 'terminal-rejected',
          },
          responseEffects,
          terminal ? [terminal] : [],
        );
        if (admission.status === 'accepted') delivered.push(stored.intent);
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

function terminalLifecycleEffect(control: StoredControl): StoredLifecycleEffect | undefined {
  const kind = control.lastStatus === 2 || control.lastStatus === 3
    ? 'cancelled'
    : control.lastStatus === 4
      ? 'superseded'
      : undefined;
  if (!kind) return undefined;
  const update: ControlLifecycleUpdate = {
    connectionId: control.intent.connectionId,
    internalEventId: control.internalEventId,
    wireMrid: control.intent.wireMrid,
    assignedLFDIs: [...control.intent.assignedLFDIs],
    kind,
  };
  return {
    id: `${update.internalEventId}\0reconciled-${control.lastStatus}`,
    update,
    sent: false,
  };
}
