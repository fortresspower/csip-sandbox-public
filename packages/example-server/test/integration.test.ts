import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { makeApp } from '../src/index.js';
import { SyntheticGenerator } from '@fortress-csip/client/generator';
import { CsipClient } from '@fortress-csip/client/state-machine';
import { parseDERControlResponse } from '@fortress-csip/protocol';

let server: Server; let base: string; let store: ReturnType<typeof makeApp>['store'];

beforeAll(async () => {
  const a = makeApp(); store = a.store;
  await new Promise<void>((r) => { server = a.app.listen(0, r); });
  base = `http://localhost:${(server.address() as any).port}`;
});
afterAll(() => server.close());

describe('client <-> example-server loop', () => {
  it('a dispatched discharge control moves posted telemetry', async () => {
    store.queueControl({ mRID: 'D1', opModFixedW: -3000 });
    const lFDI = '1111111111111111111111111111111111111111';
    const gen = new SyntheticGenerator({ lFDI, nameplateW: 5000, capacityWh: 13500, initialSoC: 50 });
    const transport = httpTransport(base);
    const client = new CsipClient({
      generator: gen,
      transport,
      subscription: ['model101.W'],
      mupHref: '/mup/0',
      controlListHref: '/derp/0/derc',
    });

    await client.pollAndApplyControl();
    await client.postTelemetry();

    const readings: string[] = await (await fetch(base + '/test/meter-readings')).json();
    expect(readings.length).toBeGreaterThanOrEqual(1);
    expect(readings.some((x) => x.includes('<value>') && x.includes('-'))).toBe(true);  // negative => discharging
    const wire: Array<{ path: string; body: string }> = await (await fetch(base + '/test/wire')).json();
    const responses = wire
      .filter((entry) => entry.path === '/rsps')
      .map((entry) => parseDERControlResponse(entry.body));
    expect(responses.map((response) => response.status)).toEqual([1, 2, 3]);
    expect(responses.every((response) => response.endDeviceLFDI === lFDI && response.subject === 'D1')).toBe(true);
  });
});

function httpTransport(b: string) {
  return {
    async get(p: string) { return (await fetch(b + p)).text(); },
    async post(p: string, xml: string) { const r = await fetch(b + p, { method: 'POST', headers: { 'Content-Type': 'application/sep+xml' }, body: xml }); return { status: r.status, location: r.headers.get('location') ?? undefined }; },
    async put(p: string, xml: string) { const r = await fetch(b + p, { method: 'PUT', headers: { 'Content-Type': 'application/sep+xml' }, body: xml }); return { status: r.status }; },
  };
}
