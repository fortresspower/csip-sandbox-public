import type {
  ConnectionIdentityRecord,
  ConnectionRecord,
  PartnerPersistence,
  PartnerRecord,
  PutOptions,
  RecordType,
} from './port.js';

export interface MemoryPersistenceState {
  records: Map<string, PartnerRecord>;
  identityClaims: Map<string, string>;
}

export function createMemoryPersistenceState(): MemoryPersistenceState {
  return { records: new Map(), identityClaims: new Map() };
}

export class MemoryPartnerPersistence implements PartnerPersistence {
  readonly #state: MemoryPersistenceState;
  readonly #now: () => number;

  constructor(options: { state?: MemoryPersistenceState; now?: () => number } = {}) {
    this.#state = options.state ?? createMemoryPersistenceState();
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  async get<T extends PartnerRecord>(connectionId: string, recordType: T['recordType'], id: string): Promise<T | undefined> {
    const record = this.#state.records.get(key(connectionId, recordType, id));
    if (!record || this.#expired(record)) return undefined;
    return structuredClone(record) as T;
  }

  async list<T extends PartnerRecord>(connectionId: string, recordType: T['recordType']): Promise<T[]> {
    return [...this.#state.records.values()]
      .filter((record) => record.connectionId === connectionId && record.recordType === recordType && !this.#expired(record))
      .map((record) => structuredClone(record) as T)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async put(record: PartnerRecord, options: PutOptions = {}): Promise<boolean> {
    const recordKey = key(record.connectionId, record.recordType, record.id);
    const existing = this.#state.records.get(recordKey);
    if (options.ifAbsent && existing && !this.#expired(existing)) return false;
    this.#state.records.set(recordKey, structuredClone(record));
    return true;
  }

  async delete(connectionId: string, recordType: RecordType, id: string): Promise<void> {
    this.#state.records.delete(key(connectionId, recordType, id));
  }

  async createConnectionWithIdentity(
    connection: ConnectionRecord,
    identity: ConnectionIdentityRecord,
  ): Promise<boolean> {
    const connectionKey = key(connection.connectionId, 'connection', connection.connectionId);
    if (this.#state.records.has(connectionKey) || this.#state.identityClaims.has(identity.aggregatorLfdi)) return false;
    this.#state.records.set(connectionKey, structuredClone(connection));
    this.#state.records.set(key(identity.connectionId, 'connection-identity', identity.id), structuredClone(identity));
    this.#state.identityClaims.set(identity.aggregatorLfdi, identity.connectionId);
    return true;
  }

  async authorizeConnectionIdentity(identity: ConnectionIdentityRecord): Promise<boolean> {
    const owner = this.#state.identityClaims.get(identity.aggregatorLfdi);
    if (owner !== undefined && owner !== identity.connectionId) return false;
    this.#state.identityClaims.set(identity.aggregatorLfdi, identity.connectionId);
    this.#state.records.set(key(identity.connectionId, 'connection-identity', identity.id), structuredClone(identity));
    return true;
  }

  async revokeConnectionIdentity(connectionId: string, aggregatorLfdi: string): Promise<void> {
    const owner = this.#state.identityClaims.get(aggregatorLfdi);
    if (owner !== undefined && owner !== connectionId) throw new Error('aggregator LFDI belongs to another connection');
    this.#state.records.delete(key(connectionId, 'connection-identity', aggregatorLfdi));
    this.#state.identityClaims.delete(aggregatorLfdi);
  }

  async findConnectionByAggregatorLfdi(aggregatorLfdi: string): Promise<ConnectionRecord | undefined> {
    const connectionId = this.#state.identityClaims.get(aggregatorLfdi);
    return connectionId ? this.get(connectionId, 'connection', connectionId) : undefined;
  }

  #expired(record: PartnerRecord): boolean {
    if (record.expiresAt === undefined || record.expiresAt > this.#now()) return false;
    this.#state.records.delete(key(record.connectionId, record.recordType, record.id));
    return true;
  }
}

function key(connectionId: string, recordType: RecordType, id: string): string {
  return `${connectionId}\0${recordType}\0${id}`;
}
