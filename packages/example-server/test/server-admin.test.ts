import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { runAdminCommand } from '../../../scripts/server-admin.js';
import { makePartnerApp } from '../src/partner-app.js';
import { PartnerDomain } from '../src/partner-domain.js';
import { MemoryPartnerPersistence } from '../src/persistence/memory.js';

const AGGREGATOR = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DEVICE = '1111111111111111111111111111111111111111';

describe('server-admin command layer', () => {
  it('rotates an existing connection to a replacement certificate identity', async () => {
    const domain = new PartnerDomain({ persistence: new MemoryPartnerPersistence(), now: () => 1_000 });
    await domain.createConnection('partner-a', AGGREGATOR);
    const replacement = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const output: unknown[] = [];

    await runAdminCommand(domain, [
      'connection', 'rotate', '--connection', 'partner-a', '--aggregator-lfdi', replacement,
    ], (value) => output.push(value));

    expect(output).toEqual([{ connectionId: 'partner-a', authorized: true, rotated: true }]);
    expect((await domain.connection('partner-a'))?.aggregatorLfdi).toBe(replacement);
    expect((await domain.persistence().findConnectionByAggregatorLfdi(AGGREGATOR))?.connectionId).toBe('partner-a');
    await runAdminCommand(domain, [
      'connection', 'revoke', '--connection', 'partner-a', '--aggregator-lfdi', AGGREGATOR,
    ], (value) => output.push(value));
    expect(await domain.persistence().findConnectionByAggregatorLfdi(AGGREGATOR)).toBeUndefined();
  });

  it('assigns by opaque device token and publishes only bounded controls without an HTTP admin route', async () => {
    const domain = new PartnerDomain({ persistence: new MemoryPartnerPersistence(), now: () => 1_000 });
    await domain.createConnection('partner-a', AGGREGATOR);
    await domain.createProgram('partner-a', 'dispatch', 'remote-program');
    const { device } = await domain.registerDevice('partner-a', DEVICE);
    const output: unknown[] = [];

    await runAdminCommand(domain, [
      'assignment', 'move', '--connection', 'partner-a', '--program', 'dispatch', '--device-token', device.token,
    ], (value) => output.push(value));
    await runAdminCommand(domain, [
      'control', 'publish', '--connection', 'partner-a', '--program', 'dispatch', '--mrid', 'bounded-control',
      '--start', '1000', '--duration', '300', '--fixed-w', '-3000',
    ], (value) => output.push(value));

    expect(output[0]).toEqual(expect.objectContaining({ deviceToken: device.token, assigned: true }));
    expect(JSON.stringify(output)).not.toContain(DEVICE);
    expect(await domain.controls('partner-a')).toEqual([expect.objectContaining({ mRID: 'bounded-control', opModFixedW: -3_000 })]);
  });

  it('rejects unbounded control duration and power', async () => {
    const domain = new PartnerDomain({ persistence: new MemoryPartnerPersistence(), now: () => 1_000 });
    await domain.createConnection('partner-a', AGGREGATOR);
    await domain.createProgram('partner-a', 'dispatch', 'remote-program');
    await expect(runAdminCommand(domain, [
      'control', 'publish', '--connection', 'partner-a', '--program', 'dispatch', '--mrid', 'too-long',
      '--duration', '901', '--fixed-w', '-3000',
    ])).rejects.toThrow(/duration/i);
    await expect(runAdminCommand(domain, [
      'control', 'publish', '--connection', 'partner-a', '--program', 'dispatch', '--mrid', 'too-large',
      '--duration', '300', '--fixed-w', '-5001',
    ])).rejects.toThrow(/-5000\.\.5000/i);
  });

  it('rejects controls and primacy values outside the Fortress interoperability profile', async () => {
    const domain = new PartnerDomain({ persistence: new MemoryPartnerPersistence(), now: () => 1_000 });
    await domain.createConnection('partner-a', AGGREGATOR);
    await expect(domain.createProgram('partner-a', 'invalid', 'invalid-program', 256)).rejects.toThrow(/0 and 255/i);
    await domain.createProgram('partner-a', 'dispatch', 'remote-program');

    await expect(runAdminCommand(domain, [
      'control', 'publish', '--connection', 'partner-a', '--program', 'dispatch', '--mrid', 'unsupported',
      '--fixed-w', '-1000', '--connect', 'false',
    ])).rejects.toThrow(/only --fixed-w/i);
    await expect(domain.publishControl({
      connectionId: 'partner-a',
      programId: 'dispatch',
      mRID: 'bad-response-flags',
      start: 1_000,
      duration: 300,
      opModFixedW: -1_000,
      responseRequired: '80',
    })).rejects.toThrow(/responseRequired/i);
  });

  it('publishes and cancels an event through the same domain operations the bridge uses', async () => {
    const now = () => 1_000;
    const domain = new PartnerDomain({ persistence: new MemoryPartnerPersistence({ now }), now });
    await domain.createConnection('partner-a', AGGREGATOR);
    await domain.registerDevice('partner-a', DEVICE);
    const output: unknown[] = [];

    await runAdminCommand(domain, [
      'event', 'publish', '--connection', 'partner-a', '--request', 'req-1', '--event', 'ev1',
      '--target', DEVICE, '--start', '1200', '--duration', '300', '--fixed-w', '-3000',
    ], (value) => output.push(value));
    await runAdminCommand(domain, [
      'event', 'cancel', '--connection', 'partner-a', '--request', 'req-c', '--event', 'ev1',
    ], (value) => output.push(value));

    expect(output[0]).toEqual(expect.objectContaining({ eventId: 'ev1', programId: 'evt-ev1', currentStatus: 1 }));
    expect(output[1]).toEqual(expect.objectContaining({ eventId: 'ev1', currentStatus: 2 }));
    expect(await domain.controls('partner-a')).toEqual([
      expect.objectContaining({ mRID: 'evt-ev1', currentStatus: 2, opModFixedW: -3_000 }),
    ]);
  });

  it('refuses an event publish that names more than one target', async () => {
    const now = () => 1_000;
    const domain = new PartnerDomain({ persistence: new MemoryPartnerPersistence({ now }), now });
    await domain.createConnection('partner-a', AGGREGATOR);
    await domain.registerDevice('partner-a', DEVICE);

    await expect(runAdminCommand(domain, [
      'event', 'publish', '--connection', 'partner-a', '--request', 'req-1', '--event', 'ev1',
      '--target', DEVICE, '--target', DEVICE, '--start', '1200', '--duration', '300', '--fixed-w', '-3000',
    ])).rejects.toThrow(/more than once/i);

    expect(await domain.controls('partner-a')).toEqual([]);
  });

  it('leaves the partner-mode server without any operator or admin HTTP route', async () => {
    const { app } = makePartnerApp({
      persistence: new MemoryPartnerPersistence(),
      resolveConnection: () => 'partner-a',
      now: () => 1_000,
    });

    for (const path of ['/test/reset', '/test/dercontrol', '/admin/event', '/event/publish']) {
      expect((await request(app).post(path).send({})).status).toBe(404);
    }
    expect((await request(app).get('/healthz')).status).toBe(200);
  });

  it('keeps a terminal control terminal instead of rewriting its lifecycle', async () => {
    const now = () => 1_000;
    const domain = new PartnerDomain({ persistence: new MemoryPartnerPersistence({ now }), now });
    await domain.createConnection('partner-a', AGGREGATOR);
    await domain.registerDevice('partner-a', DEVICE);
    await domain.publishEventCommand({
      connectionId: 'partner-a', requestId: 'req-1', eventId: 'ev1',
      targetLfdi: DEVICE, start: 1_200, duration: 300, opModFixedW: -3_000,
    });
    await domain.completeControl('partner-a', 'evt-ev1', 2);

    await expect(domain.completeControl('partner-a', 'evt-ev1', 1)).rejects.toThrow(/already terminal/i);
    await expect(domain.completeControl('partner-a', 'evt-ev1', 9)).rejects.toThrow(/between 0 and 4/i);

    expect(await domain.controls('partner-a')).toEqual([expect.objectContaining({
      currentStatus: 2, start: 1_200, duration: 300, opModFixedW: -3_000, programId: 'evt-ev1',
    })]);
  });
});
