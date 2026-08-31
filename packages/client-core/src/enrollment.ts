import { CsipProtocolError } from './types.js';
import { CsipDiscoveryError, ResourceClient, type EndDeviceFleetSnapshot } from './resource-client.js';
import { isCanonicalLfdi } from './identity.js';
import type { SessionStore, StoredEndDevice } from './session-store.js';
import {
  DEFAULT_WORK_CONCURRENCY,
  mapConcurrent,
  throwIfAborted,
  validateWorkConcurrency,
  type CsipWorkOptions,
} from './concurrency.js';

export interface EndDeviceEnrollmentOptions {
  resources: ResourceClient;
  store: SessionStore;
  /** Maximum simultaneous registration/store operations. Hard-capped at eight. */
  concurrency?: number;
}

export interface EndDeviceFleetReconcileOptions extends CsipWorkOptions {
  snapshot?: EndDeviceFleetSnapshot;
}

export interface EndDeviceFleetReconciliation {
  readonly devices: StoredEndDevice[];
  readonly snapshot: EndDeviceFleetSnapshot;
  readonly inventoryChanged: boolean;
}

export class EndDeviceEnrollment {
  readonly #resources: ResourceClient;
  readonly #store: SessionStore;
  readonly #concurrency: number;
  readonly #inFlight = new Map<string, Promise<StoredEndDevice>>();

  constructor(options: EndDeviceEnrollmentOptions) {
    this.#resources = options.resources;
    this.#store = options.store;
    try {
      this.#concurrency = validateWorkConcurrency(options.concurrency ?? DEFAULT_WORK_CONCURRENCY);
    } catch (error) {
      throw new CsipDiscoveryError((error as Error).message);
    }
  }

