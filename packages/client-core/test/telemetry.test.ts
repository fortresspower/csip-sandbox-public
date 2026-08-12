import {
  parseDERCapability,
  parseDERStatus,
  parseMirrorUsagePoint,
} from '@fortress-csip/protocol';
import { describe, expect, it } from 'vitest';
import {
  CsipProtocolError,
  MemorySessionStore,
  ResourceClient,
  TelemetryPublisher,
  type TelemetrySample,
} from '../src/index.js';
import { MemoryTransport } from './control-helpers.js';

const HILDA = '1111111111111111111111111111111111111111';

function telemetryGraph(transport: MemoryTransport, postRate = 120, extensionPostRate = 600): void {
  transport.getBodies.set('/graph/capability', () => `
    <DeviceCapability xmlns="urn:ieee:std:2030.5:ns" pollRate="30">
      <EndDeviceListLink href="/graph/devices"/><MirrorUsagePointListLink href="/graph/mups"/>
    </DeviceCapability>`);
  transport.getBodies.set('/graph/devices', () => `
    <EndDeviceList xmlns="urn:ieee:std:2030.5:ns" all="1" results="1">
      <EndDevice href="/graph/devices/hilda"><lFDI>${HILDA}</lFDI><DERListLink href="/graph/ders/hilda"/></EndDevice>
    </EndDeviceList>`);
  transport.getBodies.set('/graph/mups', () => `
    <MirrorUsagePointList xmlns="urn:ieee:std:2030.5:ns" all="2" results="2">
      <MirrorUsagePoint href="/posting/hilda/standard"><mRID>MUP-HILDA</mRID><postRate>${postRate}</postRate><deviceLFDI>${HILDA}</deviceLFDI></MirrorUsagePoint>
      <MirrorUsagePoint href="/posting/hilda/extensions"><mRID>fortress:hilda</mRID><postRate>${extensionPostRate}</postRate><deviceLFDI>${HILDA}</deviceLFDI></MirrorUsagePoint>
    </MirrorUsagePointList>`);
  transport.getBodies.set('/graph/ders/hilda', () => `
    <DERList xmlns="urn:ieee:std:2030.5:ns" all="1" results="1">
      <DER href="/graph/ders/hilda/main"><DERStatusLink href="/posting/hilda/status"/><DERCapabilityLink href="/posting/hilda/capability"/></DER>
    </DERList>`);
}

function fullSample(): TelemetrySample {
  return {
    timestamp: 1_725_000_000,
    activePowerW: -3_000,
    reactivePowerVar: -125,
    frequencyHz: 59.98,
    voltageV: 239.7,
    status: {
      operationalMode: 2,
      connectionStatus: 1,
      alarms: 0,
      stateOfChargePercent: 54,
      storageConnectionStatus: 1,
    },
    capability: {
      maxEnergyWh: 13_500,
      maxChargeW: 5_000,
      maxDischargeW: 5_000,
    },
    extensions: [{ mRID: 'fortress:soh', value: 98, uom: 0, powerOfTenMultiplier: 0 }],
  };
}

