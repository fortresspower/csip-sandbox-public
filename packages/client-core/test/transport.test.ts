import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import {
  createCsipTransport,
  CsipAuthenticationError,
  CsipAuthorizationError,
  CsipCircuitOpenError,
  CsipConfigurationError,
  CsipProtocolError,
  CsipResponseTooLargeError,
  CsipRetryableServerError,
  CsipTimeoutError,
  type CsipTransport,
} from '../src/index.js';
import { makeTestPki, type TestCertificate, type TestPki } from './test-certificates.js';

const closeServer = (server: http.Server | https.Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

const listen = (server: http.Server | https.Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });

describe('connection-scoped transport', () => {
  let pki: TestPki;
  let serverCertificate: TestCertificate;
  let clientCertificate: TestCertificate;
  const servers: Array<http.Server | https.Server> = [];
  const transports: CsipTransport[] = [];

  beforeAll(() => {
    pki = makeTestPki();
    serverCertificate = pki.root.issue('partner-server', 'server');
    clientCertificate = pki.root.issue('fortress-client', 'client');
  });

  afterEach(async () => {
    for (const transport of transports.splice(0)) transport.close();
    await Promise.all(servers.splice(0).map(closeServer));
  });

  afterAll(() => pki.cleanup());

  const clientTls = (client = clientCertificate) => ({
    certificate: client.certificate,
    privateKey: client.privateKey,
  });

  const localTestTls = (client = clientCertificate) => ({
    ...clientTls(client),
    certificateAuthorities: [pki.root.certificate],
  });

  async function mtlsServer(
    leaf = serverCertificate,
    handler: http.RequestListener = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/sep+xml' });
      response.end('<DeviceCapability pollRate="30"/>');
    },
  ): Promise<{ server: https.Server; port: number }> {
    const server = https.createServer({
      cert: leaf.certificate,
      key: leaf.privateKey,
      ca: pki.root.certificate,
      requestCert: true,
      rejectUnauthorized: true,
    }, handler);
    servers.push(server);
    return { server, port: await listen(server) };
  }

  const localHttpsTransport = (port: number, client = clientCertificate): CsipTransport => {
    const transport = createCsipTransport({
      baseUrl: `https://localhost:${port}`,
      environment: 'local-test',
      tls: localTestTls(client),
      resolveDns: async () => ['127.0.0.1'],
      timeoutMs: 1_000,
    });
    transports.push(transport);
    return transport;
  };

  it('performs mutual authentication and verifies the server identity', async () => {
    const { port } = await mtlsServer();
    const response = await localHttpsTransport(port).get('/sep2/dcap');
    expect(response.status).toBe(200);
    expect(response.body).toContain('DeviceCapability');
  });

  it('uses system server trust in deployed mode and confines custom CA trust to local-test', async () => {
    const deployed = createCsipTransport({
      baseUrl: 'https://partner.example',
      environment: 'deployed',
      tls: clientTls(),
      resolveDns: async () => ['93.184.216.34'],
    });
    transports.push(deployed);

    expect(deployed.origin).toBe('https://partner.example');
    expect(() => createCsipTransport({
      baseUrl: 'https://partner.example',
      environment: 'deployed',
      tls: localTestTls(),
    })).toThrow(/custom CA.*local-test/i);

    const { port } = await mtlsServer();
    expect((await localHttpsTransport(port).get('/sep2/dcap')).status).toBe(200);
  });

  it('fails closed for an untrusted client certificate', async () => {
    const { port } = await mtlsServer();
    const untrustedClient = pki.otherRoot.issue('untrusted-client', 'client');
    await expect(localHttpsTransport(port, untrustedClient).get('/sep2/dcap'))
      .rejects.toBeInstanceOf(CsipAuthenticationError);
  });

  it('fails closed for an expired or hostname-mismatched server certificate', async () => {
    const expired = pki.root.issue('expired-server', 'server', 'localhost', 0);
    const expiredServer = await mtlsServer(expired);
    await expect(localHttpsTransport(expiredServer.port).get('/sep2/dcap'))
      .rejects.toBeInstanceOf(CsipAuthenticationError);
    transports.splice(0).forEach((transport) => transport.close());
    await closeServer(expiredServer.server);
    servers.splice(servers.indexOf(expiredServer.server), 1);

    const wrongHost = pki.root.issue('wrong-host-server', 'server', 'wrong.example');
    const wrongHostServer = await mtlsServer(wrongHost);
    await expect(localHttpsTransport(wrongHostServer.port).get('/sep2/dcap'))
      .rejects.toBeInstanceOf(CsipAuthenticationError);
  });

  it('rechecks DNS and rejects non-public resolution before opening TLS', async () => {
    let resolutions = 0;
    const transport = createCsipTransport({
      baseUrl: 'https://partner.example',
      environment: 'deployed',
      tls: clientTls(),
      resolveDns: async () => {
        resolutions += 1;
        return ['127.0.0.1'];
      },
    });
    transports.push(transport);

    await expect(transport.get('/sep2/dcap')).rejects.toBeInstanceOf(CsipProtocolError);
    expect(resolutions).toBe(1);

    const unavailableDns = createCsipTransport({
      baseUrl: 'https://unavailable.example',
      environment: 'deployed',
      tls: clientTls(),
      resolveDns: async () => { throw new Error('resolver unavailable'); },
    });
    transports.push(unavailableDns);
    await expect(unavailableDns.get('/sep2/dcap')).rejects.toBeInstanceOf(CsipRetryableServerError);
  });

  it.each([
    ['private IPv4', ['10.0.0.8']],
    ['reserved IPv4', ['198.51.100.8']],
    ['private IPv6', ['fc00::8']],
    ['mixed public and private', ['93.184.216.34', '192.168.1.8']],
  ])('rejects %s DNS answers', async (_label, addresses) => {
    const transport = createCsipTransport({
      baseUrl: 'https://partner.example',
      environment: 'deployed',
      tls: clientTls(),
      resolveDns: async () => addresses,
    });
    transports.push(transport);

    await expect(transport.get('/sep2/dcap')).rejects.toBeInstanceOf(CsipProtocolError);
  });

  it('refuses IP literals, cross-origin hrefs, and redirects', async () => {
    expect(() => createCsipTransport({
      baseUrl: 'https://203.0.113.8',
      environment: 'deployed',
      tls: clientTls(),
    })).toThrow(CsipConfigurationError);
    expect(() => createCsipTransport({
      baseUrl: 'https://partner.example:8443',
      environment: 'deployed',
      tls: clientTls(),
    })).toThrow(/TCP 443/i);

    let resolutions = 0;
    const guarded = createCsipTransport({
      baseUrl: 'https://partner.example',
      environment: 'deployed',
      tls: clientTls(),
      resolveDns: async () => {
        resolutions += 1;
        return ['93.184.216.34'];
      },
    });
    transports.push(guarded);
    await expect(guarded.get('https://other.example/sep2/dcap'))
      .rejects.toBeInstanceOf(CsipProtocolError);
    await expect(guarded.get('http://[')).rejects.toBeInstanceOf(CsipProtocolError);
    expect(resolutions).toBe(0);

    const redirectServer = http.createServer((_request, response) => {
      response.writeHead(302, { location: 'https://other.example/sep2/dcap' });
      response.end();
    });
    servers.push(redirectServer);
    const port = await listen(redirectServer);
    const local = createCsipTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      environment: 'local-test',
      resolveDns: async () => ['127.0.0.1'],
    });
    transports.push(local);
    await expect(local.get('/redirect')).rejects.toBeInstanceOf(CsipProtocolError);
  });

  it('allows plaintext only for an explicit loopback local-test transport', async () => {
    expect(() => createCsipTransport({
      baseUrl: 'http://partner.example',
      environment: 'deployed',
    })).toThrow(CsipConfigurationError);
    expect(() => createCsipTransport({
      baseUrl: 'https://partner.example',
      environment: 'deployed',
      tls: {
        certificate: new Uint8Array(),
        privateKey: new Uint8Array(),
      },
    })).toThrow(CsipConfigurationError);

    const server = http.createServer((_request, response) => response.end('ok'));
    servers.push(server);
    const port = await listen(server);
    const local = createCsipTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      environment: 'local-test',
      resolveDns: async () => ['127.0.0.1'],
    });
    transports.push(local);
    expect((await local.get('/healthz')).body).toBe('ok');
  });

  it('returns typed authorization, retry, timeout, and body-limit errors', async () => {
    const server = http.createServer((request, response) => {
      if (request.url === '/forbidden') return response.writeHead(403).end('no');
      if (request.url === '/retry') return response.writeHead(503).end('later');
      if (request.url === '/large') return response.end('x'.repeat(128));
      if (request.url === '/slow') return;
      response.end('ok');
    });
    servers.push(server);
    const port = await listen(server);
    const transport = createCsipTransport({
      baseUrl: `http://localhost:${port}`,
      environment: 'local-test',
      resolveDns: async () => ['127.0.0.1'],
      timeoutMs: 250,
      maxResponseBytes: 64,
    });
    transports.push(transport);

    await expect(transport.get('/forbidden')).rejects.toBeInstanceOf(CsipAuthorizationError);
    await expect(transport.get('/retry')).rejects.toBeInstanceOf(CsipRetryableServerError);
    await expect(transport.get('/large')).rejects.toBeInstanceOf(CsipResponseTooLargeError);
    await expect(transport.get('/slow')).rejects.toBeInstanceOf(CsipTimeoutError);
  });

  it('opens a connection-scoped circuit after retryable failures and probes again after cooldown', async () => {
    let available = false;
    let requests = 0;
    const server = http.createServer((_request, response) => {
      requests += 1;
      if (!available) return response.writeHead(503).end('later');
      response.end('ok');
    });
    servers.push(server);
    const port = await listen(server);
    const transport = createCsipTransport({
      baseUrl: `http://localhost:${port}`,
      environment: 'local-test',
      resolveDns: async () => ['127.0.0.1'],
      circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 5 },
    });
    transports.push(transport);

    await expect(transport.get('/healthz')).rejects.toBeInstanceOf(CsipRetryableServerError);
    await expect(transport.get('/healthz')).rejects.toBeInstanceOf(CsipRetryableServerError);
    await expect(transport.get('/healthz')).rejects.toBeInstanceOf(CsipCircuitOpenError);
    expect(requests).toBe(2);

    available = true;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await transport.get('/healthz')).body).toBe('ok');
    expect(requests).toBe(3);
  });
});
