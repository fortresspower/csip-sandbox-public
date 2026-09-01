import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { makeServerFromEnvironment } from '../src/index.js';
import { createMemoryPersistenceState, MemoryPartnerPersistence } from '../src/persistence/memory.js';
import { makeProductionPartnerApp, makeProductionAppFromEnvironment } from '../src/production.js';

describe('production server bootstrap', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('requires durable state configuration and accepts an explicit history retention', () => {
    vi.stubEnv('CSIP_DYNAMODB_TABLE', 'partner-state');
    vi.stubEnv('CSIP_HISTORY_RETENTION_DAYS', '7');

    expect(() => makeProductionAppFromEnvironment()).not.toThrow();
  });

  it('composes the production partner app with partner-chosen persistence', async () => {
    const state = createMemoryPersistenceState();
    const first = makeProductionPartnerApp({
      persistence: new MemoryPartnerPersistence({ state }),
    });
    await first.domain.createConnection('partner-a', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    const restarted = makeProductionPartnerApp({
      persistence: new MemoryPartnerPersistence({ state }),
    });
    expect(await restarted.domain.connection('partner-a')).toMatchObject({ connectionId: 'partner-a' });
    await request(restarted.app).get('/healthz').expect(200, { status: 'ok' });
  });

  it.each(['0', '-1', '1.5', 'not-a-number'])(
    'rejects invalid history retention %s',
    (retention) => {
      vi.stubEnv('CSIP_DYNAMODB_TABLE', 'partner-state');
      vi.stubEnv('CSIP_HISTORY_RETENTION_DAYS', retention);

      expect(() => makeProductionAppFromEnvironment()).toThrow(/positive integer/i);
    },
  );

  it('refuses to start without the durable table', () => {
    vi.stubEnv('CSIP_DYNAMODB_TABLE', '');
    expect(() => makeProductionAppFromEnvironment()).toThrow(/CSIP_DYNAMODB_TABLE is required/);
  });

  it('keeps the distributed image in local-demo mode unless partner mode is explicit', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CSIP_SERVER_MODE', '');
    vi.stubEnv('CSIP_DYNAMODB_TABLE', '');

    const server = makeServerFromEnvironment();
    expect(server.mode).toBe('local-demo');
    expect(server.store).toBeDefined();
  });

  it('requires durable state when partner mode is explicit', () => {
    vi.stubEnv('CSIP_SERVER_MODE', 'partner');
    vi.stubEnv('CSIP_DYNAMODB_TABLE', '');

    expect(() => makeServerFromEnvironment()).toThrow(/CSIP_DYNAMODB_TABLE is required/);
  });
});
