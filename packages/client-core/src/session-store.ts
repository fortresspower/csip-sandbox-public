import type { ControlIntent, ControlLifecycleUpdate } from './controls.js';
import type { CsipDerControlResponse } from './wire-types.js';

export interface StoredEndDevice {
  lFDI: string;
  href: string;
  eligible: boolean;
}

export interface AssignedProgram {
  mRID: string;
  href?: string;
  primacy: number;
  controlListHref: string;
  functionSetAssignmentMrid?: string;
  functionSetAssignmentHref?: string;
}

export interface DeviceAssignment {
  lFDI: string;
  href?: string;
  programs: AssignedProgram[];
}

export interface AssignmentSnapshot {
  valid: boolean;
  devices: DeviceAssignment[];
  error?: string;
}

export interface CachedResource {
  etag: string;
  body: string;
}

export interface StoredControl {
  internalEventId: string;
  materialFingerprint: string;
  lastStatus: number;
  intent: ControlIntent;
  intentDelivered: boolean;
}

export interface StoredResponseEffect {
  id: string;
  internalEventId: string;
  href: string;
  response: CsipDerControlResponse;
  sent: boolean;
}

export interface StoredLifecycleEffect {
  id: string;
  update: ControlLifecycleUpdate;
  sent: boolean;
}

export interface SessionStore {
  loadEndDevice(lFDI: string): Promise<StoredEndDevice | undefined>;
  saveEndDevice(device: StoredEndDevice): Promise<void>;
  removeEndDevice(lFDI: string): Promise<void>;
  loadResource(href: string): Promise<CachedResource | undefined>;
  saveResource(href: string, resource: CachedResource): Promise<void>;
  removeResource(href: string): Promise<void>;
  loadAssignmentSnapshot(): Promise<AssignmentSnapshot | undefined>;
  saveAssignmentSnapshot(snapshot: AssignmentSnapshot): Promise<void>;
  loadControl(internalEventId: string): Promise<StoredControl | undefined>;
  saveControl(control: StoredControl): Promise<void>;
  listControls(): Promise<StoredControl[]>;
  listPendingControls(): Promise<StoredControl[]>;
  loadResponseEffect(id: string): Promise<StoredResponseEffect | undefined>;
  saveResponseEffect(effect: StoredResponseEffect): Promise<void>;
  listPendingResponses(): Promise<StoredResponseEffect[]>;
  loadLifecycleEffect(id: string): Promise<StoredLifecycleEffect | undefined>;
  saveLifecycleEffect(effect: StoredLifecycleEffect): Promise<void>;
  listPendingLifecycleEffects(): Promise<StoredLifecycleEffect[]>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class MemorySessionStore implements SessionStore {
  readonly #devices = new Map<string, StoredEndDevice>();
  readonly #resources = new Map<string, CachedResource>();
  readonly #controls = new Map<string, StoredControl>();
  readonly #responses = new Map<string, StoredResponseEffect>();
  readonly #lifecycle = new Map<string, StoredLifecycleEffect>();
  #snapshot?: AssignmentSnapshot;

  async loadEndDevice(lFDI: string): Promise<StoredEndDevice | undefined> {
    const device = this.#devices.get(lFDI);
    return device ? copy(device) : undefined;
  }

  async saveEndDevice(device: StoredEndDevice): Promise<void> {
    this.#devices.set(device.lFDI, copy(device));
  }

  async removeEndDevice(lFDI: string): Promise<void> {
    this.#devices.delete(lFDI);
  }

  async loadResource(href: string): Promise<CachedResource | undefined> {
    const resource = this.#resources.get(href);
    return resource ? copy(resource) : undefined;
  }

  async saveResource(href: string, resource: CachedResource): Promise<void> {
    this.#resources.set(href, copy(resource));
  }

  async removeResource(href: string): Promise<void> {
    this.#resources.delete(href);
  }

  async loadAssignmentSnapshot(): Promise<AssignmentSnapshot | undefined> {
    return this.#snapshot ? copy(this.#snapshot) : undefined;
  }

  async saveAssignmentSnapshot(snapshot: AssignmentSnapshot): Promise<void> {
    this.#snapshot = copy(snapshot);
  }

  async loadControl(internalEventId: string): Promise<StoredControl | undefined> {
    const control = this.#controls.get(internalEventId);
    return control ? copy(control) : undefined;
  }

  async saveControl(control: StoredControl): Promise<void> {
    this.#controls.set(control.internalEventId, copy(control));
  }

  async listControls(): Promise<StoredControl[]> {
    return [...this.#controls.values()].map(copy);
  }

  async listPendingControls(): Promise<StoredControl[]> {
    return [...this.#controls.values()]
      .filter((control) => !control.intentDelivered)
      .map(copy);
  }

  async loadResponseEffect(id: string): Promise<StoredResponseEffect | undefined> {
    const effect = this.#responses.get(id);
    return effect ? copy(effect) : undefined;
  }

  async saveResponseEffect(effect: StoredResponseEffect): Promise<void> {
    this.#responses.set(effect.id, copy(effect));
  }

  async listPendingResponses(): Promise<StoredResponseEffect[]> {
    return [...this.#responses.values()]
      .filter((effect) => !effect.sent)
      .map(copy);
  }

  async loadLifecycleEffect(id: string): Promise<StoredLifecycleEffect | undefined> {
    const effect = this.#lifecycle.get(id);
    return effect ? copy(effect) : undefined;
  }

  async saveLifecycleEffect(effect: StoredLifecycleEffect): Promise<void> {
    this.#lifecycle.set(effect.id, copy(effect));
  }

  async listPendingLifecycleEffects(): Promise<StoredLifecycleEffect[]> {
    return [...this.#lifecycle.values()]
      .filter((effect) => !effect.sent)
      .map(copy);
  }
}
