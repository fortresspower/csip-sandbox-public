import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  ConnectionIdentityRecord,
  ConnectionRecord,
  PartnerPersistence,
  PartnerRecord,
  PutOptions,
  RecordType,
} from './port.js';

export interface DynamoPartnerPersistenceOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
  now?: () => number;
}

export class DynamoPartnerPersistence implements PartnerPersistence {
  readonly #client: DynamoDBDocumentClient;
  readonly #tableName: string;
  readonly #now: () => number;

  constructor(options: DynamoPartnerPersistenceOptions) {
    if (!options.tableName.trim()) throw new Error('DynamoDB tableName is required');
    this.#client = options.client;
    this.#tableName = options.tableName;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  async get<T extends PartnerRecord>(connectionId: string, recordType: T['recordType'], id: string): Promise<T | undefined> {
    const result = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { PK: partitionKey(connectionId), SK: sortKey(recordType, id) },
      ConsistentRead: true,
    }));
    const record = result.Item?.record as T | undefined;
    return record && !this.#expired(record) ? record : undefined;
  }

  async list<T extends PartnerRecord>(connectionId: string, recordType: T['recordType']): Promise<T[]> {
    const records: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: { ':pk': partitionKey(connectionId), ':prefix': `${recordType}#` },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }));
      records.push(...(result.Items ?? []).map((item) => item.record as T).filter((record) => !this.#expired(record)));
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return records.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async put(record: PartnerRecord, options: PutOptions = {}): Promise<boolean> {
    try {
      await this.#client.send(new PutCommand({
        TableName: this.#tableName,
        Item: item(record),
        ...(options.ifAbsent ? { ConditionExpression: 'attribute_not_exists(PK)' } : {}),
      }));
      return true;
    } catch (error) {
      if (options.ifAbsent && isConditionalFailure(error)) return false;
      throw error;
    }
  }

  async delete(connectionId: string, recordType: RecordType, id: string): Promise<void> {
    await this.#client.send(new DeleteCommand({
      TableName: this.#tableName,
      Key: { PK: partitionKey(connectionId), SK: sortKey(recordType, id) },
    }));
  }

  async createConnectionWithIdentity(
    connection: ConnectionRecord,
    identity: ConnectionIdentityRecord,
  ): Promise<boolean> {
    try {
      await this.#client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.#tableName,
              Item: item(connection),
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: this.#tableName,
              Item: identityClaim(identity),
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          { Put: { TableName: this.#tableName, Item: item(identity) } },
        ],
      }));
      return true;
    } catch (error) {
      if (isTransactionConditionalFailure(error)) return false;
      throw error;
    }
  }

  async authorizeConnectionIdentity(identity: ConnectionIdentityRecord): Promise<boolean> {
    try {
      await this.#client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.#tableName,
              Item: identityClaim(identity),
              ConditionExpression: 'attribute_not_exists(PK) OR connectionId = :connectionId',
              ExpressionAttributeValues: { ':connectionId': identity.connectionId },
            },
          },
          { Put: { TableName: this.#tableName, Item: item(identity) } },
        ],
      }));
      return true;
    } catch (error) {
      if (isTransactionConditionalFailure(error)) return false;
      throw error;
    }
  }

  async revokeConnectionIdentity(connectionId: string, aggregatorLfdi: string): Promise<void> {
    await this.#client.send(new TransactWriteCommand({
      TransactItems: [
        {
          Delete: {
            TableName: this.#tableName,
            Key: { PK: partitionKey(connectionId), SK: sortKey('connection-identity', aggregatorLfdi) },
          },
        },
        {
          Delete: {
            TableName: this.#tableName,
            Key: identityClaimKey(aggregatorLfdi),
            ConditionExpression: 'attribute_not_exists(PK) OR connectionId = :connectionId',
            ExpressionAttributeValues: { ':connectionId': connectionId },
          },
        },
      ],
    }));
  }

  async findConnectionByAggregatorLfdi(aggregatorLfdi: string): Promise<ConnectionRecord | undefined> {
    const result = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: identityClaimKey(aggregatorLfdi),
      ConsistentRead: true,
    }));
    const connectionId = result.Item?.connectionId as string | undefined;
    return connectionId ? this.get(connectionId, 'connection', connectionId) : undefined;
  }

  #expired(record: PartnerRecord): boolean {
    return record.expiresAt !== undefined && record.expiresAt <= this.#now();
  }
}

function item(record: PartnerRecord): Record<string, unknown> {
  return {
    PK: partitionKey(record.connectionId),
    SK: sortKey(record.recordType, record.id),
    record,
    ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
  };
}

function identityClaim(identity: ConnectionIdentityRecord): Record<string, unknown> {
  return { ...identityClaimKey(identity.aggregatorLfdi), connectionId: identity.connectionId };
}

function identityClaimKey(aggregatorLfdi: string): Record<string, string> {
  return { PK: `IDENTITY#${aggregatorLfdi}`, SK: 'CLAIM' };
}

function partitionKey(connectionId: string): string {
  return `CONNECTION#${connectionId}`;
}

function sortKey(recordType: RecordType, id: string): string {
  return `${recordType}#${id}`;
}

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

function isTransactionConditionalFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') return false;
  const reasons = (error as Error & { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  return reasons?.some((reason) => reason.Code === 'ConditionalCheckFailed') ?? false;
}
