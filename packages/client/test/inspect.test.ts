import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { SyntheticGenerator } from '../src/generator.js';
import { makeInspectApp } from '../src/inspect.js';

let server: Server | undefined;
afterEach(() => server?.close());

describe('inspect /status', () => {
  it('returns the snapshot with permissive CORS for the browser console', async () => {
    const gen = new SyntheticGenerator({ lFDI: 'S', nameplateW: 5000, capacityWh: 13500, initialSoC: 50 });
    const app = makeInspectApp(gen, { lastControl: 'CTL-1: fixedW=-3000', lastPostAt: 123 });
    await new Promise<void>((r) => { server = app.listen(0, () => r()); });
    const port = (server!.address() as { port: number }).port;

    const res = await fetch(`http://localhost:${port}/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    const body = await res.json();
    expect(body.snapshot.lFDI).toBe('S');
    expect(body.lastControl).toBe('CTL-1: fixedW=-3000');
  });

  it('reports cadence in /status and retunes it via POST /control/cadence', async () => {
    const gen = new SyntheticGenerator({ lFDI: 'S', nameplateW: 5000, capacityWh: 13500, initialSoC: 50 });
    let cadence = { controlPollSec: 10, telemetryPostSec: 10 };
    const control = { getCadence: () => cadence, setCadence: (p: Partial<typeof cadence>) => { cadence = { ...cadence, ...p }; } };
    const app = makeInspectApp(gen, {}, control);
    await new Promise<void>((r) => { server = app.listen(0, () => r()); });
    const port = (server!.address() as { port: number }).port;

    const s1 = await (await fetch(`http://localhost:${port}/status`)).json();
    expect(s1.cadence).toEqual({ controlPollSec: 10, telemetryPostSec: 10 });

    const res = await fetch(`http://localhost:${port}/control/cadence`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ controlPollSec: 0, telemetryPostSec: 3 }) });
    expect(res.status).toBe(204);

    const s2 = await (await fetch(`http://localhost:${port}/status`)).json();
    expect(s2.cadence).toEqual({ controlPollSec: 0, telemetryPostSec: 3 });
  });
});
