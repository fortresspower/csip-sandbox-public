import { describe, it, expect } from 'vitest';
import { CATALOG, byTier, exposablePoints } from '../src/catalog.js';

describe('catalog', () => {
  it('maps real power to a reading-type with uom 38', () => {
    const w = CATALOG.find((e) => e.fortressPoint === 'model101.W')!;
    expect(w.tier).toBe('csip-required');
    expect(w.mapping.kind).toBe('reading-type');
    if (w.mapping.kind === 'reading-type') expect(w.mapping.uom).toBe(38);
  });

  it('maps SoC to DERStatus.stateOfChargeStatus', () => {
    const soc = CATALOG.find((e) => e.fortressPoint === 'model802.SoC')!;
    expect(soc.mapping.kind).toBe('der-status-field');
  });

  it('marks sohBat as an off-spec extension via fortress:soh', () => {
    const soh = CATALOG.find((e) => e.fortressPoint === 'model40101.sohBat')!;
    expect(soh.tier).toBe('off-spec');
    if (soh.mapping.kind === 'extension') expect(soh.mapping.conventionMrid).toBe('fortress:soh');
  });

  it('carries no UomType code for the percent SoH extension (2030.5 UomType has no percent)', () => {
    const soh = CATALOG.find((e) => e.fortressPoint === 'model40101.sohBat')!;
    if (soh.mapping.kind === 'extension') expect(soh.mapping.uom).toBe(0);
  });

  it('only includes Fortress vendor points on 40k/42k models (cruft + non-40k/42k dropped)', () => {
    for (const fp of ['model42111.vCellN', 'model39998.canErr', 'model7998.alarmBits']) {
      expect(CATALOG.find((e) => e.fortressPoint === fp)).toBeUndefined();
    }
    for (const e of CATALOG.filter((e) => e.tier === 'off-spec')) {
      expect(e.sunspec.modelId).toBeGreaterThanOrEqual(40000);   // 40xxx / 42xxx Fortress vendor models only
    }
  });

  it('classifies points with a Component category and a Level of Detail', () => {
    const gen = CATALOG.find((e) => e.tier === 'off-spec' && e.fortressPoint.startsWith('model40104'))!;
    expect(typeof gen.category).toBe('string');
    expect(['standard', 'extended', 'complete']).toContain(gen.levelOfDetail);
  });

  it('every point is now exposable — no off-protocol entries remain', () => {
    expect(CATALOG.some((e) => e.mapping.kind === 'off-protocol')).toBe(false);
    expect(exposablePoints().length).toBe(CATALOG.length);
    expect(byTier('csip-required').length).toBeGreaterThanOrEqual(5);
  });
});

import { findPoint } from '../src/catalog.js';

it('every extension entry carries a fortress:* conventionMrid', () => {
  const ext = CATALOG.filter((e) => e.mapping.kind === 'extension');
  expect(ext.length).toBeGreaterThan(0);
  for (const e of ext) {
    expect(e.mapping.kind === 'extension' && e.mapping.conventionMrid.startsWith('fortress:')).toBe(true);
  }
});

it('supports an optional scale and category on entries', () => {
  const w = findPoint('model101.W');
  expect(w).toBeDefined();
  // a generated extension entry carries a numeric scale and a string category
  const gen = CATALOG.find((e) => e.mapping.kind === 'extension' && typeof e.scale === 'number');
  expect(gen).toBeDefined();
  expect(typeof gen!.category).toBe('string');
});

it('includes hundreds of generated extension points, curated entries winning on collision', () => {
  expect(CATALOG.length).toBeGreaterThan(200);
  // curated model101.W keeps its reading-type mapping, not an extension override
  expect(findPoint('model101.W')?.mapping.kind).toBe('reading-type');
});