describe('telemetry publication', () => {
  it('discovers randomized posting resources, clamps a fast rate, and separates standard and extension lanes', async () => {
    const transport = new MemoryTransport();
    telemetryGraph(transport, 120);
    const store = new MemorySessionStore();
    const publisher = new TelemetryPublisher({
      resources: new ResourceClient({ transport, store }),
      source: { async read() { return fullSample(); } },
      now: () => 1_725_000_000,
    });

    const [profile] = await publisher.discover('/graph/capability', new Set([HILDA]));
    expect(profile).toMatchObject({
      lFDI: HILDA,
      intervalSeconds: 300,
      rateClamped: true,
      standardMupHref: '/posting/hilda/standard',
      extensionMupHref: '/posting/hilda/extensions',
      extensionIntervalSeconds: 600,
      derStatusHref: '/posting/hilda/status',
      derCapabilityHref: '/posting/hilda/capability',
    });

    expect(await publisher.publish(profile)).toEqual({ queued: 4, sent: 4, retryableFailures: 0, quarantined: 0 });
    const standard = transport.requests.find((request) => request.href === '/posting/hilda/standard')!;
    const standardMup = parseMirrorUsagePoint(standard.body!);
    expect(standardMup.deviceLFDI).toBe(HILDA);
    expect(standardMup.MirrorMeterReadings.map((reading) => reading.ReadingType.uom)).toEqual([38, 63, 33, 29]);
    expect(standardMup.MirrorMeterReadings.every((reading) => reading.Reading.timePeriod.start === 1_725_000_000)).toBe(true);

    const extension = parseMirrorUsagePoint(
      transport.requests.find((request) => request.href === '/posting/hilda/extensions')!.body!,
    );
    expect(extension.MirrorMeterReadings.map((reading) => reading.ReadingType.mRID)).toEqual(['fortress:soh']);
    expect(parseDERStatus(transport.requests.find((request) => request.href === '/posting/hilda/status')!.body!))
      .toMatchObject({ stateOfChargeStatus: { value: 54 }, alarmStatus: { value: 0 } });
    expect(parseDERCapability(transport.requests.find((request) => request.href === '/posting/hilda/capability')!.body!))
      .toMatchObject({ rtgMaxWh: 13_500, rtgMaxChargeRateW: 5_000, rtgMaxDischargeRateW: 5_000 });

    expect(await publisher.publish(profile)).toEqual({ queued: 0, sent: 0, retryableFailures: 0, quarantined: 0 });
  });

  it('schedules the standard and extension lanes at their independently advertised rates', async () => {
    const transport = new MemoryTransport();
    telemetryGraph(transport, 300);
    let clock = 1_725_000_000;
    const publisher = new TelemetryPublisher({
      resources: new ResourceClient({ transport, store: new MemorySessionStore() }),
      source: { async read() { return { ...fullSample(), timestamp: clock }; } },
      now: () => clock,
    });
    const [profile] = await publisher.discover('/graph/capability', new Set([HILDA]));

    await publisher.runDue([profile]);
    clock += 300;
    await publisher.runDue([profile]);
    expect(transport.requests.filter((request) => request.href === '/posting/hilda/standard')).toHaveLength(2);
    expect(transport.requests.filter((request) => request.href === '/posting/hilda/extensions')).toHaveLength(1);

    clock += 300;
    await publisher.runDue([profile]);
    expect(transport.requests.filter((request) => request.href === '/posting/hilda/standard')).toHaveLength(3);
    expect(transport.requests.filter((request) => request.href === '/posting/hilda/extensions')).toHaveLength(2);
  });

  it('omits unavailable optional values instead of fabricating zeros and honors a slower server rate', async () => {
    const transport = new MemoryTransport();
    telemetryGraph(transport, 900, 900);
    let clock = 1_000;
    let reads = 0;
    const store = new MemorySessionStore();
    const publisher = new TelemetryPublisher({
      resources: new ResourceClient({ transport, store }),
      source: { async read() { reads += 1; return { timestamp: clock, activePowerW: 250 }; } },
      now: () => clock,
    });
    const [profile] = await publisher.discover('/graph/capability', new Set([HILDA]));
    expect(profile).toMatchObject({ intervalSeconds: 900, rateClamped: false });

    await publisher.runDue([profile]);
    clock += 899;
    await publisher.runDue([profile]);
    expect(reads).toBe(1);
    clock += 1;
    await publisher.runDue([profile]);
    expect(reads).toBe(2);

    const standardPosts = transport.requests.filter((request) => request.href === '/posting/hilda/standard');
    const latest = parseMirrorUsagePoint(standardPosts.at(-1)!.body!);
    expect(latest.MirrorMeterReadings).toHaveLength(1);
    expect(latest.MirrorMeterReadings[0].ReadingType.uom).toBe(38);
    expect(transport.requests.some((request) => request.href === '/posting/hilda/status')).toBe(false);
    expect(transport.requests.some((request) => request.href === '/posting/hilda/capability')).toBe(false);
  });

  it('retries transient posting failures and quarantines permanent or malformed samples', async () => {
    const transport = new MemoryTransport();
    telemetryGraph(transport, 300);
    const store = new MemorySessionStore();
    let sample = fullSample();
    const publisher = new TelemetryPublisher({
      resources: new ResourceClient({ transport, store }),
      source: { async read() { return sample; } },
      now: () => 1_725_000_000,
      maxQueue: 8,
    });
    const [profile] = await publisher.discover('/graph/capability', new Set([HILDA]));

    transport.failNextPost = true;
    expect(await publisher.publish(profile)).toMatchObject({ retryableFailures: 1 });
    expect(publisher.diagnostics().pending).toBe(1);
    expect(await publisher.retryPending()).toMatchObject({ sent: 1, retryableFailures: 0 });

    transport.failNextPostWith = new CsipProtocolError('permanent rejection', 422, 'invalid');
    sample = { timestamp: 1_725_000_001, activePowerW: 100 };
    expect(await publisher.publish(profile)).toMatchObject({ quarantined: 1 });
    expect(publisher.diagnostics().quarantine).toEqual([
      expect.objectContaining({ reason: expect.stringMatching(/permanent rejection/i) }),
    ]);

    sample = { timestamp: 1_725_000_002, activePowerW: Number.NaN };
    expect(await publisher.publish(profile)).toMatchObject({ quarantined: 1, queued: 0 });
    expect(publisher.diagnostics().quarantine.at(-1)?.reason).toMatch(/activePowerW/i);
  });
});
