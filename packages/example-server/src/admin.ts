import { Router } from 'express';
import type { Store } from './store.js';
import { seedBackfill } from './backfill.js';
export function adminRouter(store: Store): Router {
  const r = Router();
  r.get('/test/meter-readings', (_q, res) => res.json(store.meterReadings()));
  r.get('/test/der-statuses', (_q, res) => res.json(store.derStatuses()));
  r.get('/test/wire', (_q, res) => res.json(store.wire()));   // observed client↔server exchanges
  r.post('/test/wire/clear', (_q, res) => { store.clearWire(); res.status(204).end(); });   // clear the wire log only (not a full reset)
  r.get('/test/controls', (_q, res) => res.json(store.controls()));  // pending controls (peek; does not drain)
  r.post('/test/reset', (_q, res) => {
    store.reset();
    seedBackfill(store, { now: Math.floor(Date.now() / 1000) });
    store.logWire({ dir: 'admin', method: 'POST', path: '/test/reset', status: 204, label: 'reset all in-memory stores (reseeded backfill)', body: '(no body)' });
    res.status(204).end();
  });
  r.post('/test/dercontrol', (req, res) => {
    if (!req.body?.mRID) { res.status(400).end(); return; }   // guard: a control needs an mRID
    store.queueControl(req.body);
    store.logWire({ dir: 'admin', method: 'POST', path: '/test/dercontrol', status: 202, label: `inject DERControl · ${req.body.mRID} (sandbox admin — not 2030.5)`, body: JSON.stringify(req.body, null, 2) });
    res.status(202).end();
  });
  return r;
}
