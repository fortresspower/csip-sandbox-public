import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as https from 'node:https';
import type { RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createCsipTransport,
  CsipAuthenticationError,
  CsipConfigurationError,
  CsipProtocolError,
  type CsipConnectionServerTrust,
  type CsipTlsMaterial,
  type CsipTransport,
  type CsipTransportEnvironment,
} from '../src/index.js';
import { makeTestPki, type TestCertificate, type TestPki } from './test-certificates.js';

const execFile = promisify(execFileCallback);

describe('explicit connection server trust', () => {
  let pki: TestPki;
  let client: TestCertificate;
  let serverLeaf: TestCertificate;
  const transports: CsipTransport[] = [];
  const servers: https.Server[] = [];
  const policy = (origin: string): CsipConnectionServerTrust => ({ origin, kind: 'connection-ca' });
  const tls = (): CsipTlsMaterial => ({ ...clientTls(), certificateAuthorities: [pki.root.certificate] });
  const clientTls = (): CsipTlsMaterial => ({ certificate: client.certificate, privateKey: client.privateKey });

  beforeAll(() => {
    pki = makeTestPki();
    client = pki.root.issue('client-identity', 'client');
    serverLeaf = pki.root.issue('server-identity', 'server');
  });
  afterEach(async () => {
    transports.splice(0).forEach((transport) => transport.close());
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
  });
  afterAll(() => pki.cleanup());

  async function serve(
    leaf = serverLeaf,
    handler: RequestListener = (_request, response) => response.end('<DeviceCapability/>'),
    clientCa = pki.root.certificate,
  ): Promise<string> {
    const server = https.createServer({
      cert: leaf.certificate, key: leaf.privateKey, ca: clientCa,
      requestCert: true, rejectUnauthorized: true,
    }, handler);
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    return `https://localhost:${(server.address() as AddressInfo).port}`;
  }

  function connect(origin: string, material = tls()): CsipTransport {
    const transport = createCsipTransport({
      baseUrl: `${origin}/sep2`, environment: 'local-test', tls: material,
      serverTrust: policy(origin), resolveDns: async () => ['127.0.0.1'], timeoutMs: 2_000,
    });
    transports.push(transport);
    return transport;
  }

  it.each<CsipTransportEnvironment>(['deployed', 'local-test'])(
    'requires a canonical matching HTTPS origin and supported kind in %s', (environment) => {
      const resolveDns = vi.fn(async () => ['127.0.0.1']);
      for (const origin of [
        'https://other.example', 'https://partner.example/', 'https://partner.example/sep2',
        'https://PARTNER.example', 'https://partner.example:443', 'http://partner.example',
        'https://partner.example?query', 'https://partner.example#fragment',
        'https://user@partner.example', 'invalid',
      ]) {
        expect(() => createCsipTransport({
          baseUrl: 'https://partner.example/sep2', environment, tls: tls(),
          serverTrust: policy(origin), resolveDns,
        })).toThrow(CsipConfigurationError);
      }
      expect(() => createCsipTransport({
        baseUrl: 'https://partner.example', environment, tls: tls(), resolveDns,
        serverTrust: { origin: 'https://partner.example', kind: 'unknown' as 'connection-ca' },
      })).toThrow(CsipConfigurationError);
      expect(resolveDns).not.toHaveBeenCalled();
    },
  );

  it.each<CsipTransportEnvironment>(['deployed', 'local-test'])(
    'requires CA bytes and client identity before DNS in %s', (environment) => {
      const resolveDns = vi.fn(async () => ['127.0.0.1']);
      for (const material of [
        undefined, clientTls(), { ...tls(), certificateAuthorities: [] },
        { ...tls(), certificateAuthorities: [new Uint8Array()] },
        { ...tls(), certificateAuthorities: [pki.root.certificate, new Uint8Array()] },
        { ...tls(), certificate: new Uint8Array() }, { ...tls(), privateKey: new Uint8Array() },
      ]) {
        expect(() => createCsipTransport({
          baseUrl: 'https://partner.example', environment, tls: material,
          serverTrust: policy('https://partner.example'), resolveDns,
        })).toThrow(CsipConfigurationError);
      }
      expect(resolveDns).not.toHaveBeenCalled();
    },
  );

  it('constructs deployed private trust but preserves network restrictions', async () => {
    const transport = createCsipTransport({
      baseUrl: 'https://partner.example/sep2', environment: 'deployed', tls: tls(),
      serverTrust: policy('https://partner.example'), resolveDns: async () => ['127.0.0.1'],
    });
    transports.push(transport);
    expect(transport.origin).toBe('https://partner.example');
    await expect(transport.get('/sep2/dcap')).rejects.toBeInstanceOf(CsipProtocolError);
    for (const address of ['10.0.0.1', '192.168.1.1', 'fc00::1']) {
      const privateTransport = createCsipTransport({
        baseUrl: 'https://partner.example', environment: 'deployed', tls: tls(),
        serverTrust: policy('https://partner.example'), resolveDns: async () => [address],
      });
      transports.push(privateTransport);
      await expect(privateTransport.get('/')).rejects.toBeInstanceOf(CsipProtocolError);
    }
    for (const baseUrl of ['https://127.0.0.1', 'http://partner.example', 'https://partner.example:8443']) {
      expect(() => createCsipTransport({
        baseUrl, environment: 'deployed', tls: tls(), serverTrust: policy(new URL(baseUrl).origin),
      })).toThrow(CsipConfigurationError);
    }
    expect(() => createCsipTransport({
      baseUrl: 'http://localhost', environment: 'local-test', tls: tls(),
      serverTrust: policy('http://localhost'),
    })).toThrow(CsipConfigurationError);
  });

  it('performs mTLS and pins the resolved address with the explicit policy', async () => {
    let authorized = false;
    const pinnedLeaf = pki.root.issue('pinned-server', 'server', 'fixture.invalid');
    const origin = (await serve(pinnedLeaf, (request, response) => {
      authorized = (request.socket as import('node:tls').TLSSocket).authorized;
      response.end('<DeviceCapability/>');
    })).replace('localhost', 'fixture.invalid');
    const response = await connect(origin).get('/sep2/dcap');
    expect(response.body).toContain('DeviceCapability');
    expect(authorized).toBe(true);
  });

  it('rejects wrong trust, an unrelated server chain, expired certificates and wrong hostnames', async () => {
    const origin = await serve();
    await expect(connect(origin, { ...tls(), certificateAuthorities: [pki.otherRoot.certificate] }).get('/'))
      .rejects.toBeInstanceOf(CsipAuthenticationError);
    for (const leaf of [
      pki.otherRoot.issue('unrelated-server', 'server'),
      pki.root.issue('expired-policy-server', 'server', 'localhost', 0),
      pki.root.issue('wrong-policy-host', 'server', 'wrong.example'),
    ]) {
      await expect(connect(await serve(leaf)).get('/')).rejects.toBeInstanceOf(CsipAuthenticationError);
    }
  });

  it('requires the server to trust the client and rejects an unauthenticated native request', async () => {
    const untrustingOrigin = await serve(serverLeaf, undefined, pki.otherRoot.certificate);
    await expect(connect(untrustingOrigin).get('/')).rejects.toBeInstanceOf(CsipAuthenticationError);
    const origin = await serve();
    await expect(new Promise((resolve, reject) => {
      const request = https.get(`${origin}/`, {
        ca: pki.root.certificate,
        lookup: (_hostname, options, callback) => options.all
          ? callback(null, [{ address: '127.0.0.1', family: 4 }])
          : callback(null, '127.0.0.1', 4),
        agent: false,
      }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
    })).rejects.toMatchObject({ code: expect.stringMatching(/^ERR_(SSL|TLS)_/) });
  });

  it('refuses cross-origin links and 302/307 redirects without contacting their target', async () => {
    let targetRequests = 0;
    const target = await serve(serverLeaf, (_request, response) => { targetRequests++; response.end('target'); });
    const origin = await serve(serverLeaf, (request, response) => {
      if (request.url === '/cached') return response.writeHead(304).end();
      const status = request.url === '/temporary' ? 307 : 302;
      response.writeHead(status, { location: request.url === '/same' ? '/target' : `${target}/target` }).end();
    });
    const transport = connect(origin);
    await expect(transport.get(`${target}/target`)).rejects.toBeInstanceOf(CsipProtocolError);
    for (const path of ['/redirect', '/temporary', '/same']) {
      await expect(transport.get(path)).rejects.toBeInstanceOf(CsipProtocolError);
    }
    expect((await transport.get('/cached')).status).toBe(304);
    expect(targetRequests).toBe(0);
  });

  it('isolates trust and agent lifetime between transports', async () => {
    const secondLeaf = pki.otherRoot.issue('second-server', 'server');
    const ports = new Set<number>();
    const firstOrigin = await serve();
    const secondOrigin = await serve(secondLeaf, (request, response) => {
      ports.add(request.socket.remotePort!);
      response.end('second');
    });
    const first = connect(firstOrigin);
    const secondTls = { ...tls(), certificateAuthorities: [pki.otherRoot.certificate] };
    const second = connect(secondOrigin, secondTls);
    expect((await first.get('/')).status).toBe(200);
    expect((await second.get('/')).body).toBe('second');
    await expect(connect(secondOrigin).get('/')).rejects.toBeInstanceOf(CsipAuthenticationError);
    await expect(connect(firstOrigin, secondTls).get('/')).rejects.toBeInstanceOf(CsipAuthenticationError);
    first.close();
    expect((await second.get('/')).body).toBe('second');
    expect(ports.size).toBe(1);
  });

  it('keeps ordinary root trust working without a policy or CA override', async () => {
    const origin = await serve();
    const temporary = await mkdtemp(join(tmpdir(), 'csip-default-trust-'));
    try {
      const caFile = join(temporary, 'root.pem');
      await writeFile(caFile, pki.root.certificate);
      const source = new URL('../src/index.ts', import.meta.url).href;
      const script = `
        import { createCsipTransport, CsipAuthenticationError } from ${JSON.stringify(source)};
        import assert from 'node:assert/strict';
        const tls = { certificate: Buffer.from(${JSON.stringify(client.certificate.toString('base64'))}, 'base64'),
          privateKey: Buffer.from(${JSON.stringify(client.privateKey.toString('base64'))}, 'base64') };
        const transport = createCsipTransport({ baseUrl: ${JSON.stringify(origin)}, environment: 'local-test',
          tls, resolveDns: async () => ['127.0.0.1'] });
        const deployed = createCsipTransport({ baseUrl: 'https://partner.example', environment: 'deployed', tls });
        const strict = createCsipTransport({ baseUrl: ${JSON.stringify(origin)}, environment: 'local-test',
          tls: { ...tls, certificateAuthorities: [Buffer.from(${JSON.stringify(pki.otherRoot.certificate.toString('base64'))}, 'base64')] },
          serverTrust: { origin: ${JSON.stringify(origin)}, kind: 'connection-ca' },
          resolveDns: async () => ['127.0.0.1'] });
        try {
          const response = await transport.get('/'); assert.equal(response.status, 200);
          await assert.rejects(strict.get('/'), CsipAuthenticationError);
        } finally { transport.close(); deployed.close(); strict.close(); }
      `;
      await expect(execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: caFile }, timeout: 10_000,
      })).resolves.toBeDefined();
      // The parent's trust was not changed by the isolated child process.
      const untrusted = createCsipTransport({
        baseUrl: origin, environment: 'local-test', tls: clientTls(), resolveDns: async () => ['127.0.0.1'],
      });
      transports.push(untrusted);
      await expect(untrusted.get('/')).rejects.toBeInstanceOf(CsipAuthenticationError);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
