import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import request from 'supertest';
import {
  AssignmentDiscovery,
  createCsipTransport,
  CsipSession,
  EndDeviceEnrollment,
  MemorySessionStore,
  ResourceClient,
  TelemetryPublisher,
  type ControlIntent,
} from '@fortress-csip/client-core';
import { makePartnerApp } from '../src/partner-app.js';
import { createMemoryPersistenceState, MemoryPartnerPersistence } from '../src/persistence/memory.js';
import type { PartnerPersistence } from '../src/persistence/port.js';

const AGGREGATOR = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HILDA = '1111111111111111111111111111111111111111';
const LAB = '2222222222222222222222222222222222222222';
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('production-shaped partner loop', () => {
  it('discovers variable paths, enrolls devices, follows assignment moves, and records responses and telemetry', async () => {
    let clock = 1_725_000_000;
    const state = createMemoryPersistenceState();
    const persistence = new MemoryPartnerPersistence({ state, now: () => clock });
    const { app, domain } = makePartnerApp({ persistence, resolveConnection: () => 'partner-a', now: () => clock });
    await domain.createConnection('partner-a', AGGREGATOR);
    await domain.createProgram('partner-a', 'dispatch', 'remote-dispatch', 3);
    const server = await listen(app);
    const baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
    const transport = createCsipTransport({
      baseUrl,
      environment: 'local-test',
      resolveDns: async () => ['127.0.0.1'],
    });
    const sessionStore = new MemorySessionStore();
    const resources = new ResourceClient({ transport, store: sessionStore });
    const enrollment = new EndDeviceEnrollment({ resources, store: sessionStore });

    const hilda = await enrollment.reconcile('/sep2/capability', HILDA);
    const lab = await enrollment.reconcile('/sep2/capability', LAB);
    expect(hilda.href).not.toMatch(/\/\d+(?:\/|$)/);
    expect(lab.href).not.toBe(hilda.href);
    await domain.moveAssignment('partner-a', 'dispatch', HILDA);

    const discovery = new AssignmentDiscovery({ resources, store: sessionStore });
    let snapshot = await discovery.reconcile('/sep2/capability', new Set([HILDA, LAB]));
    expect(snapshot.devices.find((device) => device.lFDI === HILDA)?.programs).toHaveLength(1);
    expect(snapshot.devices.find((device) => device.lFDI === LAB)?.programs).toHaveLength(0);

    await domain.publishControl({
      connectionId: 'partner-a',
      programId: 'dispatch',
      mRID: 'hilda-discharge',
      start: clock,
      duration: 300,
      opModFixedW: -3_000,
    });
    const dispatched: ControlIntent[] = [];
    const session = new CsipSession({
      connectionId: 'partner-a',
      resources,
      store: sessionStore,
      now: () => clock,
      sink: {
        async dispatch(intent) { dispatched.push(intent); },
        async updateLifecycle() {},
      },
    });
    expect(await session.runOnce(snapshot)).toMatchObject({ delivered: [expect.objectContaining({ wireMrid: 'hilda-discharge' })] });
    expect(dispatched[0].assignedLFDIs).toEqual([HILDA]);
    await session.recordOutcome(dispatched[0].internalEventId, 'started');
    await session.recordOutcome(dispatched[0].internalEventId, 'completed');
    expect(await session.flushResponses()).toEqual({ sent: 2, failed: 0 });

    const telemetry = new TelemetryPublisher({
      resources,
      source: {
        async read(lFDI) {
          return { timestamp: clock, activePowerW: -2_850, status: { stateOfChargePercent: 49 }, extensions: [{ mRID: 'fortress:soh', value: 98, uom: 0 }] };
        },
      },
      now: () => clock,
    });
    const [profile] = await telemetry.discover('/sep2/capability', new Set([HILDA]));
    expect(await telemetry.publish(profile)).toMatchObject({ sent: 3, quarantined: 0 });
    expect((await domain.responses('partner-a')).map((entry) => entry.category)).toEqual(expect.arrayContaining([
      'status-1', 'status-2', 'status-3',
    ]));
    const responseHref = dispatched[0].replyTo!;
    await resources.postControlResponse(responseHref, {
      createdDateTime: clock,
      endDeviceLFDI: HILDA,
      status: 3,
      subject: 'hilda-discharge',
    });
    expect(await domain.responses('partner-a')).toHaveLength(3);
    expect((await domain.telemetry('partner-a')).map((entry) => entry.category)).toEqual(expect.arrayContaining([
      'mup-standard', 'mup-extensions', 'der-status',
    ]));

    await domain.moveAssignment('partner-a', 'dispatch', LAB);
    clock += 300;
    snapshot = await discovery.reconcile('/sep2/capability', new Set([HILDA, LAB]));
    expect(snapshot.devices.find((device) => device.lFDI === HILDA)?.programs).toHaveLength(0);
    expect(snapshot.devices.find((device) => device.lFDI === LAB)?.programs).toHaveLength(1);
    await domain.publishControl({
      connectionId: 'partner-a',
      programId: 'dispatch',
      mRID: 'lab-charge',
      start: clock,
      duration: 300,
      opModFixedW: 1_000,
    });
    await session.runOnce(snapshot);
    expect(dispatched.at(-1)).toMatchObject({ wireMrid: 'lab-charge', assignedLFDIs: [LAB] });
    transport.close();
  });

  it('exposes only health and authenticated SEP resources on the production app', async () => {
    const persistence = new MemoryPartnerPersistence();
    const authorized = makePartnerApp({ persistence, resolveConnection: () => 'partner-a' });
    await authorized.domain.createConnection('partner-a', AGGREGATOR);
    expect((await request(authorized.app).get('/healthz')).body).toEqual({ status: 'ok' });
    expect((await request(authorized.app).get('/')).status).toBe(404);
    expect((await request(authorized.app).get('/test/controls')).status).toBe(404);
    expect((await request(authorized.app).post('/test/dercontrol')).status).toBe(404);

    const unauthenticated = makePartnerApp({ persistence, resolveConnection: () => undefined });
    expect((await request(unauthenticated.app).get('/sep2/capability')).status).toBe(401);
  });

  it('cannot use one authenticated connection to post against another connection resource', async () => {
    const persistence = new MemoryPartnerPersistence();
    const { app, domain } = makePartnerApp({
      persistence,
      resolveConnection: (incoming) => incoming.header('x-test-connection'),
    });
    await domain.createConnection('partner-a', AGGREGATOR);
    await domain.createConnection('partner-b', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const { device } = await domain.registerDevice('partner-a', HILDA);
    const status = '<DERStatus xmlns="urn:ieee:std:2030.5:ns"><readingTime>1</readingTime></DERStatus>';

    expect((await request(app).put(`/sep2/r/${device.token}/status`)
      .set('x-test-connection', 'partner-b')
      .set('Content-Type', 'application/sep+xml')
      .send(status)).status).toBe(404);
    expect(await domain.telemetry('partner-a')).toHaveLength(0);
    expect(await domain.telemetry('partner-b')).toHaveLength(0);
  });

  it('expires a control after a terminal declined response', async () => {
    let clock = 100;
    const persistence = new MemoryPartnerPersistence({ now: () => clock });
    const { app, domain } = makePartnerApp({
      persistence,
      resolveConnection: () => 'partner-a',
      now: () => clock,
      retention: { historySeconds: 30 },
    });
    await domain.createConnection('partner-a', AGGREGATOR);
    const program = await domain.createProgram('partner-a', 'dispatch', 'remote-dispatch');
    await domain.registerDevice('partner-a', HILDA);
    await domain.moveAssignment('partner-a', 'dispatch', HILDA);
    await domain.publishControl({
      connectionId: 'partner-a',
      programId: 'dispatch',
      mRID: 'declined-control',
      start: clock,
      duration: 300,
      opModFixedW: -500,
    });

    const response = await request(app)
      .post(`/sep2/r/${program.token}/responses`)
      .set('Content-Type', 'application/sep+xml')
      .send(`<?xml version="1.0"?><DERControlResponse xmlns="urn:ieee:std:2030.5:ns">
        <createdDateTime>${clock}</createdDateTime><endDeviceLFDI>${HILDA}</endDeviceLFDI>
        <status>4</status><subject>declined-control</subject></DERControlResponse>`);
    expect(response.status).toBe(201);

    clock = 131;
    expect(await domain.controls('partner-a')).toHaveLength(0);
  });

  it('redacts unexpected persistence failures as server errors', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new Error('DynamoDB table secret-name throttled');
    failure.name = 'ThrottlingException';
    const broken = {
      async get() { throw failure; },
      async list() { throw failure; },
      async put() { throw failure; },
      async delete() { throw failure; },
      async createConnectionWithIdentity() { throw failure; },
      async authorizeConnectionIdentity() { throw failure; },
      async revokeConnectionIdentity() { throw failure; },
      async findConnectionByAggregatorLfdi() { throw failure; },
    } as PartnerPersistence;
    const { app } = makePartnerApp({ persistence: broken, resolveConnection: () => 'partner-a' });
    const response = await request(app).get('/sep2/capability');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'internal server error' });
    expect(response.text).not.toContain('secret-name');
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('"category":"persistence_throttled"'));
    logged.mockRestore();
  });

  it('supports bounded list pagination without numeric resource identities', async () => {
    const persistence = new MemoryPartnerPersistence();
    const { app, domain } = makePartnerApp({ persistence, resolveConnection: () => 'partner-a' });
    await domain.createConnection('partner-a', AGGREGATOR);
    await domain.registerDevice('partner-a', HILDA);
    await domain.registerDevice('partner-a', LAB);
    const capability = await request(app).get('/sep2/capability');
    const listHref = /EndDeviceListLink href="([^"]+)"/.exec(capability.text)?.[1];
    expect(listHref).toMatch(/^\/sep2\/r\/c-[0-9a-f]+\/devices$/);
    const first = await request(app).get(`${listHref}?s=0&l=1`);
    expect(first.text).toContain('all="2"');
    expect(first.text).toContain('results="1"');
    expect(first.text).toContain('rel="next"');
    expect(first.text).toContain('s=1&amp;l=1');
  });
});

async function listen(app: ReturnType<typeof makePartnerApp>['app']): Promise<Server> {
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  servers.push(server);
  return server;
}
