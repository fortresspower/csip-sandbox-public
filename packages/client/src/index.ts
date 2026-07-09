import { loadConfig } from './config.js';
import { SyntheticGenerator } from './generator.js';
import { CsipClient, type Transport } from './state-machine.js';
import { startInspect } from './inspect.js';

const httpTransport = (base: string): Transport => ({
  async get(path) { const r = await fetch(base + path, { headers: { Accept: 'application/sep+xml' } }); return r.text(); },
  async post(path, xml) { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/sep+xml' }, body: xml }); return { status: r.status, location: r.headers.get('location') ?? undefined }; },
  async put(path, xml) { const r = await fetch(base + path, { method: 'PUT', headers: { 'Content-Type': 'application/sep+xml' }, body: xml }); return { status: r.status }; },
});

async function main() {
  const cfg = loadConfig();
  const gen = new SyntheticGenerator({ lFDI: 'SANDBOX-SITE-1', nameplateW: 5000, capacityWh: 13500, initialSoC: 50 });
  const state: { lastControl?: string; lastPostAt?: number } = {};
  // KNOWN FOLLOW-UP: the client posts all lanes (both standard and fortress extension points) to
  // /mup/0. As a result, live fortress-lane readings land on mup 0 rather than mup 1. The
  // boot-time backfill still demonstrates the /mup/1 split correctly. A future enhancement would
  // split postTelemetry() to POST fortress-tier points to /mup/1.
  const client = new CsipClient({ generator: gen, transport: httpTransport(cfg.serverUrl), subscription: cfg.subscription, mupHref: '/mup/0', onControlApplied: (label) => { state.lastControl = label; } });

  setInterval(() => { gen.step(5); }, 5000);

  // Retunable cadence: the console can change or stop the poll/post loops at runtime via the
  // inspect control endpoint (a sandbox affordance — NOT part of the IEEE 2030.5 surface). 0 = off.
  const cadence = { controlPollSec: cfg.controlPollSec, telemetryPostSec: cfg.telemetryPostSec };
  let controlIv: ReturnType<typeof setInterval> | null = null;
  let postIv: ReturnType<typeof setInterval> | null = null;
  const reschedule = () => {
    if (controlIv) { clearInterval(controlIv); controlIv = null; }
    if (postIv) { clearInterval(postIv); postIv = null; }
    if (cadence.controlPollSec > 0) controlIv = setInterval(() => client.pollAndApplyControl().catch((e) => console.error('[control]', e)), cadence.controlPollSec * 1000);
    if (cadence.telemetryPostSec > 0) postIv = setInterval(() => client.postTelemetry().then(() => (state.lastPostAt = Date.now())).catch((e) => console.error('[telemetry]', e)), cadence.telemetryPostSec * 1000);
  };
  reschedule();

  startInspect(cfg.inspectPort, gen, state, {
    getCadence: () => ({ controlPollSec: cadence.controlPollSec, telemetryPostSec: cadence.telemetryPostSec }),
    setCadence: (patch) => {
      if (patch.controlPollSec !== undefined) cadence.controlPollSec = Math.max(0, Number(patch.controlPollSec));
      if (patch.telemetryPostSec !== undefined) cadence.telemetryPostSec = Math.max(0, Number(patch.telemetryPostSec));
      reschedule();
    },
  });
  console.log(`[client] running against ${cfg.serverUrl}`);
}
main();
