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
}

export class ResourceClient {
  readonly #transport: CsipTransport;
  readonly #store: SessionStore;
  readonly #maxPages: number;

  constructor(options: ResourceClientOptions) {
    this.#transport = options.transport;
    this.#store = options.store;
    this.#maxPages = options.maxPages ?? 32;
    if (!Number.isSafeInteger(this.#maxPages) || this.#maxPages <= 0) {
      throw new CsipDiscoveryError('maxPages must be a positive safe integer');
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
    let href: string | undefined = initialHref;
    while (href !== undefined) {
      const canonical = this.canonicalHref(href);
      if (visited.has(canonical)) throw new CsipDiscoveryError(`${label} pagination contains a link cycle at ${canonical}`);
      if (visited.size >= this.#maxPages) throw new CsipDiscoveryError(`${label} exceeded the ${this.#maxPages}-page limit`);
      visited.add(canonical);
      const page: Sep2List<T> = await this.#read(href, parser);
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
      if (page.all !== expectedTotal) {
        throw new CsipDiscoveryError(`${label} all metadata changed between pages`);
      }
      if (page.results !== page.items.length) {
        throw new CsipDiscoveryError(`${label} results metadata does not match its item count`);
      }
      items.push(...page.items);
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
}
