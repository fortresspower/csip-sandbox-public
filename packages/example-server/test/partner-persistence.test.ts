import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoPartnerPersistence } from '../src/persistence/dynamodb.js';
import { createMemoryPersistenceState, MemoryPartnerPersistence } from '../src/persistence/memory.js';
import type { PartnerPersistence } from '../src/persistence/port.js';
import { PartnerDomain } from '../src/partner-domain.js';

const AGGREGATOR = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DEVICE_ALPHA = '1111111111111111111111111111111111111111';
const DEVICE_BETA = '2222222222222222222222222222222222222222';

type PersistencePair = { first: PartnerPersistence; restart: () => PartnerPersistence };

function memoryPair(now: () => number): PersistencePair {
  const state = createMemoryPersistenceState();
  return {
    first: new MemoryPartnerPersistence({ state, now }),
    restart: () => new MemoryPartnerPersistence({ state, now }),
  };
}

function dynamoPair(now: () => number): PersistencePair {
  const client = new FakeDocumentClient();
  return {
    first: new DynamoPartnerPersistence({ client: client as unknown as DynamoDBDocumentClient, tableName: 'partner-state', now }),
    restart: () => new DynamoPartnerPersistence({ client: client as unknown as DynamoDBDocumentClient, tableName: 'partner-state', now }),
  };
}

