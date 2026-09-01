import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoPartnerPersistence } from './persistence/dynamodb.js';
import { makeProductionPartnerApp } from './production.js';

/**
 * DynamoDB composition root.
 *
 * Separate from `production.ts` so that the storage SDK is loaded only by a deployment that
 * actually selects this adapter. `PartnerPersistence` is the seam; DynamoDB is one choice
 * behind it, not a requirement of the production app.
 */
export function makeProductionAppFromEnvironment() {
  const tableName = requiredEnvironment('CSIP_DYNAMODB_TABLE');
  const historyRetentionDays = positiveIntegerEnvironment('CSIP_HISTORY_RETENTION_DAYS', 30);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const persistence = new DynamoPartnerPersistence({ client, tableName });
  return makeProductionPartnerApp({
    persistence,
    retention: { historySeconds: historyRetentionDays * 24 * 60 * 60 },
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the production partner server`);
  return value;
}

function positiveIntegerEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
