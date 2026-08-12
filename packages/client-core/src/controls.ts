import { createHash } from 'node:crypto';
import { queueControlResponse } from './lifecycle.js';
import { isCanonicalLfdi } from './identity.js';
import { CsipDiscoveryError, ResourceClient } from './resource-client.js';
import type { AssignmentSnapshot, SessionStore, StoredControl } from './session-store.js';
import type { CsipDerControl, CsipDerControlBase } from './wire-types.js';

export interface ControlIntent {
  family: 'csip';
  connectionId: string;
  internalEventId: string;
  wireMrid: string;
  programMrid: string;
  programPrimacy: number;
  assignedLFDIs: string[];
  replyTo?: string;
  responseRequired: string;
  creationTime: number;
  eventStatus: number;
  interval: { start: number; duration: number };
  control: CsipDerControlBase;
}

export interface ControlLifecycleUpdate {
  connectionId: string;
  internalEventId: string;
  wireMrid: string;
  assignedLFDIs: string[];
  kind: 'cancelled' | 'superseded';
}

export interface ControlPollResult {
  intents: ControlIntent[];
  lifecycleUpdates: ControlLifecycleUpdate[];
  pollRates: Array<{ controlListHref: string; seconds: number }>;
}

export class ControlRevisionError extends CsipDiscoveryError {
  constructor(wireMrid: string) {
    super(`control ${wireMrid} changed material fields without a new mRID`);
    this.name = 'ControlRevisionError';
  }
}

interface ProgramRoute {
  mRID: string;
  primacy: number;
  controlListHref: string;
  assignedLFDIs: string[];
}

export function deriveInternalEventId(connectionId: string, wireMrid: string): string {
  if (!connectionId || !wireMrid || connectionId.includes('\0') || wireMrid.includes('\0')) {
    throw new CsipDiscoveryError('connection ID and control mRID must be non-empty and must not contain NUL');
  }
  return `csip-${createHash('sha256')
    .update('fortress:csip:control:v1')
    .update('\0')
    .update(connectionId)
    .update('\0')
    .update(wireMrid)
    .digest('hex')}`;
}

function materialFingerprint(route: ProgramRoute, control: CsipDerControl): string {
  return createHash('sha256').update(JSON.stringify({
    programMrid: route.mRID,
    programPrimacy: route.primacy,
    wireMrid: control.mRID,
    creationTime: control.creationTime,
    interval: control.interval,
    control: control.DERControlBase,
    replyTo: control.replyTo ?? null,
    responseRequired: control.responseRequired,
  })).digest('hex');
}

function routes(snapshot: AssignmentSnapshot): ProgramRoute[] {
  if (!snapshot.valid) throw new CsipDiscoveryError('cannot poll controls from an invalid assignment snapshot');
  const grouped = new Map<string, ProgramRoute>();
  for (const device of snapshot.devices) {
    if (!isCanonicalLfdi(device.lFDI)) {
      throw new CsipDiscoveryError(`assignment snapshot contains invalid LFDI ${device.lFDI}`);
    }
    for (const program of device.programs) {
      if (!Number.isSafeInteger(program.primacy) || program.primacy < 0 || program.primacy > 255) {
        throw new CsipDiscoveryError(`DERProgram ${program.mRID} has invalid primacy`);
      }
      const key = `${program.mRID}\0${program.primacy}\0${program.controlListHref}`;
      const route = grouped.get(key) ?? {
        mRID: program.mRID,
        primacy: program.primacy,
        controlListHref: program.controlListHref,
        assignedLFDIs: [],
      };
      if (!route.assignedLFDIs.includes(device.lFDI)) route.assignedLFDIs.push(device.lFDI);
      grouped.set(key, route);
    }
  }
  return [...grouped.values()];
}

export interface ControlPollerOptions {
  connectionId: string;
  resources: ResourceClient;
  store: SessionStore;
  now?: () => number;
}

export class ControlPoller {
  readonly #connectionId: string;
  readonly #resources: ResourceClient;
  readonly #store: SessionStore;
  readonly #now: () => number;