for (const [name, factory] of [
  ['memory', memoryPair],
  ['dynamodb', dynamoPair],
] as const) {
  describe(`${name} partner persistence contract`, () => {
    it('retains active configuration across server reconstruction and enforces one-device assignment', async () => {
      let clock = 1_000;
      const pair = factory(() => clock);
      const first = new PartnerDomain({ persistence: pair.first, now: () => clock });
      await first.createConnection('partner-a', AGGREGATOR);
      await first.createProgram('partner-a', 'dispatch', 'partner-program', 7);
      await first.registerDevice('partner-a', DEVICE_ALPHA);
      await first.registerDevice('partner-a', DEVICE_BETA);
      await first.moveAssignment('partner-a', 'dispatch', DEVICE_ALPHA);

      clock += 10;
      const restarted = new PartnerDomain({ persistence: pair.restart(), now: () => clock });
      expect(await restarted.connection('partner-a')).toMatchObject({ aggregatorLfdi: AGGREGATOR });
      expect(await restarted.devices('partner-a')).toEqual(expect.arrayContaining([
        expect.objectContaining({ lFDI: DEVICE_ALPHA, assignedProgramIds: ['dispatch'] }),
        expect.objectContaining({ lFDI: DEVICE_BETA, assignedProgramIds: [] }),
      ]));

      await restarted.moveAssignment('partner-a', 'dispatch', DEVICE_BETA);
      expect(await restarted.devices('partner-a')).toEqual(expect.arrayContaining([
        expect.objectContaining({ lFDI: DEVICE_ALPHA, assignedProgramIds: [] }),
        expect.objectContaining({ lFDI: DEVICE_BETA, assignedProgramIds: ['dispatch'] }),
      ]));
    });

    it('makes EndDevice registration idempotent and keeps partner records isolated', async () => {
      const pair = factory(() => 1_000);
      const domain = new PartnerDomain({ persistence: pair.first, now: () => 1_000 });
      await domain.createConnection('partner-a', AGGREGATOR);
      await domain.createConnection('partner-b', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      expect((await domain.registerDevice('partner-a', DEVICE_ALPHA)).created).toBe(true);
      expect((await domain.registerDevice('partner-a', DEVICE_ALPHA)).created).toBe(false);
      await domain.recordExchange({ connectionId: 'partner-a', recordType: 'telemetry', category: 'mup-standard', deviceLfdi: DEVICE_ALPHA });
      expect(await domain.telemetry('partner-a')).toHaveLength(1);
      expect(await domain.telemetry('partner-b')).toHaveLength(0);
      expect((await pair.first.findConnectionByAggregatorLfdi(AGGREGATOR))?.connectionId).toBe('partner-a');
    });

    it('moves the certificate lookup when an aggregator identity rotates', async () => {
      const pair = factory(() => 1_000);
      const domain = new PartnerDomain({ persistence: pair.first, now: () => 1_000 });
      const replacement = 'cccccccccccccccccccccccccccccccccccccccc';
      await domain.createConnection('partner-a', AGGREGATOR);

      await domain.rotateConnectionIdentity('partner-a', replacement);

      expect((await pair.first.findConnectionByAggregatorLfdi(AGGREGATOR))?.connectionId).toBe('partner-a');
      expect((await pair.first.findConnectionByAggregatorLfdi(replacement))?.connectionId).toBe('partner-a');
      await domain.revokeConnectionIdentity('partner-a', AGGREGATOR);
      expect(await pair.first.findConnectionByAggregatorLfdi(AGGREGATOR)).toBeUndefined();
      await expect(domain.revokeConnectionIdentity('partner-a', replacement)).rejects.toThrow(/active/i);
    });

    it('atomically gives a concurrently claimed aggregator LFDI to exactly one connection', async () => {
      const pair = factory(() => 1_000);
      const first = new PartnerDomain({ persistence: pair.first, now: () => 1_000 });
      const second = new PartnerDomain({ persistence: pair.restart(), now: () => 1_000 });

      const attempts = await Promise.allSettled([
        first.createConnection('partner-a', AGGREGATOR),
        second.createConnection('partner-b', AGGREGATOR),
      ]);

      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
      const owner = await pair.first.findConnectionByAggregatorLfdi(AGGREGATOR);
      expect(owner?.connectionId).toMatch(/^partner-[ab]$/);
      expect([
        await pair.first.get('partner-a', 'connection', 'partner-a'),
        await pair.first.get('partner-b', 'connection', 'partner-b'),
      ].filter(Boolean)).toHaveLength(1);
    });
  });
}

for (const [name, factory] of [['memory', memoryPair], ['dynamodb', dynamoPair]] as const) {
  describe(`${name} bounded history retention`, () => {
    it('expires completed controls and exchange history while active configuration survives', async () => {
      let clock = 100;
      const pair = factory(() => clock);
      const domain = new PartnerDomain({ persistence: pair.first, now: () => clock, retention: { historySeconds: 30 } });
      await domain.createConnection('partner-a', AGGREGATOR);
      await domain.createProgram('partner-a', 'dispatch', 'partner-program');
      await domain.registerDevice('partner-a', DEVICE_ALPHA);
      await domain.publishControl({ connectionId: 'partner-a', programId: 'dispatch', mRID: 'control-a', start: 100, duration: 60, opModFixedW: -500 });
      await domain.completeControl('partner-a', 'control-a', 3);
      await domain.recordExchange({ connectionId: 'partner-a', recordType: 'response', category: 'status-3', subject: 'control-a' });

      clock = 131;
      expect(await domain.controls('partner-a')).toHaveLength(0);
      expect(await domain.responses('partner-a')).toHaveLength(0);
      expect(await domain.devices('partner-a')).toHaveLength(1);
      expect(await domain.programs('partner-a')).toHaveLength(1);
    });
  });
}

describe('dynamodb transaction error handling', () => {
  it('propagates transaction conflicts instead of reporting an LFDI collision', async () => {
    const client = new FakeDocumentClient();
    client.cancelNextTransaction([{ Code: 'TransactionConflict' }]);
    const persistence = new DynamoPartnerPersistence({
      client: client as unknown as DynamoDBDocumentClient,
      tableName: 'partner-state',
      now: () => 1_000,
    });
    const domain = new PartnerDomain({ persistence, now: () => 1_000 });

    await expect(domain.createConnection('partner-a', AGGREGATOR)).rejects.toMatchObject({
      name: 'TransactionCanceledException',
    });
  });
});

class FakeDocumentClient {
  readonly #items = new Map<string, Record<string, unknown>>();
  #nextTransactionCancellation?: Array<{ Code: string }>;

  cancelNextTransaction(reasons: Array<{ Code: string }>): void {
    this.#nextTransactionCancellation = reasons;
  }

  async send(command: { constructor: { name: string }; input: Record<string, any> }): Promise<Record<string, any>> {
    const { input } = command;
    if (command.constructor.name === 'PutCommand') {
      const item = structuredClone(input.Item);
      const key = `${item.PK}|${item.SK}`;
      if (input.ConditionExpression && this.#items.has(key)) {
        throw Object.assign(new Error('conditional check failed'), { name: 'ConditionalCheckFailedException' });
      }
      this.#items.set(key, item);
      return {};
    }
    if (command.constructor.name === 'GetCommand') {
      return { Item: structuredClone(this.#items.get(`${input.Key.PK}|${input.Key.SK}`)) };
    }
    if (command.constructor.name === 'DeleteCommand') {
      this.#items.delete(`${input.Key.PK}|${input.Key.SK}`);
      return {};
    }
    if (command.constructor.name === 'TransactWriteCommand') {
      if (this.#nextTransactionCancellation) {
        const CancellationReasons = this.#nextTransactionCancellation;
        this.#nextTransactionCancellation = undefined;
        throw Object.assign(new Error('transaction cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons,
        });
      }
      const operations = input.TransactItems as Array<Record<string, any>>;
      for (const operation of operations) {
        const write = operation.Put ?? operation.Delete;
        const existing = this.#items.get(`${(write.Item ?? write.Key).PK}|${(write.Item ?? write.Key).SK}`);
        if (write.ConditionExpression === 'attribute_not_exists(PK)' && existing) {
          throw transactionConditionalFailure();
        }
        if (write.ConditionExpression?.includes('connectionId = :connectionId')
          && existing
          && existing.connectionId !== write.ExpressionAttributeValues[':connectionId']) {
          throw transactionConditionalFailure();
        }
      }
      for (const operation of operations) {
        if (operation.Put) {
          const item = structuredClone(operation.Put.Item);
          this.#items.set(`${item.PK}|${item.SK}`, item);
        } else {
          this.#items.delete(`${operation.Delete.Key.PK}|${operation.Delete.Key.SK}`);
        }
      }
      return {};
    }
    if (command.constructor.name === 'QueryCommand') {
      const values = [...this.#items.values()];
      const items = input.IndexName
        ? values.filter((item) => item.GSI1PK === input.ExpressionAttributeValues[':pk'])
        : values.filter((item) => item.PK === input.ExpressionAttributeValues[':pk']
          && String(item.SK).startsWith(input.ExpressionAttributeValues[':prefix']));
      return { Items: structuredClone(items.slice(0, input.Limit ?? items.length)) };
    }
    throw new Error(`unsupported command ${command.constructor.name}`);
  }
}

function transactionConditionalFailure(): Error {
  return Object.assign(new Error('transaction cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
  });
}
