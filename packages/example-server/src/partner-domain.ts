import { createHash, randomUUID } from 'node:crypto';
import type {
  AssignmentRecord,
  CommandRecord,
  EventCommandResult,
  ConnectionIdentityRecord,
  ConnectionRecord,
  ControlRecord,
  DeviceRecord,
  ExchangeRecord,
  PartnerPersistence,
  ProgramRecord,
  RetentionPolicy,
} from './persistence/port.js';
import { DEFAULT_PREPARATION_SECONDS, DEFAULT_RETENTION as DEFAULT_RETENTION_VALUE } from './persistence/port.js';

/** IEEE 2030.5 EventStatus.currentStatus values this profile publishes or accepts. */
export const CONTROL_STATUS = {
  scheduled: 0,
  active: 1,
  cancelled: 2,
  cancelledWithRandomization: 3,
  superseded: 4,
} as const;

const TERMINAL_STATUSES: ReadonlySet<number> = new Set([
  CONTROL_STATUS.cancelled,
  CONTROL_STATUS.cancelledWithRandomization,
  CONTROL_STATUS.superseded,
]);

/** An event-scoped program and its control share one identity derived from the requester's event. */
export function eventProgramId(eventId: string): string {
  return `evt-${eventId}`;
}

export function eventControlMrid(eventId: string): string {
  return `evt-${eventId}`;
}

export interface PublishControlInput {
  connectionId: string;
  programId: string;
  mRID: string;
  start: number;
  duration: number;
  responseRequired?: string;
  opModFixedW: number;
}

export interface PublishEventCommandInput {
  connectionId: string;
  requestId: string;
  eventId: string;
  targetLfdi: string;
  start: number;
  duration: number;
  opModFixedW: number;
}

export interface CancelEventCommandInput {
  connectionId: string;
  requestId: string;
  eventId: string;
}

export type RecordExchangeInput = Omit<ExchangeRecord, 'id' | 'createdAt' | 'updatedAt' | 'expiresAt'> & {
  id?: string;
};

export class PartnerDomain {
  readonly #persistence: PartnerPersistence;
  readonly #now: () => number;
  readonly #retention: RetentionPolicy;
  readonly #preparationSeconds: number;

