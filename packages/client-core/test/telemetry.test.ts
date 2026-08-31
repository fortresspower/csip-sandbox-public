import {
  parseDERCapability,
  parseDERStatus,
  parseMirrorUsagePoint,
} from '@fortress-csip/protocol';
import { describe, expect, it } from 'vitest';
import {
  CsipRetryableServerError,
  CsipProtocolError,
  MemorySessionStore,
  ResourceClient,
  TelemetryPublisher,
  type TelemetrySample,
  type CsipRequestOptions,
  type CsipResponse,
  type CsipTransport,
  type TelemetryProfile,
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
  it('indexes fleet routes once and deduplicates bounded DER discovery reads', async () => {
    class TrackingTransport extends MemoryTransport {
      activeDerReads = 0;
      maxActiveDerReads = 0;

      override async request(
        method: 'GET' | 'POST' | 'PUT' | 'DELETE',
        href: string,
        options: CsipRequestOptions = {},
      ): Promise<CsipResponse> {
        const path = new URL(href, this.origin).pathname;
        if (method === 'GET' && path.startsWith('/graph/ders/')) {
          this.activeDerReads += 1;
          this.maxActiveDerReads = Math.max(this.maxActiveDerReads, this.activeDerReads);
          await new Promise((resolve) => setTimeout(resolve, 3));
          this.activeDerReads -= 1;
        }
        return super.request(method, href, options);
      }
    }
    const transport = new TrackingTransport();
    const lFDIs = Array.from({ length: 12 }, (_, index) => (index + 32).toString(16).padStart(40, '0'));
    transport.getBodies.set('/graph/capability', () => `
      <DeviceCapability xmlns="urn:ieee:std:2030.5:ns" pollRate="30">
        <EndDeviceListLink href="/graph/devices"/><MirrorUsagePointListLink href="/graph/mups"/>
      </DeviceCapability>`);
    transport.getBodies.set('/graph/devices', () => `
      <EndDeviceList xmlns="urn:ieee:std:2030.5:ns" all="${lFDIs.length}" results="${lFDIs.length}">
        ${lFDIs.map((lFDI, index) => `<EndDevice href="/graph/device/${lFDI}"><lFDI>${lFDI}</lFDI><DERListLink href="/graph/ders/${index % 6}"/></EndDevice>`).join('')}
      </EndDeviceList>`);
    transport.getBodies.set('/graph/mups', () => `
      <MirrorUsagePointList xmlns="urn:ieee:std:2030.5:ns" all="${lFDIs.length}" results="${lFDIs.length}">
        ${lFDIs.map((lFDI) => `<MirrorUsagePoint href="/posting/${lFDI}"><mRID>mup-${lFDI}</mRID><postRate>300</postRate><deviceLFDI>${lFDI}</deviceLFDI></MirrorUsagePoint>`).join('')}
      </MirrorUsagePointList>`);
    for (let index = 0; index < 6; index += 1) {
      transport.getBodies.set(`/graph/ders/${index}`, () => `
        <DERList xmlns="urn:ieee:std:2030.5:ns" all="1" results="1">
          <DER href="/graph/der/${index}"><DERStatusLink href="/posting/status/${index}"/></DER>
        </DERList>`);
    }
    const publisher = new TelemetryPublisher({
      resources: new ResourceClient({ transport, store: new MemorySessionStore() }),
      source: { async read() { return { timestamp: 1 }; } },
      concurrency: 3,
    });

    await expect(publisher.discover('/graph/capability', new Set(lFDIs))).resolves.toHaveLength(lFDIs.length);
    const derRequests = transport.requests.filter((request) => request.method === 'GET' && request.href.startsWith('/graph/ders/'));
    expect(derRequests).toHaveLength(6);
    expect(transport.maxActiveDerReads).toBe(3);
  });

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

    expect(await publisher.publish(profile)).toEqual({ queued: 4, sent: 4, retryableFailures: 0, quarantined: 0, backpressured: 0 });
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

    expect(await publisher.publish(profile)).toEqual({ queued: 0, sent: 0, retryableFailures: 0, quarantined: 0, backpressured: 0 });
  });

  it('schedules the standard and extension lanes at their independently advertised rates', async () => {
    const transport = new MemoryTransport();
    telemetryGraph(transport, 300);
    let clock = 1_725_000_000;
    const publisher = new TelemetryPublisher({
      resources: new ResourceClient({ transport, store: new MemorySessionStore() }),
      source: { async read() { return { ...fullSample(), timestamp: clock }; } },
      now: () => clock,
      staggerInitialRun: false,
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
      staggerInitialRun: false,
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

  it('deterministically staggers both lanes, avoids a startup burst, and serves every profile within its interval', async () => {
    const makeProfiles = (): TelemetryProfile[] => Array.from({ length: 100 }, (_, index) => {
      const lFDI = (index + 500).toString(16).padStart(40, '0');
      return {
        lFDI,
        intervalSeconds: 300,
        rateClamped: false,
        standardMupHref: `/posting/${lFDI}/standard`,
        standardMupMrid: `mup-${lFDI}`,
        extensionMupHref: `/posting/${lFDI}/extension`,
        extensionMupMrid: `fortress:mup-${lFDI}`,
        extensionIntervalSeconds: 600,
      };
    });
    const runRamp = async () => {
      let clock = 0;
      const transport = new MemoryTransport();
      const publisher = new TelemetryPublisher({
        resources: new ResourceClient({ transport, store: new MemorySessionStore() }),
        source: {
          async read() {
            return { timestamp: clock, activePowerW: 1, extensions: [{ mRID: 'fortress:test', value: 1, uom: 0 }] };
          },
        },
        now: () => clock,
      });
      const profiles = makeProfiles();
      expect(await publisher.runDue(profiles)).toMatchObject({ sent: 0, queued: 0 });
      clock = 60;
      await publisher.runDue(profiles);
      const firstMinute = transport.requests.filter((request) => request.method === 'POST').map((request) => request.href);
      expect(firstMinute.length).toBeGreaterThan(0);
      expect(firstMinute.length).toBeLessThan(profiles.length);
      clock = 300;
      await publisher.runDue(profiles);
      const standard = new Set(transport.requests.filter((request) => request.href.endsWith('/standard')).map((request) => request.href));
      expect(standard.size).toBe(profiles.length);
      clock = 600;
      await publisher.runDue(profiles);
      const extensions = new Set(transport.requests.filter((request) => request.href.endsWith('/extension')).map((request) => request.href));
      expect(extensions.size).toBe(profiles.length);
      return firstMinute;
    };

    expect(await runRamp()).toEqual(await runRamp());
  });

  it('streams due profiles through bounded source and send concurrency without filling the queue', async () => {
    let activeReads = 0;
    let maxActiveReads = 0;
    let activeSends = 0;
    let maxActiveSends = 0;
    let sends = 0;
    const transport: CsipTransport = {
      origin: 'https://partner.example',
      async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', href: string, options?: CsipRequestOptions): Promise<CsipResponse> {
        void href;
        void options;
        if (method === 'GET') throw new Error('unexpected GET');
        activeSends += 1;
        maxActiveSends = Math.max(maxActiveSends, activeSends);
        await new Promise((resolve) => setTimeout(resolve, 3));
        activeSends -= 1;
        sends += 1;
        return { status: 201, headers: {}, body: '' };
      },
      get(href) { return this.request('GET', href); },
      post(href, body) { return this.request('POST', href, { body }); },
      put(href, body) { return this.request('PUT', href, { body }); },
      close() {},
    };
    const lFDIs = Array.from({ length: 20 }, (_, index) => index.toString(16).padStart(40, '0'));
    const profiles: TelemetryProfile[] = lFDIs.map((lFDI) => ({
      lFDI,
      intervalSeconds: 300,
      rateClamped: false,
      standardMupHref: `/posting/${lFDI}`,
      standardMupMrid: `mup-${lFDI}`,
    }));
    const publisher = new TelemetryPublisher({
      resources: new ResourceClient({ transport, store: new MemorySessionStore() }),
      source: {
        async read(lFDI) {
          activeReads += 1;
          maxActiveReads = Math.max(maxActiveReads, activeReads);
          await new Promise((resolve) => setTimeout(resolve, 3));
          activeReads -= 1;
          return { timestamp: 1, activePowerW: Number.parseInt(lFDI.slice(-2), 16) };
        },
      },
      concurrency: 3,
      workBatchSize: 5,
      maxQueue: 12,
      staggerInitialRun: false,
    });

    await expect(publisher.runDue(profiles)).resolves.toEqual({
      queued: profiles.length,
      sent: profiles.length,
      retryableFailures: 0,
      quarantined: 0,
      backpressured: 0,
    });
    expect(maxActiveReads).toBe(3);
    expect(maxActiveSends).toBe(3);
    expect(sends).toBe(profiles.length);
    expect(publisher.diagnostics().pending).toBe(0);
  });

  it('rejects an oversized direct publication roster before reading or sending', async () => {
    let reads = 0;
    const transport = new MemoryTransport();
    const publisher = new TelemetryPublisher({
      resources: new ResourceClient({ transport, store: new MemorySessionStore() }),
      source: { async read() { reads += 1; return { timestamp: 1, activePowerW: 1 }; } },
      maxProfiles: 1,
    });
    const profiles: TelemetryProfile[] = [HILDA, '2222222222222222222222222222222222222222'].map((lFDI) => ({
      lFDI,
      intervalSeconds: 300,
      rateClamped: false,
      standardMupHref: `/posting/${lFDI}`,
      standardMupMrid: `mup-${lFDI}`,
    }));

    await expect(publisher.runDue(profiles)).rejects.toThrow(/1-profile limit/i);
    expect(reads).toBe(0);
    expect(transport.requests).toHaveLength(0);
  });

  it('claims pending jobs so concurrent retry calls never duplicate a send', async () => {
    let attempts = 0;
    let fail = true;
    const transport: CsipTransport = {
      origin: 'https://partner.example',
      async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE'): Promise<CsipResponse> {
        if (method === 'GET') throw new Error('unexpected GET');
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (fail) {
          fail = false;
          throw new CsipRetryableServerError(method, '/posting/hilda', 503, 'retry');
        }
        return { status: 201, headers: {}, body: '' };
      },
      get(href) { return this.request('GET', href); },
      post(href, body) { return this.request('POST', href, { body }); },
      put(href, body) { return this.request('PUT', href, { body }); },
      close() {},
    };
    const publisher = new TelemetryPublisher({
      resources: new ResourceClient({ transport, store: new MemorySessionStore() }),
      source: { async read() { return { timestamp: 1, activePowerW: 1 }; } },
      concurrency: 2,
    });
    const profile: TelemetryProfile = {
      lFDI: HILDA,
      intervalSeconds: 300,
      rateClamped: false,
      standardMupHref: '/posting/hilda',
      standardMupMrid: 'mup-hilda',
    };

    await expect(publisher.publish(profile)).resolves.toMatchObject({ retryableFailures: 1 });
    await Promise.all([publisher.retryPending(), publisher.retryPending()]);
    expect(attempts).toBe(2);
    expect(publisher.diagnostics().pending).toBe(0);
  });

  it('keeps unscheduled jobs recoverable when an abort interrupts a bounded drain', async () => {
    let sends = 0;
    const transport: CsipTransport = {
      origin: 'https://partner.example',
      async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE'): Promise<CsipResponse> {
        if (method === 'GET') throw new Error('unexpected GET');
        await new Promise((resolve) => setTimeout(resolve, 10));
        sends += 1;
        return { status: 201, headers: {}, body: '' };
      },
      get(href) { return this.request('GET', href); },
      post(href, body) { return this.request('POST', href, { body }); },
      put(href, body) { return this.request('PUT', href, { body }); },
      close() {},
    };
    const profiles: TelemetryProfile[] = Array.from({ length: 20 }, (_, index) => {
      const lFDI = (index + 100).toString(16).padStart(40, '0');
      return {
        lFDI,
        intervalSeconds: 300,
        rateClamped: false,
        standardMupHref: `/posting/${lFDI}`,
        standardMupMrid: `mup-${lFDI}`,
      };
    });
    const publisher = new TelemetryPublisher({
      resources: new ResourceClient({ transport, store: new MemorySessionStore() }),
      source: { async read() { return { timestamp: 1, activePowerW: 1 }; } },
      concurrency: 4,
      workBatchSize: 20,
      maxQueue: 80,
      staggerInitialRun: false,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('stop test')), 1);

    await expect(publisher.runDue(profiles, { signal: controller.signal })).rejects.toThrow('stop test');
    expect(publisher.diagnostics().pending).toBeGreaterThan(0);
    const sentBeforeRecovery = sends;
    const recovered = await publisher.retryPending();
    expect(recovered.sent).toBe(20 - sentBeforeRecovery);
    expect(publisher.diagnostics().pending).toBe(0);
    expect(sends).toBe(20);
  });
});
