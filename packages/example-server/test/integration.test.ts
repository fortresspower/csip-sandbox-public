import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { makeApp } from '../src/index.js';
import { SyntheticGenerator } from '@fortress-csip/client/generator';
import { CsipClient } from '@fortress-csip/client/state-machine';

let server: Server; let base: string; let store: ReturnType<typeof makeApp>['store'];

beforeAll(async () => {
  const a = makeApp(); store = a.store;
  await new Promise<void>((r) => { server = a.app.listen(0, r); });
  base = `http://localhost:${(server.address() as any).port}`;
});
afterAll(() => server.close());

describe('client <-> example-server loop', () => {
  it('discovers the configured EndDevice assignment graph before using the existing control route', async () => {
    const dcap = await (await fetch(base + '/dcap')).text();
    expect(dcap).toContain('EndDeviceListLink');
    const endDevices = await (await fetch(base + '/edev')).text();
    expect(endDevices).toContain('href="/edev/0"');
    const endDevice = await (await fetch(base + '/edev/0')).text();
    expect(endDevice).toContain('href="/edev/0/fsa"');
    const assignments = await (await fetch(base + '/edev/0/fsa/0/derp')).text();
    expect(assignments).toContain('href="/derp/0"');
    const program = await (await fetch(base + '/derp/0')).text();
    expect(program).toContain('href="/derp/0/derc"');
  });

  it('a dispatched discharge control moves posted telemetry', async () => {
    store.queueControl({ mRID: 'D1', opModFixedW: -3000 });
    const gen = new SyntheticGenerator({ lFDI: 'S', nameplateW: 5000, capacityWh: 13500, initialSoC: 50 });
    const transport = httpTransport(base);
    const client = new CsipClient({ generator: gen, transport, subscription: ['model101.W'], mupHref: '/mup/0' });

    await client.pollAndApplyControl();
    await client.postTelemetry();

    const readings: string[] = await (await fetch(base + '/test/meter-readings')).json();
    expect(readings.length).toBeGreaterThanOrEqual(1);
    expect(readings.some((x) => x.includes('<value>') && x.includes('-'))).toBe(true);  // negative => discharging
  });
});

function httpTransport(b: string) {
  return {
    async get(p: string) { return (await fetch(b + p)).text(); },
    async post(p: string, xml: string) { const r = await fetch(b + p, { method: 'POST', headers: { 'Content-Type': 'application/sep+xml' }, body: xml }); return { status: r.status, location: r.headers.get('location') ?? undefined }; },
    async put(p: string, xml: string) { const r = await fetch(b + p, { method: 'PUT', headers: { 'Content-Type': 'application/sep+xml' }, body: xml }); return { status: r.status }; },
  };
}
