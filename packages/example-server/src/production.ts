import { makePartnerApp } from './partner-app.js';
import type { PartnerPersistence, RetentionPolicy } from './persistence/port.js';
import type { ConnectionResolver } from './partner-routes.js';
import { verifiedLeafConnectionResolver } from './verified-leaf-auth.js';

export interface ProductionPartnerAppOptions {
  persistence: PartnerPersistence;
  resolveConnection?: ConnectionResolver;
  now?: () => number;
  retention?: RetentionPolicy;
}

/**
 * Production protocol/domain composition independent of the selected storage adapter.
 * Deployment-specific composition roots may supply DynamoDB, SQL, or partner-owned storage.
 *
 * This module deliberately imports no storage SDK. The DynamoDB composition root lives in
 * `production-dynamodb.ts`, so a caller that composes its own persistence — the toolkit's
 * loopback mTLS rehearsal, for instance — does not pay to load a cloud SDK it never uses.
 */
export function makeProductionPartnerApp(options: ProductionPartnerAppOptions) {
  const resolveConnection = options.resolveConnection
    ?? verifiedLeafConnectionResolver(options.persistence);
  return makePartnerApp({ ...options, resolveConnection });
}
