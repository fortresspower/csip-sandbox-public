import { describe, expect, it } from 'vitest';
import { runAdminCommand } from '../../../scripts/server-admin.js';
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
});