  reconcile(deviceCapabilityHref: string, lFDI: string): Promise<StoredEndDevice> {
    if (!isCanonicalLfdi(lFDI)) {
      return Promise.reject(new CsipDiscoveryError('EndDevice LFDI must be 40 lowercase hexadecimal characters'));
    }
    let capabilityKey: string;
    try {
      capabilityKey = this.#resources.canonicalHref(deviceCapabilityHref);
    } catch (error) {
      return Promise.reject(error);
    }
    const key = `${capabilityKey}\0${lFDI}`;
    const existing = this.#inFlight.get(key);
    if (existing) return existing;
    const pending = this.#reconcileMany(deviceCapabilityHref, [lFDI])
      .then(({ devices }) => devices[0])
      .finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, pending);
    return pending;
  }

  /**
   * Reconciles a complete fleet with one EndDeviceList walk. Missing registrations are
   * created with bounded concurrency; conflicts trigger at most one shared recovery walk.
   */
  reconcileMany(
    deviceCapabilityHref: string,
    lFDIs: Iterable<string>,
    options: CsipWorkOptions = {},
  ): Promise<StoredEndDevice[]> {
    let capabilityKey: string;
    try {
      capabilityKey = this.#resources.canonicalHref(deviceCapabilityHref);
      void capabilityKey;
    } catch (error) {
      return Promise.reject(error);
    }
    const targets = [...lFDIs];
    const seen = new Set<string>();
    for (const lFDI of targets) {
      if (!isCanonicalLfdi(lFDI)) {
        return Promise.reject(new CsipDiscoveryError('EndDevice LFDI must be 40 lowercase hexadecimal characters'));
      }
      if (seen.has(lFDI)) {
        return Promise.reject(new CsipDiscoveryError(`EndDevice reconciliation contains duplicate LFDI ${lFDI}`));
      }
      seen.add(lFDI);
    }
    return this.#reconcileMany(deviceCapabilityHref, targets, options).then(({ devices }) => devices);
  }

  /** Reconciles against an explicit per-round snapshot and returns the authoritative post-write inventory. */
  async reconcileFleet(
    deviceCapabilityHref: string,
    lFDIs: Iterable<string>,
    options: EndDeviceFleetReconcileOptions = {},
  ): Promise<EndDeviceFleetReconciliation> {
    const targets = this.#validateTargets(lFDIs);
    const snapshot = options.snapshot
      ? this.#resources.requireEndDeviceFleet(deviceCapabilityHref, options.snapshot)
      : await this.#resources.endDeviceFleet(deviceCapabilityHref);
    const result = await this.#reconcileMany(deviceCapabilityHref, targets, options, snapshot);
    if (!result.inventoryChanged) return { ...result, snapshot };
    const refreshed = await this.#resources.endDeviceFleet(deviceCapabilityHref);
    const visible = new Set(refreshed.endDevices.map((device) => device.lFDI));
    for (const lFDI of targets) {
      if (!visible.has(lFDI)) {
        throw new CsipDiscoveryError(`refreshed EndDevice fleet does not contain reconciled LFDI ${lFDI}`);
      }
    }
    return { ...result, snapshot: refreshed };
  }

  async remove(lFDI: string): Promise<void> {
    const stored = await this.#store.loadEndDevice(lFDI);
    if (!stored) return;
    await this.#store.saveEndDevice({ ...stored, eligible: false });
    try {
      await this.#resources.deleteEndDevice(stored.href);
    } catch (error) {
      if (!(error instanceof CsipProtocolError) || error.status !== 404) throw error;
    }
    await this.#store.removeEndDevice(lFDI);
  }

  async #reconcileMany(
    deviceCapabilityHref: string,
    lFDIs: readonly string[],
    options: CsipWorkOptions = {},
    snapshot?: EndDeviceFleetSnapshot,
  ): Promise<{ devices: StoredEndDevice[]; inventoryChanged: boolean }> {
    throwIfAborted(options.signal);
    const deviceListHref = snapshot?.endDeviceListHref ?? await this.#deviceListHref(deviceCapabilityHref);
    const indexed = this.#index(snapshot?.endDevices ?? await this.#resources.endDevices(deviceListHref));
    const hrefs = new Map<string, string>();
    const missing: string[] = [];
    for (const lFDI of lFDIs) {
      const existing = indexed.get(lFDI);
      if (existing?.href) hrefs.set(lFDI, existing.href);
      else if (existing) throw new CsipDiscoveryError(`EndDevice ${lFDI} does not expose a resource href`);
      else missing.push(lFDI);
    }

    const conflicts: string[] = [];
    await mapConcurrent(missing, this.#concurrency, async (lFDI) => {
      try {
        const response = await this.#resources.createEndDevice(deviceListHref, lFDI);
        if (response.status !== 200 && response.status !== 201) {
          throw new CsipDiscoveryError(`EndDevice registration returned unexpected status ${response.status}`);
        }
        const location = response.headers.location;
        if (!location) throw new CsipDiscoveryError('EndDevice registration response did not include Location');
        this.#resources.canonicalHref(location);
        hrefs.set(lFDI, location);
      } catch (error) {
        if (!(error instanceof CsipProtocolError) || error.status !== 409) throw error;
        conflicts.push(lFDI);
      }
    }, options.signal);
    if (missing.length > 0) await this.#resources.invalidate(deviceListHref);
    if (conflicts.length > 0) {
      await this.#resources.invalidate(deviceListHref);
      const recovered = this.#index(await this.#resources.endDevices(deviceListHref));
      for (const lFDI of conflicts) {
        const winner = recovered.get(lFDI);
        if (!winner) throw new CsipDiscoveryError('EndDevice registration conflicted but no matching device appeared');
        if (!winner.href) throw new CsipDiscoveryError(`EndDevice ${lFDI} does not expose a resource href`);
        hrefs.set(lFDI, winner.href);
      }
    }
    const devices = await mapConcurrent(lFDIs, this.#concurrency, (lFDI) => this.#persist(lFDI, hrefs.get(lFDI)), options.signal);
    return { devices, inventoryChanged: missing.length > 0 };
  }

  async #deviceListHref(deviceCapabilityHref: string): Promise<string> {
    const capability = await this.#resources.deviceCapability(deviceCapabilityHref);
    if (!capability.EndDeviceListLink) {
      throw new CsipDiscoveryError('DeviceCapability does not provide EndDeviceListLink');
    }
    return capability.EndDeviceListLink;
  }

  #index(devices: readonly { readonly lFDI: string; readonly href?: string }[]): Map<string, { href?: string }> {
    const indexed = new Map<string, { href?: string }>();
    for (const device of devices) {
      if (indexed.has(device.lFDI)) throw new CsipDiscoveryError(`EndDeviceList contains duplicate LFDI ${device.lFDI}`);
      indexed.set(device.lFDI, device);
    }
    return indexed;
  }

  #validateTargets(lFDIs: Iterable<string>): string[] {
    const targets = [...lFDIs];
    const seen = new Set<string>();
    for (const lFDI of targets) {
      if (!isCanonicalLfdi(lFDI)) throw new CsipDiscoveryError('EndDevice LFDI must be 40 lowercase hexadecimal characters');
      if (seen.has(lFDI)) throw new CsipDiscoveryError(`EndDevice reconciliation contains duplicate LFDI ${lFDI}`);
      seen.add(lFDI);
    }
    return targets;
  }

  async #persist(lFDI: string, href: string | undefined): Promise<StoredEndDevice> {
    if (!href) throw new CsipDiscoveryError(`EndDevice ${lFDI} does not expose a resource href`);
    this.#resources.canonicalHref(href);
    const stored = { lFDI, href, eligible: true };
    await this.#store.saveEndDevice(stored);
    return stored;
  }
}
