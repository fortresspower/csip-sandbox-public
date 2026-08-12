import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeTestPki, type TestPki } from '../../client-core/test/test-certificates.js';
import { makePartnerApp } from '../src/partner-app.js';
import { MemoryPartnerPersistence } from '../src/persistence/memory.js';
import {
  aggregatorLfdiFromAlbLeafHeader,
  ALB_CLIENT_CERTIFICATE_LEAF_HEADER,
  verifiedLeafConnectionResolver,
} from '../src/verified-leaf-auth.js';

describe('ALB verified leaf authorization', () => {
  let pki: TestPki;

  beforeAll(() => { pki = makeTestPki(); });
  afterAll(() => pki.cleanup());

  it('derives the allowlisted aggregator LFDI from the URL-encoded PEM leaf', async () => {
    const authorized = pki.root.issue('authorized-aggregator', 'client');
    const header = encodeURIComponent(authorized.certificate.toString('utf8'));
    const persistence = new MemoryPartnerPersistence();
    const app = makePartnerApp({ persistence, resolveConnection: verifiedLeafConnectionResolver(persistence) });
    await app.domain.createConnection('partner-a', aggregatorLfdiFromAlbLeafHeader(header));

    const response = await request(app.app).get('/sep2/capability').set(ALB_CLIENT_CERTIFICATE_LEAF_HEADER, header);
    expect(response.status).toBe(200);
    expect(response.text).toContain('DeviceCapability');
  });

  it('rejects missing, malformed, CA, and trusted-but-not-allowlisted leaves before CSIP routing', async () => {
    const persistence = new MemoryPartnerPersistence();
    const app = makePartnerApp({ persistence, resolveConnection: verifiedLeafConnectionResolver(persistence) });
    const unlisted = encodeURIComponent(pki.root.issue('unlisted-aggregator', 'client').certificate.toString('utf8'));
    const ca = encodeURIComponent(pki.root.certificate.toString('utf8'));

    expect((await request(app.app).get('/sep2/capability')).status).toBe(401);
    expect((await request(app.app).get('/sep2/capability').set(ALB_CLIENT_CERTIFICATE_LEAF_HEADER, 'not-a-certificate')).status).toBe(401);
    expect((await request(app.app).get('/sep2/capability').set(ALB_CLIENT_CERTIFICATE_LEAF_HEADER, ca)).status).toBe(401);
    expect((await request(app.app).get('/sep2/capability').set(ALB_CLIENT_CERTIFICATE_LEAF_HEADER, unlisted)).status).toBe(403);
  });
});
