export type RecordType =
  | 'connection'
  | 'connection-identity'
  | 'device'
  | 'assignment'
  | 'program'
  | 'control'
  | 'response'
  | 'telemetry'
  | 'evidence'
  | 'command';

export interface PersistedRecord {
  connectionId: string;
  recordType: RecordType;
  id: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

export interface ConnectionRecord extends PersistedRecord {
  recordType: 'connection';
  aggregatorLfdi: string;
}

export interface ConnectionIdentityRecord extends PersistedRecord {
  recordType: 'connection-identity';
  aggregatorLfdi: string;
}

export interface DeviceRecord extends PersistedRecord {
  recordType: 'device';
  lFDI: string;
  token: string;
  assignedProgramIds: string[];
}

export interface AssignmentRecord extends PersistedRecord {
  recordType: 'assignment';
  programId: string;
  targetLfdi: string;
}

export interface ProgramRecord extends PersistedRecord {
  recordType: 'program';
  mRID: string;
  token: string;
  primacy: number;
  /** Event-scoped programs are created for a single control and expire with it. */
  eventScoped?: boolean;
}

export interface ControlRecord extends PersistedRecord {
  recordType: 'control';
  programId: string;
  mRID: string;
  creationTime: number;
  start: number;
  duration: number;
  currentStatus: number;
  responseRequired: string;
  opModConnect?: boolean;
  opModMaxLimW?: number;
  opModFixedW?: number;
  completedAt?: number;
}

export interface ExchangeRecord extends PersistedRecord {
  recordType: 'response' | 'telemetry' | 'evidence';
  deviceLfdi?: string;
  subject?: string;
  category: string;
  xml?: string;
  details?: Record<string, unknown>;
}

/** The durable outcome of one operator command, replayed verbatim for an identical retry. */
export interface EventCommandResult {
  action: 'publish' | 'cancel';
  connectionId: string;
  requestId: string;
  eventId: string;
  programId: string;
  mRID: string;
  targetLfdi: string;
  start: number;
  duration: number;
  opModFixedW: number;
  currentStatus: number;
  idempotent: boolean;
}

export interface CommandRecord extends PersistedRecord {
  recordType: 'command';
  action: 'publish' | 'cancel';
  requestId: string;
  requestHash: string;
  eventId: string;
  result: EventCommandResult;
}

export type PartnerRecord =
  | ConnectionRecord
  | ConnectionIdentityRecord
  | DeviceRecord
  | AssignmentRecord
  | ProgramRecord
  | ControlRecord
  | ExchangeRecord
  | CommandRecord;

export interface PutOptions {
  ifAbsent?: boolean;
}

export interface PartnerPersistence {
  get<T extends PartnerRecord>(connectionId: string, recordType: T['recordType'], id: string): Promise<T | undefined>;
  list<T extends PartnerRecord>(connectionId: string, recordType: T['recordType']): Promise<T[]>;
  put(record: PartnerRecord, options?: PutOptions): Promise<boolean>;
  delete(connectionId: string, recordType: RecordType, id: string): Promise<void>;
  createConnectionWithIdentity(connection: ConnectionRecord, identity: ConnectionIdentityRecord): Promise<boolean>;
  authorizeConnectionIdentity(identity: ConnectionIdentityRecord): Promise<boolean>;
  revokeConnectionIdentity(connectionId: string, aggregatorLfdi: string): Promise<void>;
  findConnectionByAggregatorLfdi(aggregatorLfdi: string): Promise<ConnectionRecord | undefined>;
}

export interface RetentionPolicy {
  historySeconds: number;
  /** How long a program and assignment may sit prepared before an unpublished control abandons them. */
  preparationSeconds?: number;
}

export const DEFAULT_PREPARATION_SECONDS = 15 * 60;

export const DEFAULT_RETENTION: RetentionPolicy = {
  historySeconds: 30 * 24 * 60 * 60,
  preparationSeconds: DEFAULT_PREPARATION_SECONDS,
};
