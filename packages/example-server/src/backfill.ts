import { findPoint, findByWireMrid } from '@fortress-csip/protocol';
import type { Store, StoredReading } from './store.js';

// Default subscription = the five CSIP-required points + two showcase fortress points,
// so both MUPs have demonstrable history without seeding all ~750 points.
const SEED_POINTS = ['model101.W', 'model101.VAr', 'model101.Hz', 'model101.PhVphA', 'model802.SoC', 'model40101.sohBat', 'model40101.pBkupTot'];

const mupOf = (point: string): 0 | 1 => (findPoint(point)?.tier === 'off-spec' ? 1 : 0);

/** A deterministic synthetic value for a point at time t (no RNG — stable across reseeds). */
function synth(point: string, t: number): number {
  const phase = Math.sin(t / 3600);
  switch (point) {
    case 'model101.W': return Math.round(-3000 + phase * 1500);
    case 'model101.VAr': return Math.round(phase * 150);
    case 'model101.Hz': return Math.round((60 + phase * 0.02) * 100);
    case 'model101.PhVphA': return Math.round((240 + phase) * 10);
    case 'model802.SoC': return Math.round(50 + phase * 30);
    case 'model40101.sohBat': return 98;
    case 'model40101.pBkupTot': return 0;
    default: return Math.round(phase * 100);
  }
}

export function seedBackfill(store: Store, opts: { now: number; hours?: number; stepSec?: number } = { now: Math.floor(Date.now() / 1000) }) {
  const hours = opts.hours ?? 24;
  const step = opts.stepSec ?? 300;
  const start = opts.now - hours * 3600;
  for (const point of SEED_POINTS) {
    const entry = findPoint(point);
    if (!entry) continue;
    const mup = mupOf(point);
    const mrid = entry.mapping.kind === 'extension' ? entry.mapping.conventionMrid : point.replace(/\W/g, '');
    const uom = entry.mapping.kind === 'reading-type' || entry.mapping.kind === 'extension' ? entry.mapping.uom : 0;
    for (let t = start; t <= opts.now; t += step) {
      const r: StoredReading = { ts: t, mup, mrid, point, uom, value: synth(point, t) };
      store.addReading(r);
    }
  }
}

// Deterministic per-mRID value (FNV-1a hash → stable amplitude/phase; no RNG).
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function genericValue(mrid: string, t: number): number {
  const h = hashStr(mrid);
  const amp = 20 + (h % 480);
  const phase = (h % 628) / 100;
  const base = (h >> 9) % 100;
  return Math.round(base + amp * Math.sin(t / 3600 + phase));
}

/** Synthesize a 24h @ 5-min series for mRIDs that have no stored data, so a read for ANY
 *  catalog point still returns a sensible series. Reads are per-mRID resource addressing —
 *  the sandbox serves the whole catalog rather than gating which points a consumer may pick. */
export function synthSeries(mup: 0 | 1, mrids: string[], opts: { now: number; after?: number; hours?: number; stepSec?: number }): StoredReading[] {
  const step = opts.stepSec ?? 300;
  const start = Math.max(opts.after ?? 0, opts.now - (opts.hours ?? 24) * 3600);
  const out: StoredReading[] = [];
  for (const mrid of mrids) {
    const entry = findByWireMrid(mrid);
    const uom = entry && (entry.mapping.kind === 'reading-type' || entry.mapping.kind === 'extension') ? entry.mapping.uom : 0;
    const point = entry ? entry.fortressPoint : mrid;
    for (let t = start; t <= opts.now; t += step) out.push({ ts: t, mup, mrid, point, uom, value: genericValue(mrid, t) });
  }
  return out;
}
