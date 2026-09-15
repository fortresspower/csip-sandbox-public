import {
  controlAdmissionState,
  type AssignmentSnapshot,
  type CachedResource,
  type SessionStore,
  type StoredControl,
  type StoredEndDevice,
  type StoredLifecycleEffect,
  type StoredResponseEffect,
} from '@fortress-csip/client-core';

/**
 * A `SessionStore` whose state can be written to disk and read back.
 *
 * The harness needs this for two checks that cannot be made any other way: that restarting
 * does not deliver the same control twice, and that a response still owed at restart is
 * eventually sent. Both are properties of durable client state, so proving them requires
 * client state that actually survives a restart.
 *
 * This is test-harness storage, not a recommendation for how a partner should persist
 * anything. The resource cache is deliberately *not* serialized: it holds raw response
 * bodies, and an evidence session file that a partner may attach to a ticket has no business
 * carrying server payloads. Dropping it only costs a re-fetch on resume.
 */

interface SerializedSessionState {
  devices: StoredEndDevice[];
  responses: StoredResponseEffect[];
  lifecycle: StoredLifecycleEffect[];
  snapshot?: AssignmentSnapshot;
}

export interface SerializedSession extends SerializedSessionState {
  version: 2;
  controls: StoredControl[];
}

type LegacyStoredControl = Omit<StoredControl, 'admissionState'> & { intentDelivered: boolean };

export interface LegacySerializedSession extends SerializedSessionState {
  version: 1;
  controls: LegacyStoredControl[];
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class SerializableSessionStore implements SessionStore {
  readonly #devices = new Map<string, StoredEndDevice>();
  readonly #resources = new Map<string, CachedResource>();
  readonly #controls = new Map<string, StoredControl>();
  readonly #responses = new Map<string, StoredResponseEffect>();
  readonly #lifecycle = new Map<string, StoredLifecycleEffect>();
  #snapshot?: AssignmentSnapshot;

  static from(
    serialized: SerializedSession | LegacySerializedSession | undefined,
  ): SerializableSessionStore {
    const store = new SerializableSessionStore();
    if (serialized === undefined) return store;
    for (const device of serialized.devices) store.#devices.set(device.lFDI, device);
    if (serialized.version === 1) {
      for (const control of serialized.controls) {
        const current: StoredControl = {
          internalEventId: control.internalEventId,
          materialFingerprint: control.materialFingerprint,
          lastStatus: control.lastStatus,
          intent: control.intent,
          admissionState: control.intentDelivered ? 'accepted' : 'uncertain',
        };
        store.#controls.set(current.internalEventId, current);
      }
    } else {
      for (const control of serialized.controls) store.#controls.set(control.internalEventId, control);
    }
    const legacyPendingControls = new Set(
      serialized.version === 1
        ? serialized.controls
          .filter((control) => !control.intentDelivered)
          .map((control) => control.internalEventId)
        : [],
    );
    for (const response of serialized.responses) {
      // Version 1 queued status 1 before dispatch. A pending control therefore cannot prove
      // acceptance, so discard that unsent effect and retry admission with the stable mRID.
      const unprovenLegacyAcceptance = serialized.version === 1
        && !response.sent
        && response.response.status === 1
        && legacyPendingControls.has(response.internalEventId);
      if (!unprovenLegacyAcceptance) store.#responses.set(response.id, response);
    }
    for (const effect of serialized.lifecycle) store.#lifecycle.set(effect.id, effect);
    store.#snapshot = serialized.snapshot;
    return store;
  }

  serialize(): SerializedSession {
    return copy({
      version: 2 as const,
      devices: [...this.#devices.values()],
      controls: [...this.#controls.values()],
      responses: [...this.#responses.values()],
      lifecycle: [...this.#lifecycle.values()],
      ...(this.#snapshot === undefined ? {} : { snapshot: this.#snapshot }),
    });
  }

  async loadEndDevice(lFDI: string): Promise<StoredEndDevice | undefined> {
    const device = this.#devices.get(lFDI);
    return device === undefined ? undefined : copy(device);
  }

  async saveEndDevice(device: StoredEndDevice): Promise<void> {
    this.#devices.set(device.lFDI, copy(device));
  }

  async saveEndDevices(devices: readonly StoredEndDevice[]): Promise<void> {
    for (const device of devices) this.#devices.set(device.lFDI, copy(device));
  }

  async removeEndDevice(lFDI: string): Promise<void> {
    this.#devices.delete(lFDI);
  }

  async loadResource(href: string): Promise<CachedResource | undefined> {
    const resource = this.#resources.get(href);
    return resource === undefined ? undefined : copy(resource);
  }

  async saveResource(href: string, resource: CachedResource): Promise<void> {
    this.#resources.set(href, copy(resource));
  }

  async removeResource(href: string): Promise<void> {
    this.#resources.delete(href);
  }

  async loadAssignmentSnapshot(): Promise<AssignmentSnapshot | undefined> {
    return this.#snapshot === undefined ? undefined : copy(this.#snapshot);
  }

  async saveAssignmentSnapshot(snapshot: AssignmentSnapshot): Promise<void> {
    this.#snapshot = copy(snapshot);
  }

  async loadControl(internalEventId: string): Promise<StoredControl | undefined> {
    const control = this.#controls.get(internalEventId);
    return control === undefined ? undefined : copy(control);
  }

  async saveControl(control: StoredControl): Promise<void> {
    this.#controls.set(control.internalEventId, copy(control));
  }

  async completeControlAdmission(
    control: StoredControl,
    responseEffects: readonly StoredResponseEffect[],
    lifecycleEffects: readonly StoredLifecycleEffect[] = [],
  ): Promise<void> {
    this.#controls.set(control.internalEventId, copy(control));
    for (const effect of responseEffects) {
      if (!this.#responses.has(effect.id)) this.#responses.set(effect.id, copy(effect));
    }
    for (const effect of lifecycleEffects) {
      if (!this.#lifecycle.has(effect.id)) this.#lifecycle.set(effect.id, copy(effect));
    }
  }

  async listControls(): Promise<StoredControl[]> {
    return [...this.#controls.values()].map(copy);
  }

  async listPendingControls(): Promise<StoredControl[]> {
    return [...this.#controls.values()].filter((control) => {
      const state = controlAdmissionState(control);
      return state === 'pending' || state === 'uncertain';
    }).map(copy);
  }

  async loadResponseEffect(id: string): Promise<StoredResponseEffect | undefined> {
    const effect = this.#responses.get(id);
    return effect === undefined ? undefined : copy(effect);
  }

  async saveResponseEffect(effect: StoredResponseEffect): Promise<void> {
    this.#responses.set(effect.id, copy(effect));
  }

  async listPendingResponses(): Promise<StoredResponseEffect[]> {
    return [...this.#responses.values()].filter((effect) => !effect.sent).map(copy);
  }

  async loadLifecycleEffect(id: string): Promise<StoredLifecycleEffect | undefined> {
    const effect = this.#lifecycle.get(id);
    return effect === undefined ? undefined : copy(effect);
  }

  async saveLifecycleEffect(effect: StoredLifecycleEffect): Promise<void> {
    this.#lifecycle.set(effect.id, copy(effect));
  }

  async listPendingLifecycleEffects(): Promise<StoredLifecycleEffect[]> {
    return [...this.#lifecycle.values()].filter((effect) => !effect.sent).map(copy);
  }
}
