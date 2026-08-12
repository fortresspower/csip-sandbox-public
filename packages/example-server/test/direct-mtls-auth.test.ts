import { createHash, X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestPki, type TestPki } from '../../client-core/test/test-certificates.js';
import { directMtlsConnectionResolver } from '../src/direct-mtls-auth.js';
import { MemoryPartnerPersistence } from '../src/persistence/memory.js';

describe('direct mTLS authorization for loopback rehearsal', () => {
  let pki: TestPki;

  beforeAll(() => { pki = makeTestPki(); });
  afterAll(() => pki.cleanup());

  it('uses only an authorized, TLS-verified peer certificate', async () => {
    const client = pki.root.issue('authorized-aggregator', 'client');
    const raw = new X509Certificate(client.certificate).raw;
    const aggregatorLfdi = createHash('sha256').update(raw).digest('hex').slice(0, 40);
    const persistence = new MemoryPartnerPersistence();
    const connection = {
      connectionId: 'partner-a',
      recordType: 'connection' as const,
      id: 'partner-a',
      aggregatorLfdi,
      createdAt: 1,
      updatedAt: 1,
    };
    await persistence.createConnectionWithIdentity(connection, {
      connectionId: 'partner-a',
      recordType: 'connection-identity',
      id: aggregatorLfdi,
      aggregatorLfdi,
      createdAt: 1,
      updatedAt: 1,
    });
    const resolve = directMtlsConnectionResolver(persistence);

    const authorized = await resolve({
      socket: {
        encrypted: true,
        authorized: true,
        getPeerCertificate: () => ({ raw }),
      },
    } as never);
    const unverified = await resolve({
      socket: {
        encrypted: true,
        authorized: false,
        getPeerCertificate: () => ({ raw }),
      },
    } as never);
    const noCertificate = await resolve({
      socket: {
        encrypted: true,
        authorized: true,
        getPeerCertificate: () => ({}),
      },
    } as never);

    expect(authorized).toBe('partner-a');
    expect(unverified).toBeUndefined();
    expect(noCertificate).toBeUndefined();
  });
});
