import { CsipProtocolError } from './types.js';
import { CsipDiscoveryError, ResourceClient } from './resource-client.js';
import { isCanonicalLfdi } from './identity.js';
import type { SessionStore, StoredEndDevice } from './session-store.js';

export interface EndDeviceEnrollmentOptions {
  resources: ResourceClient;
  store: SessionStore;
}

export class EndDeviceEnrollment {
  readonly #resources: ResourceClient;
  readonly #store: SessionStore;
  readonly #inFlight = new Map<string, Promise<StoredEndDevice>>();

  constructor(options: EndDeviceEnrollmentOptions) {
    this.#resources = options.resources;
    this.#store = options.store;
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
    const pending = this.#reconcile(deviceCapabilityHref, lFDI)
      .finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, pending);
    return pending;
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

  async #reconcile(deviceCapabilityHref: string, lFDI: string): Promise<StoredEndDevice> {
    const deviceListHref = await this.#deviceListHref(deviceCapabilityHref);
    const existing = await this.#findUnique(deviceListHref, lFDI);
    if (existing) return this.#persist(lFDI, existing.href);

    try {
      const response = await this.#resources.createEndDevice(deviceListHref, lFDI);
      if (response.status !== 200 && response.status !== 201) {
        throw new CsipDiscoveryError(`EndDevice registration returned unexpected status ${response.status}`);
      }
      const location = response.headers.location;
      if (!location) throw new CsipDiscoveryError('EndDevice registration response did not include Location');
      this.#resources.canonicalHref(location);
      await this.#resources.invalidate(deviceListHref);
      return this.#persist(lFDI, location);
    } catch (error) {
      if (!(error instanceof CsipProtocolError) || error.status !== 409) throw error;
      await this.#resources.invalidate(deviceListHref);
      const winner = await this.#findUnique(deviceListHref, lFDI);
      if (!winner) throw new CsipDiscoveryError('EndDevice registration conflicted but no matching device appeared');
      return this.#persist(lFDI, winner.href);
    }
  }

  async #deviceListHref(deviceCapabilityHref: string): Promise<string> {
    const capability = await this.#resources.deviceCapability(deviceCapabilityHref);
    if (!capability.EndDeviceListLink) {
      throw new CsipDiscoveryError('DeviceCapability does not provide EndDeviceListLink');
    }
    return capability.EndDeviceListLink;
  }

  async #findUnique(listHref: string, lFDI: string): Promise<{ href?: string } | undefined> {
    const matches = (await this.#resources.endDevices(listHref)).filter((device) => device.lFDI === lFDI);
    if (matches.length > 1) throw new CsipDiscoveryError(`EndDeviceList contains duplicate LFDI ${lFDI}`);
    return matches[0];
  }

  async #persist(lFDI: string, href: string | undefined): Promise<StoredEndDevice> {
    if (!href) throw new CsipDiscoveryError(`EndDevice ${lFDI} does not expose a resource href`);
    this.#resources.canonicalHref(href);
    const stored = { lFDI, href, eligible: true };
    await this.#store.saveEndDevice(stored);
    return stored;
  }
}
