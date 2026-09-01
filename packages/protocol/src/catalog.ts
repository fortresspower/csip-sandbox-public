import { Uom } from './uom.js';

export type Tier = 'csip-required' | 'spec-optional' | 'off-spec';
export type Mapping =
  | { kind: 'reading-type'; uom: number; readingKind?: number; flowDirection?: number }
  | { kind: 'der-status-field'; field: string }
  | { kind: 'der-capability-field'; field: string }
  | { kind: 'extension'; uom: number; conventionMrid: string }
  | { kind: 'off-protocol'; reason: string };

export interface CatalogEntry {
  fortressPoint: string;                  // "model101.W"
  sunspec: { modelId: number; offset?: number; block?: string };
  tier: Tier;
  mapping: Mapping;
  scale?: number | null;                  // powerOfTenMultiplier; null/undefined = N/A
  category?: string;                      // source-dictionary component grouping label (not a SunSpec model number)
  levelOfDetail?: 'standard' | 'extended' | 'complete';   // source-dictionary detail band — drives the drawer's progressive-disclosure toggle
  /** Enumerated family (per-cell, etc.): one entry expands to `count` members,
   *  each addressed by `mridTemplate` with `{n}` replaced by the 1-based index. */
  enumerate?: { count: number; mridTemplate: string };
}

const CURATED: CatalogEntry[] = [
  // --- csip-required (BASIC-029 / BASIC-028 / CORE-014) ---
  { fortressPoint: 'model101.W',      sunspec: { modelId: 101, offset: 14 }, tier: 'csip-required', mapping: { kind: 'reading-type', uom: Uom.W, flowDirection: 1 }, category: 'AC Side', levelOfDetail: 'standard' },
  { fortressPoint: 'model101.VAr',    sunspec: { modelId: 101, offset: 20 }, tier: 'csip-required', mapping: { kind: 'reading-type', uom: Uom.var }, category: 'AC Side', levelOfDetail: 'standard' },
  { fortressPoint: 'model101.Hz',     sunspec: { modelId: 101, offset: 16 }, tier: 'csip-required', mapping: { kind: 'reading-type', uom: Uom.Hz }, category: 'AC Side', levelOfDetail: 'standard' },
  { fortressPoint: 'model101.PhVphA', sunspec: { modelId: 101, offset: 10 }, tier: 'csip-required', mapping: { kind: 'reading-type', uom: Uom.Voltage }, category: 'AC Side', levelOfDetail: 'standard' },
  { fortressPoint: 'model802.SoC',    sunspec: { modelId: 802, offset: 11 }, tier: 'csip-required', mapping: { kind: 'der-status-field', field: 'stateOfChargeStatus' }, category: 'Battery', levelOfDetail: 'standard' },
  { fortressPoint: 'model802.State',  sunspec: { modelId: 802, offset: 22 }, tier: 'csip-required', mapping: { kind: 'der-status-field', field: 'operationalModeStatus' }, category: 'Battery', levelOfDetail: 'standard' },
  { fortressPoint: 'model802.WHRtg',  sunspec: { modelId: 802, offset: 3  }, tier: 'csip-required', mapping: { kind: 'der-capability-field', field: 'rtgMaxWh' }, category: 'Battery', levelOfDetail: 'standard' },
  // --- spec-optional ---
  { fortressPoint: 'model101.WH',     sunspec: { modelId: 101, offset: 24 }, tier: 'spec-optional', mapping: { kind: 'reading-type', uom: Uom.Wh }, category: 'AC Side', levelOfDetail: 'extended' },
  { fortressPoint: 'model101.PF',     sunspec: { modelId: 101, offset: 22 }, tier: 'spec-optional', mapping: { kind: 'reading-type', uom: Uom.CosTheta }, category: 'AC Side', levelOfDetail: 'extended' },
  { fortressPoint: 'model101.AphA',   sunspec: { modelId: 101, offset: 3  }, tier: 'spec-optional', mapping: { kind: 'reading-type', uom: Uom.Amps }, category: 'AC Side', levelOfDetail: 'extended' },
  // --- off-spec: Fortress extension showcase on a real 40k model (vendor lane via a published
  //     fortress:* mRID, riding the existing MirrorMeterReading shape — see
  //     docs/telemetry-extension-strategy.md). NOTE: SoH is a percent, but IEEE
  //     2030.5-2018 Annex A UomType (UInt8, p.173) defines NO percent code, so uom is 0 (Not
  //     applicable); the fortress:soh mRID conveys the State-of-Health percentage out of band.
  { fortressPoint: 'model40101.sohBat',  sunspec: { modelId: 40101, offset: 42  }, tier: 'off-spec', mapping: { kind: 'extension', uom: 0, conventionMrid: 'fortress:soh' }, category: 'Battery', levelOfDetail: 'extended' },
  { fortressPoint: 'model40101.pBkupTot', sunspec: { modelId: 40101, offset: 88 }, tier: 'off-spec', mapping: { kind: 'extension', uom: Uom.W, conventionMrid: 'fortress:backup-power' }, category: 'Backup Power', levelOfDetail: 'extended' },
];

import { GENERATED_CATALOG } from './catalog.generated.js';

const curatedKeys = new Set(CURATED.map((e) => e.fortressPoint));
export const CATALOG: CatalogEntry[] = [
  ...CURATED,
  ...GENERATED_CATALOG.filter((e) => !curatedKeys.has(e.fortressPoint)),
];

export const byTier = (t: Tier): CatalogEntry[] => CATALOG.filter((e) => e.tier === t);
export const exposablePoints = (): CatalogEntry[] => CATALOG.filter((e) => e.mapping.kind !== 'off-protocol');
export const findPoint = (p: string): CatalogEntry | undefined => CATALOG.find((e) => e.fortressPoint === p);

/** The mRID a point is keyed by on the wire (null when it travels in DERStatus/DERCapability). */
export const wireMrid = (e: CatalogEntry): string | null => {
  if (e.mapping.kind === 'extension') return e.mapping.conventionMrid;
  if (e.mapping.kind === 'reading-type') return e.fortressPoint.replace(/\W/g, '');
  return null;
};
/** Reverse lookup: the catalog entry addressed by a given wire mRID. */
export const findByWireMrid = (mrid: string): CatalogEntry | undefined => CATALOG.find((e) => wireMrid(e) === mrid);