  constructor(options: { persistence: PartnerPersistence; now?: () => number; retention?: RetentionPolicy }) {
    this.#persistence = options.persistence;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.#retention = options.retention ?? DEFAULT_RETENTION_VALUE;
    if (!Number.isSafeInteger(this.#retention.historySeconds) || this.#retention.historySeconds <= 0) {
      throw new Error('history retention must be a positive safe integer');
    }
    this.#preparationSeconds = this.#retention.preparationSeconds ?? DEFAULT_PREPARATION_SECONDS;
    if (!Number.isSafeInteger(this.#preparationSeconds) || this.#preparationSeconds <= 0) {
      throw new Error('preparation window must be a positive safe integer');
    }
  }

  persistence(): PartnerPersistence {
    return this.#persistence;
  }

  async createConnection(connectionId: string, aggregatorLfdi: string): Promise<ConnectionRecord> {
    validateId(connectionId, 'connectionId');
    if (!isCanonicalLfdi(aggregatorLfdi)) throw new Error('aggregator LFDI must be 40 lowercase hexadecimal characters');
    const existing = await this.#persistence.get<ConnectionRecord>(connectionId, 'connection', connectionId);
    if (existing) {
      await this.#authorizeConnectionIdentity(existing, aggregatorLfdi);
      return existing;
    }
    const now = this.#now();
    const record: ConnectionRecord = {
      connectionId,
      recordType: 'connection',
      id: connectionId,
      aggregatorLfdi,
      createdAt: now,
      updatedAt: now,
    };
    if (await this.#persistence.createConnectionWithIdentity(record, identityRecord(record, aggregatorLfdi, now))) {
      return record;
    }
    const concurrent = await this.#persistence.get<ConnectionRecord>(connectionId, 'connection', connectionId);
    if (!concurrent) throw new Error('aggregator LFDI is already authorized for another connection');
    await this.#authorizeConnectionIdentity(concurrent, aggregatorLfdi);
    return concurrent;
  }

  connection(connectionId: string): Promise<ConnectionRecord | undefined> {
    return this.#persistence.get(connectionId, 'connection', connectionId);
  }

  async rotateConnectionIdentity(connectionId: string, aggregatorLfdi: string): Promise<ConnectionRecord> {
    if (!isCanonicalLfdi(aggregatorLfdi)) throw new Error('aggregator LFDI must be 40 lowercase hexadecimal characters');
    const existing = await this.#requireConnection(connectionId);
    await this.#authorizeConnectionIdentity(existing, aggregatorLfdi);
    if (existing.aggregatorLfdi === aggregatorLfdi) return existing;
    const rotated = { ...existing, aggregatorLfdi, updatedAt: this.#now() };
    await this.#persistence.put(rotated);
    return rotated;
  }

  async revokeConnectionIdentity(connectionId: string, aggregatorLfdi: string): Promise<void> {
    if (!isCanonicalLfdi(aggregatorLfdi)) throw new Error('aggregator LFDI must be 40 lowercase hexadecimal characters');
    const connection = await this.#requireConnection(connectionId);
    if (connection.aggregatorLfdi === aggregatorLfdi) {
      throw new Error('cannot revoke the active aggregator LFDI; rotate the connection first');
    }
    const identities = await this.#persistence.list<ConnectionIdentityRecord>(connectionId, 'connection-identity');
    if (!identities.some((identity) => identity.aggregatorLfdi === aggregatorLfdi)) return;
    if (identities.length <= 1) throw new Error('cannot revoke the last authorized aggregator LFDI');
    await this.#persistence.revokeConnectionIdentity(connectionId, aggregatorLfdi);
  }

  async createProgram(connectionId: string, programId: string, mRID: string, primacy = 0): Promise<ProgramRecord> {
    await this.#requireConnection(connectionId);
    validateId(programId, 'programId');
    validateId(mRID, 'program mRID');
    if (!Number.isSafeInteger(primacy) || primacy < 0 || primacy > 255) {
      throw new Error('program primacy must be a safe integer between 0 and 255');
    }
    const existing = await this.#persistence.get<ProgramRecord>(connectionId, 'program', programId);
    if (existing) return existing;
    const now = this.#now();
    const record: ProgramRecord = {
      connectionId,
      recordType: 'program',
      id: programId,
      mRID,
      token: opaqueToken('program', connectionId, programId),
      primacy,
      createdAt: now,
      updatedAt: now,
    };
    if (!await this.#persistence.put(record, { ifAbsent: true })) {
      return (await this.#persistence.get<ProgramRecord>(connectionId, 'program', programId))!;
    }
    return record;
  }

  programs(connectionId: string): Promise<ProgramRecord[]> {
    return this.#persistence.list(connectionId, 'program');
  }

  async registerDevice(connectionId: string, lFDI: string): Promise<{ device: DeviceRecord; created: boolean }> {
    await this.#requireConnection(connectionId);
    if (!isCanonicalLfdi(lFDI)) throw new Error('EndDevice LFDI must be 40 lowercase hexadecimal characters');
    const now = this.#now();
    const record: DeviceRecord = {
      connectionId,
      recordType: 'device',
      id: lFDI,
      lFDI,
      token: opaqueToken('device', connectionId, lFDI),
      assignedProgramIds: [],
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.#persistence.put(record, { ifAbsent: true });
    return { device: created ? record : (await this.#persistence.get<DeviceRecord>(connectionId, 'device', lFDI))!, created };
  }

  async devices(connectionId: string): Promise<DeviceRecord[]> {
    const [devices, assignments] = await Promise.all([
      this.#persistence.list<DeviceRecord>(connectionId, 'device'),
      this.#persistence.list<AssignmentRecord>(connectionId, 'assignment'),
    ]);
    return devices.map((device) => ({
      ...device,
      assignedProgramIds: assignments
        .filter((assignment) => assignment.targetLfdi === device.lFDI)
        .map((assignment) => assignment.programId)
        .sort(),
    }));
  }

  async device(connectionId: string, lFDI: string): Promise<DeviceRecord | undefined> {
    return (await this.devices(connectionId)).find((device) => device.lFDI === lFDI);
  }

  async deviceByToken(connectionId: string, token: string): Promise<DeviceRecord | undefined> {
    return (await this.devices(connectionId)).find((device) => device.token === token);
  }

  async deleteDevice(connectionId: string, lFDI: string): Promise<void> {
    const assignments = await this.#persistence.list<AssignmentRecord>(connectionId, 'assignment');
    await Promise.all(assignments
      .filter((assignment) => assignment.targetLfdi === lFDI)
      .map((assignment) => this.#persistence.delete(connectionId, 'assignment', assignment.id)));
    await this.#persistence.delete(connectionId, 'device', lFDI);
  }

  async moveAssignment(
    connectionId: string,
    programId: string,
    targetLfdi: string,
    options: { expiresAt?: number } = {},
  ): Promise<void> {
    await this.#requireProgram(connectionId, programId);
    if (!await this.#persistence.get<DeviceRecord>(connectionId, 'device', targetLfdi)) {
      throw new Error('assignment target is not a registered EndDevice');
    }
    const now = this.#now();
    await this.#persistence.put({
      connectionId,
      recordType: 'assignment',
      id: programId,
      programId,
      targetLfdi,
      createdAt: now,
      updatedAt: now,
      ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
    });
  }

  async publishControl(input: PublishControlInput): Promise<ControlRecord> {
    await this.#requireProgram(input.connectionId, input.programId);
    validateId(input.mRID, 'control mRID');
    const responseRequired = assertFixedWattControl(input);
    const existing = await this.#persistence.get<ControlRecord>(input.connectionId, 'control', input.mRID);
    if (existing) throw new Error('control mRID is immutable and already exists');
    const now = this.#now();
    const record: ControlRecord = {
      connectionId: input.connectionId,
      recordType: 'control',
      id: input.mRID,
      programId: input.programId,
      mRID: input.mRID,
      creationTime: now,
      start: input.start,
      duration: input.duration,
      currentStatus: 1,
      responseRequired,
      opModFixedW: input.opModFixedW,
      createdAt: now,
      updatedAt: now,
    };
    if (!await this.#persistence.put(record, { ifAbsent: true })) throw new Error('control mRID is immutable and already exists');
    return record;
  }

  async controls(connectionId: string, programId?: string): Promise<ControlRecord[]> {
    const controls = await this.#persistence.list<ControlRecord>(connectionId, 'control');
    return programId ? controls.filter((control) => control.programId === programId) : controls;
  }

  /**
   * Settles a control's lifecycle. Only EventStatus may change: timing, targeting, program, and
   * command body stay exactly as published, because the partner client fingerprints those fields
   * and rejects any control that changes them under an existing mRID.
   */
  async completeControl(connectionId: string, mRID: string, status: number): Promise<ControlRecord> {
    const control = await this.#persistence.get<ControlRecord>(connectionId, 'control', mRID);
    if (!control) throw new Error('control not found');
    if (!Number.isSafeInteger(status) || status < CONTROL_STATUS.scheduled || status > CONTROL_STATUS.superseded) {
      throw new Error('control status must be an EventStatus value between 0 and 4');
    }
    if (TERMINAL_STATUSES.has(control.currentStatus)) {
      if (control.currentStatus !== status) {
        throw new Error(`control ${mRID} is already terminal and cannot move to status ${status}`);
      }
      return control;
    }
    const now = this.#now();
    const expiresAt = now + this.#retention.historySeconds;
    const completed = { ...control, currentStatus: status, completedAt: now, updatedAt: now, expiresAt };
    await this.#persistence.put(completed);
    await this.#expireEventScopedRecords(connectionId, control.programId, expiresAt);
    return completed;
  }

  /**
   * Publishes one bounded control to exactly one registered EndDevice under an event-scoped program.
   * Every check runs before the first write, and the control is written last, so an interrupted
   * attempt leaves a program the partner client can discover but no event it can act on.
   */
  async publishEventCommand(input: PublishEventCommandInput): Promise<EventCommandResult> {
    await this.#requireConnection(input.connectionId);
    validateId(input.requestId, 'requestId');
    validateId(input.eventId, 'eventId');
    if (!isCanonicalLfdi(input.targetLfdi)) throw new Error('target LFDI must be 40 lowercase hexadecimal characters');
    if (!await this.#persistence.get<DeviceRecord>(input.connectionId, 'device', input.targetLfdi)) {
      throw new Error('assignment target is not a registered EndDevice');
    }
    assertFixedWattControl(input);

    const programId = eventProgramId(input.eventId);
    const mRID = eventControlMrid(input.eventId);
    const requestHash = hashRequest({
      action: 'publish',
      connectionId: input.connectionId,
      eventId: input.eventId,
      targetLfdi: input.targetLfdi,
      start: input.start,
      duration: input.duration,
      opModFixedW: input.opModFixedW,
    });
    const replay = await this.#replayCommand(input.connectionId, 'publish', input.requestId, requestHash);
    if (replay) return replay;

    const deadline = this.#now() + this.#preparationSeconds;
    await this.#createEventProgram(input.connectionId, programId, deadline);
    await this.moveAssignment(input.connectionId, programId, input.targetLfdi, { expiresAt: deadline });
    const control = await this.publishControl({
      connectionId: input.connectionId,
      programId,
      mRID,
      start: input.start,
      duration: input.duration,
      opModFixedW: input.opModFixedW,
    });
    await this.#clearPreparationDeadline(input.connectionId, programId);

    return this.#recordCommand('publish', input.requestId, requestHash, {
      action: 'publish',
      connectionId: input.connectionId,
      requestId: input.requestId,
      eventId: input.eventId,
      programId,
      mRID,
      targetLfdi: input.targetLfdi,
      start: control.start,
      duration: control.duration,
      opModFixedW: control.opModFixedW ?? input.opModFixedW,
      currentStatus: control.currentStatus,
      idempotent: false,
    });
  }

  /** Withdraws a control this connection published, by event identity rather than by caller-named mRID. */
  async cancelEventCommand(input: CancelEventCommandInput): Promise<EventCommandResult> {
    await this.#requireConnection(input.connectionId);
    validateId(input.requestId, 'requestId');
    validateId(input.eventId, 'eventId');
    const requestHash = hashRequest({
      action: 'cancel',
      connectionId: input.connectionId,
      eventId: input.eventId,
    });
    const replay = await this.#replayCommand(input.connectionId, 'cancel', input.requestId, requestHash);
    if (replay) return replay;

    const mRID = eventControlMrid(input.eventId);
    const control = await this.#persistence.get<ControlRecord>(input.connectionId, 'control', mRID);
    if (!control) throw new Error(`event ${input.eventId} was not found on connection ${input.connectionId}`);
    const assignment = await this.#persistence.get<AssignmentRecord>(input.connectionId, 'assignment', control.programId);
    const cancelled = await this.completeControl(input.connectionId, mRID, CONTROL_STATUS.cancelled);

    return this.#recordCommand('cancel', input.requestId, requestHash, {
      action: 'cancel',
      connectionId: input.connectionId,
      requestId: input.requestId,
      eventId: input.eventId,
      programId: control.programId,
      mRID,
      targetLfdi: assignment?.targetLfdi ?? '',
      start: control.start,
      duration: control.duration,
      opModFixedW: control.opModFixedW ?? 0,
      currentStatus: cancelled.currentStatus,
      idempotent: false,
    });
  }

  async #createEventProgram(connectionId: string, programId: string, expiresAt: number): Promise<ProgramRecord> {
    validateId(programId, 'programId');
    const existing = await this.#persistence.get<ProgramRecord>(connectionId, 'program', programId);
    if (existing) return existing;
    const now = this.#now();
    const record: ProgramRecord = {
      connectionId,
      recordType: 'program',
      id: programId,
      mRID: programId,
      token: opaqueToken('program', connectionId, programId),
      primacy: 255,
      eventScoped: true,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    };
    if (!await this.#persistence.put(record, { ifAbsent: true })) {
      return (await this.#persistence.get<ProgramRecord>(connectionId, 'program', programId))!;
    }
    return record;
  }

  /** Once the control exists the preparation is complete, so its records outlive the abandonment window. */
  async #clearPreparationDeadline(connectionId: string, programId: string): Promise<void> {
    for (const recordType of ['program', 'assignment'] as const) {
      const record = await this.#persistence.get(connectionId, recordType, programId);
      if (!record || record.expiresAt === undefined) continue;
      const { expiresAt: _dropped, ...retained } = record;
      await this.#persistence.put(retained as typeof record);
    }
  }

  async #expireEventScopedRecords(connectionId: string, programId: string, expiresAt: number): Promise<void> {
    const program = await this.#persistence.get<ProgramRecord>(connectionId, 'program', programId);
    if (!program?.eventScoped) return;
    await this.#persistence.put({ ...program, expiresAt });
    const assignment = await this.#persistence.get<AssignmentRecord>(connectionId, 'assignment', programId);
    if (assignment) await this.#persistence.put({ ...assignment, expiresAt });
  }

  async #replayCommand(
    connectionId: string,
    action: 'publish' | 'cancel',
    requestId: string,
    requestHash: string,
  ): Promise<EventCommandResult | undefined> {
    const existing = await this.#persistence.get<CommandRecord>(connectionId, 'command', commandRecordId(action, requestId));
    if (!existing) return undefined;
    if (existing.requestHash !== requestHash) {
      throw new Error(`request ${requestId} was already used with a different request hash`);
    }
    return { ...existing.result, idempotent: true };
  }

  async #recordCommand(
    action: 'publish' | 'cancel',
    requestId: string,
    requestHash: string,
    result: EventCommandResult,
  ): Promise<EventCommandResult> {
    const now = this.#now();
    await this.#persistence.put({
      connectionId: result.connectionId,
      recordType: 'command',
      id: commandRecordId(action, requestId),
      action,
      requestId,
      requestHash,
      eventId: result.eventId,
      result,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.#retention.historySeconds,
    });
    return result;
  }

  async recordExchange(input: RecordExchangeInput): Promise<ExchangeRecord> {
    await this.#requireConnection(input.connectionId);
    const now = this.#now();
    const id = input.id ?? randomUUID();
    const record: ExchangeRecord = {
      ...input,
      id,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.#retention.historySeconds,
    };
    if (!await this.#persistence.put(record, { ifAbsent: input.id !== undefined })) {
      return (await this.#persistence.get<ExchangeRecord>(input.connectionId, input.recordType, id))!;
    }
    return record;
  }

  responses(connectionId: string): Promise<ExchangeRecord[]> {
    return this.#persistence.list(connectionId, 'response');
  }

  telemetry(connectionId: string): Promise<ExchangeRecord[]> {
    return this.#persistence.list(connectionId, 'telemetry');
  }

  async #requireConnection(connectionId: string): Promise<ConnectionRecord> {
    const connection = await this.connection(connectionId);
    if (!connection) throw new Error(`connection ${connectionId} does not exist`);
    return connection;
  }

  async #authorizeConnectionIdentity(connection: ConnectionRecord, aggregatorLfdi: string): Promise<void> {
    const now = this.#now();
    if (!await this.#persistence.authorizeConnectionIdentity(identityRecord(connection, aggregatorLfdi, now))) {
      throw new Error('aggregator LFDI is already authorized for another connection');
    }
  }

  async #requireProgram(connectionId: string, programId: string): Promise<ProgramRecord> {
    const program = await this.#persistence.get<ProgramRecord>(connectionId, 'program', programId);
    if (!program) throw new Error(`program ${programId} does not exist on connection ${connectionId}`);
    return program;
  }
}

