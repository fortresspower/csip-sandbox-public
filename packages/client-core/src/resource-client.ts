import {
  parseDERProgramList,
  parseDERControlList,
  parseDERList,
  parseDeviceCapability,
  parseEndDeviceList,
  parseFunctionSetAssignmentsList,
  parseMirrorUsagePointList,
  serializeEndDevice,
  serializeDERControlResponse,
  serializeDERCapability,
  serializeDERStatus,
  serializeMirrorUsagePoint,
  type Sep2List,
} from '@fortress-csip/protocol';
import { CsipProtocolError, type CsipResponse, type CsipTransport } from './types.js';
import type { SessionStore } from './session-store.js';
import type {
  CsipDer,
  CsipDerCapability,
  CsipDerControl,
  CsipDerControlResponse,
  CsipDerProgram,
  CsipDerStatus,
  CsipDeviceCapability,
  CsipEndDevice,
  CsipFunctionSetAssignments,
  CsipMirrorUsagePoint,
} from './wire-types.js';

type ListParser<T> = (xml: string) => Sep2List<T>;

export interface DiscoveredList<T> {
  items: T[];
  pollRate?: number;
}

export interface EndDeviceFleetSnapshot {
  readonly capabilityHref: string;
  readonly endDeviceListHref: string;
  readonly capability: Readonly<CsipDeviceCapability>;
  readonly endDevices: readonly Readonly<CsipEndDevice>[];
}

const fleetSnapshotOwners = new WeakMap<EndDeviceFleetSnapshot, ResourceClient>();

export class CsipDiscoveryError extends CsipProtocolError {
  constructor(message: string) {
    super(message);
    this.name = 'CsipDiscoveryError';
  }
}

export interface ResourceClientOptions {
  transport: CsipTransport;
  store: SessionStore;
  maxPages?: number;
  maxItems?: number;
  maxPageItems?: number;
  /** Requested IEEE 2030.5 `l` value for an initial list link that omits one. */
  requestedPageItems?: number;
}

export const DEFAULT_MAX_LIST_PAGES = 2_048;
/** Supports 100,000 sites with both standard and extension MirrorUsagePoints. */
export const DEFAULT_MAX_LIST_ITEMS = 200_000;
export const DEFAULT_MAX_PAGE_ITEMS = 500;

export class ResourceClient {
  readonly #transport: CsipTransport;
  readonly #store: SessionStore;
  readonly #maxPages: number;
  readonly #maxItems: number;
  readonly #maxPageItems: number;
  readonly #requestedPageItems: number;

