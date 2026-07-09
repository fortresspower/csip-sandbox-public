import express from 'express';
import type { SyntheticGenerator } from './generator.js';

export interface Cadence { controlPollSec: number; telemetryPostSec: number; }
/** Sandbox-only handle so the console can read and retune the client's loop cadence at runtime.
 *  This is NOT part of the IEEE 2030.5 surface — it's a dev affordance, like the server's /test/*. */
export interface Control { getCadence(): Cadence; setCadence(patch: Partial<Cadence>): void; }

export function makeInspectApp(gen: SyntheticGenerator, state: { lastControl?: string; lastPostAt?: number }, control?: Control) {
  const app = express();
  // CORS so the browser console (served from the example-server origin) can read /status and POST control.
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
    next();
  });
  app.options('*', (_req, res) => res.status(204).end());   // CORS preflight for POST /control/cadence
  app.use(express.json());
  app.get('/status', (_req, res) => res.json({
    snapshot: gen.snapshot(), lastControl: state.lastControl ?? null, lastPostAt: state.lastPostAt ?? null,
    ...(control ? { cadence: control.getCadence() } : {}),
  }));
  // Sandbox-only: retune or stop the live poll/post loops from the console (not IEEE 2030.5).
  app.post('/control/cadence', (req, res) => { if (control && req.body) control.setCadence(req.body); res.status(204).end(); });
  return app;
}

export function startInspect(port: number, gen: SyntheticGenerator, state: { lastControl?: string; lastPostAt?: number }, control?: Control) {
  return makeInspectApp(gen, state, control).listen(port, () => console.log(`[client] inspect on :${port}`));
}