function identityRecord(connection: ConnectionRecord, aggregatorLfdi: string, now: number): ConnectionIdentityRecord {
  return {
    connectionId: connection.connectionId,
    recordType: 'connection-identity',
    id: aggregatorLfdi,
    aggregatorLfdi,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Validates the one control shape this profile supports, before any record is written.
 * Returns the normalized responseRequired byte.
 */
export function assertFixedWattControl(input: {
  start: number;
  duration: number;
  opModFixedW: number;
  responseRequired?: string;
}): string {
  if (!Number.isSafeInteger(input.start) || input.start < 0) throw new Error('control start must be a non-negative safe integer');
  if (!Number.isSafeInteger(input.duration) || input.duration < 1 || input.duration > 900) {
    throw new Error('control duration must be between 1 and 900 seconds');
  }
  const extended = input as { opModConnect?: unknown; opModMaxLimW?: unknown };
  if (extended.opModConnect !== undefined || extended.opModMaxLimW !== undefined) {
    throw new Error('initial interoperability profile supports only opModFixedW');
  }
  if (!Number.isFinite(input.opModFixedW) || Math.abs(input.opModFixedW) > 5_000) {
    throw new Error('opModFixedW must be within -5000..5000 W');
  }
  const responseRequired = input.responseRequired ?? '03';
  if (!/^[0-9a-fA-F]{2}$/.test(responseRequired) || (Number.parseInt(responseRequired, 16) & ~0x07) !== 0) {
    throw new Error('responseRequired must be a one-byte hexadecimal value using only supported bits 0..2');
  }
  return responseRequired.toLowerCase();
}

function commandRecordId(action: 'publish' | 'cancel', requestId: string): string {
  return `${action}:${requestId}`;
}

/** Hashes the semantic request so a retry under one identity cannot smuggle in a different command. */
function hashRequest(request: Record<string, string | number>): string {
  const canonical = Object.keys(request).sort().map((key) => [key, request[key]]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function opaqueToken(kind: string, connectionId: string, id: string): string {
  return `${kind.slice(0, 1)}-${createHash('sha256').update(`${kind}\0${connectionId}\0${id}`).digest('hex').slice(0, 20)}`;
}

function validateId(value: string, name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${name} must start with a letter and contain only letters, numbers, dot, underscore, colon, or hyphen`);
  }
}

function isCanonicalLfdi(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}