  constructor(options: ResourceClientOptions) {
    this.#transport = options.transport;
    this.#store = options.store;
    this.#maxPages = options.maxPages ?? DEFAULT_MAX_LIST_PAGES;
    this.#maxItems = options.maxItems ?? DEFAULT_MAX_LIST_ITEMS;
    this.#maxPageItems = options.maxPageItems ?? DEFAULT_MAX_PAGE_ITEMS;
    this.#requestedPageItems = options.requestedPageItems ?? DEFAULT_MAX_PAGE_ITEMS;
    if (!Number.isSafeInteger(this.#maxPages) || this.#maxPages <= 0) {
      throw new CsipDiscoveryError('maxPages must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.#maxItems) || this.#maxItems <= 0) {
      throw new CsipDiscoveryError('maxItems must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.#maxPageItems) || this.#maxPageItems <= 0) {
      throw new CsipDiscoveryError('maxPageItems must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.#requestedPageItems) || this.#requestedPageItems <= 0 || this.#requestedPageItems > this.#maxPageItems) {
      throw new CsipDiscoveryError('requestedPageItems must be a positive safe integer no greater than maxPageItems');
    }
  }

  canonicalHref(href: string): string {
    let target: URL;
    try {
      target = new URL(href, this.#transport.origin);
    } catch {
      throw new CsipDiscoveryError(`invalid CSIP resource link: ${href}`);
    }
    if (target.origin !== this.#transport.origin) {
      throw new CsipDiscoveryError(`cross-origin resource link is not allowed: ${target.origin}`);
    }
    if (target.username || target.password) {
      throw new CsipDiscoveryError('resource links must not contain URL credentials');
    }
    return target.href;
  }

  async invalidate(href: string): Promise<void> {
    await this.#store.removeResource(this.canonicalHref(href));
  }

  async deviceCapability(href: string): Promise<CsipDeviceCapability> {
    return this.#read(href, parseDeviceCapability);
  }

  /** Reads one immutable fleet inventory for explicit reuse inside a single caller-owned round. */
  async endDeviceFleet(href: string): Promise<EndDeviceFleetSnapshot> {
    const capabilityHref = this.canonicalHref(href);
    const capability = await this.deviceCapability(capabilityHref);
    if (!capability.EndDeviceListLink) {
      throw new CsipDiscoveryError('DeviceCapability does not provide EndDeviceListLink');
    }
    const endDeviceListHref = this.canonicalHref(capability.EndDeviceListLink);
    const endDevices = await this.endDevices(endDeviceListHref);
    for (const device of endDevices) Object.freeze(device);
    Object.freeze(endDevices);
    Object.freeze(capability);
    const snapshot: EndDeviceFleetSnapshot = Object.freeze({
      capabilityHref,
      endDeviceListHref,
      capability,
      endDevices,
    });
    fleetSnapshotOwners.set(snapshot, this);
    return snapshot;
  }

  /** Validates that a supplied snapshot belongs to this exact client and capability. */
  requireEndDeviceFleet(href: string, snapshot: EndDeviceFleetSnapshot): EndDeviceFleetSnapshot {
    if (fleetSnapshotOwners.get(snapshot) !== this) {
      throw new CsipDiscoveryError('EndDevice fleet snapshot belongs to a different ResourceClient');
    }
    const capabilityHref = this.canonicalHref(href);
    if (snapshot.capabilityHref !== capabilityHref) {
      throw new CsipDiscoveryError('EndDevice fleet snapshot belongs to a different DeviceCapability');
    }
    const advertisedList = snapshot.capability.EndDeviceListLink;
    if (!advertisedList || this.canonicalHref(advertisedList) !== snapshot.endDeviceListHref) {
      throw new CsipDiscoveryError('EndDevice fleet snapshot list binding is invalid');
    }
    return snapshot;
  }

  async endDevices(href: string): Promise<CsipEndDevice[]> {
    return (await this.#walkList(href, parseEndDeviceList, 'EndDeviceList')).items;
  }

  async functionSetAssignments(href: string): Promise<CsipFunctionSetAssignments[]> {
    return (await this.#walkList(href, parseFunctionSetAssignmentsList, 'FunctionSetAssignmentsList')).items;
  }

  async derPrograms(href: string): Promise<CsipDerProgram[]> {
    return (await this.#walkList(href, parseDERProgramList, 'DERProgramList')).items;
  }

  async derControls(href: string): Promise<DiscoveredList<CsipDerControl>> {
    return this.#walkList(href, parseDERControlList, 'DERControlList');
  }

  async mirrorUsagePoints(href: string): Promise<CsipMirrorUsagePoint[]> {
    return (await this.#walkList(href, parseMirrorUsagePointList, 'MirrorUsagePointList')).items;
  }

  async ders(href: string): Promise<CsipDer[]> {
    return (await this.#walkList(href, parseDERList, 'DERList')).items;
  }

  async createEndDevice(listHref: string, lFDI: string): Promise<CsipResponse> {
    return this.#transport.post(listHref, serializeEndDevice({ lFDI }));
  }

  async deleteEndDevice(href: string): Promise<CsipResponse> {
    return this.#transport.request('DELETE', href);
  }

  async postControlResponse(href: string, response: CsipDerControlResponse): Promise<CsipResponse> {
    return this.#transport.post(href, serializeDERControlResponse(response));
  }

  async postMirrorUsagePoint(href: string, usagePoint: CsipMirrorUsagePoint): Promise<CsipResponse> {
    return this.#transport.post(href, serializeMirrorUsagePoint(usagePoint));
  }

  async putDerStatus(href: string, status: CsipDerStatus): Promise<CsipResponse> {
    return this.#transport.put(href, serializeDERStatus(status));
  }

  async putDerCapability(href: string, capability: CsipDerCapability): Promise<CsipResponse> {
    return this.#transport.put(href, serializeDERCapability(capability));
  }

  async #read<T>(href: string, parser: (xml: string) => T): Promise<T> {
    const canonical = this.canonicalHref(href);
    const cached = await this.#store.loadResource(canonical);
    const response = await this.#transport.request('GET', href, {
      ...(cached ? { headers: { 'if-none-match': cached.etag } } : {}),
    });
    let body: string;
    if (response.status === 304) {
      if (!cached) throw new CsipDiscoveryError(`received 304 without a cached representation for ${canonical}`);
      body = cached.body;
    } else {
      body = response.body;
      const etag = response.headers.etag;
      if (etag) await this.#store.saveResource(canonical, { etag, body });
    }
    try {
      return parser(body);
    } catch (error) {
      throw new CsipDiscoveryError(`invalid CSIP resource at ${canonical}: ${String((error as Error).message ?? error)}`);
    }
  }

  async #walkList<T>(initialHref: string, parser: ListParser<T>, label: string): Promise<DiscoveredList<T>> {
    const visited = new Set<string>();
    const items: T[] = [];
    let expectedTotal: number | undefined;
    let pollRate: number | undefined;
    let href: string | undefined = this.#initialListHref(initialHref);
    while (href !== undefined) {
      const canonical = this.canonicalHref(href);
      if (visited.has(canonical)) throw new CsipDiscoveryError(`${label} pagination contains a link cycle at ${canonical}`);
      if (visited.size >= this.#maxPages) throw new CsipDiscoveryError(`${label} exceeded the ${this.#maxPages}-page limit`);
      visited.add(canonical);
      const page: Sep2List<T> = await this.#read(href, parser);
      if (page.items.length > this.#maxPageItems) {
        throw new CsipDiscoveryError(`${label} page exceeded the ${this.#maxPageItems}-item limit`);
      }
      if (page.pollRate !== undefined) {
        if (!Number.isSafeInteger(page.pollRate) || page.pollRate <= 0) {
          throw new CsipDiscoveryError(`${label} pollRate must be a positive safe integer`);
        }
        if (pollRate !== undefined && pollRate !== page.pollRate) {
          throw new CsipDiscoveryError(`${label} pollRate changed between pages`);
        }
        pollRate = page.pollRate;
      }
      expectedTotal ??= page.all;
      if (page.all > this.#maxItems) {
        throw new CsipDiscoveryError(`${label} exceeded the ${this.#maxItems}-item limit`);
      }
      if (page.all !== expectedTotal) {
        throw new CsipDiscoveryError(`${label} all metadata changed between pages`);
      }
      if (page.results !== page.items.length) {
        throw new CsipDiscoveryError(`${label} results metadata does not match its item count`);
      }
      items.push(...page.items);
      if (items.length > this.#maxItems) {
        throw new CsipDiscoveryError(`${label} exceeded the ${this.#maxItems}-item limit`);
      }
      if (items.length > page.all) {
        throw new CsipDiscoveryError(`${label} returned more items than its all metadata`);
      }
      href = page.nextHref;
    }
    if (expectedTotal !== undefined && items.length !== expectedTotal) {
      throw new CsipDiscoveryError(`${label} ended after ${items.length} of ${expectedTotal} advertised items`);
    }
    return { items, ...(pollRate !== undefined ? { pollRate } : {}) };
  }

  #initialListHref(href: string): string {
    const target = new URL(this.canonicalHref(href));
    if (!target.searchParams.has('l')) target.searchParams.set('l', String(this.#requestedPageItems));
    return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)
      ? target.href
      : `${target.pathname}${target.search}${target.hash}`;
  }
}