  constructor(options: ControlPollerOptions) {
    this.#connectionId = options.connectionId;
    this.#resources = options.resources;
    this.#store = options.store;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  async poll(snapshot: AssignmentSnapshot): Promise<ControlPollResult> {
    const intents: ControlIntent[] = [];
    const lifecycleUpdates: ControlLifecycleUpdate[] = [];
    const pollRates: ControlPollResult['pollRates'] = [];
    const currentAssignments = new Map<string, string[]>();
    for (const route of routes(snapshot)) {
      const list = await this.#resources.derControls(route.controlListHref);
      if (list.pollRate !== undefined) pollRates.push({ controlListHref: route.controlListHref, seconds: list.pollRate });
      for (const control of list.items) {
        const eventId = deriveInternalEventId(this.#connectionId, control.mRID);
        currentAssignments.set(eventId, [...route.assignedLFDIs]);
        if (control.href) this.#resources.canonicalHref(control.href);
        if (control.replyTo) this.#resources.canonicalHref(control.replyTo);
        const responseFlags = Number.parseInt(control.responseRequired, 16);
        if ((responseFlags & ~0x07) !== 0) {
          throw new CsipDiscoveryError(`control ${control.mRID} uses reserved responseRequired bits`);
        }
        if (responseFlags !== 0) {
          if (!control.replyTo) throw new CsipDiscoveryError(`control ${control.mRID} requests a response without replyTo`);
        }
        if (!Number.isSafeInteger(control.EventStatus.currentStatus)
          || control.EventStatus.currentStatus < 0
          || control.EventStatus.currentStatus > 4) {
          throw new CsipDiscoveryError(`control ${control.mRID} has invalid EventStatus.currentStatus`);
        }
        if (!Number.isSafeInteger(control.creationTime)
          || !Number.isSafeInteger(control.interval.start)
          || !Number.isSafeInteger(control.interval.duration)
          || control.interval.duration < 0) {
          throw new CsipDiscoveryError(`control ${control.mRID} has invalid event timing`);
        }
        const fingerprint = materialFingerprint(route, control);
        const existing = await this.#store.loadControl(eventId);
        if (existing) {
          if (existing.materialFingerprint !== fingerprint) throw new ControlRevisionError(control.mRID);
          const update = this.#statusUpdate(existing, control.EventStatus.currentStatus);
          if (update) {
            lifecycleUpdates.push(update);
            const effectId = `${update.internalEventId}\0${control.EventStatus.currentStatus}`;
            if (!(await this.#store.loadLifecycleEffect(effectId))) {
              await this.#store.saveLifecycleEffect({ id: effectId, update, sent: false });
            }
            await queueControlResponse(
              this.#store,
              existing.intent,
              update.kind === 'cancelled' ? 6 : 7,
              this.#now(),
            );
          }
          await this.#store.saveControl({ ...existing, lastStatus: control.EventStatus.currentStatus });
          continue;
        }

        const intent: ControlIntent = {
          family: 'csip',
          connectionId: this.#connectionId,
          internalEventId: eventId,
          wireMrid: control.mRID,
          programMrid: route.mRID,
          programPrimacy: route.primacy,
          assignedLFDIs: [...route.assignedLFDIs],
          ...(control.replyTo ? { replyTo: control.replyTo } : {}),
          responseRequired: control.responseRequired,
          creationTime: control.creationTime,
          eventStatus: control.EventStatus.currentStatus,
          interval: { ...control.interval },
          control: { ...control.DERControlBase },
        };
        const dispatchable = control.EventStatus.currentStatus === 0 || control.EventStatus.currentStatus === 1;
        if (dispatchable) await queueControlResponse(this.#store, intent, 1, this.#now());
        const stored: StoredControl = {
          internalEventId: eventId,
          materialFingerprint: fingerprint,
          lastStatus: control.EventStatus.currentStatus,
          intent,
          intentDelivered: !dispatchable,
        };
        await this.#store.saveControl(stored);
        if (dispatchable) intents.push(intent);
      }
    }
    for (const existing of await this.#store.listControls()) {
      if (!this.#assignmentRemovalRequiresStandDown(existing, currentAssignments.get(existing.internalEventId))) {
        continue;
      }
      const update: ControlLifecycleUpdate = {
        connectionId: this.#connectionId,
        internalEventId: existing.internalEventId,
        wireMrid: existing.intent.wireMrid,
        assignedLFDIs: [...existing.intent.assignedLFDIs],
        kind: 'cancelled',
      };
      lifecycleUpdates.push(update);
      const effectId = `${update.internalEventId}\0assignment-removed`;
      if (!(await this.#store.loadLifecycleEffect(effectId))) {
        await this.#store.saveLifecycleEffect({ id: effectId, update, sent: false });
      }
      await queueControlResponse(this.#store, existing.intent, 6, this.#now());
      await this.#store.saveControl({ ...existing, lastStatus: 2 });
    }
    return { intents, lifecycleUpdates, pollRates };
  }

  #assignmentRemovalRequiresStandDown(
    existing: StoredControl,
    currentAssignedLFDIs: readonly string[] | undefined,
  ): boolean {
    if (existing.lastStatus !== 0 && existing.lastStatus !== 1) return false;
    const end = existing.intent.interval.start + existing.intent.interval.duration;
    if (this.#now() >= end) return false;
    if (!currentAssignedLFDIs) return true;
    const current = new Set(currentAssignedLFDIs);
    return existing.intent.assignedLFDIs.some((lFDI) => !current.has(lFDI));
  }

  #statusUpdate(existing: StoredControl, status: number): ControlLifecycleUpdate | undefined {
    if (existing.lastStatus === status) return undefined;
    const kind = status === 2 || status === 3 ? 'cancelled' : status === 4 ? 'superseded' : undefined;
    if (!kind) return undefined;
    return {
      connectionId: this.#connectionId,
      internalEventId: existing.internalEventId,
      wireMrid: existing.intent.wireMrid,
      assignedLFDIs: [...existing.intent.assignedLFDIs],
      kind,
    };
  }
}
