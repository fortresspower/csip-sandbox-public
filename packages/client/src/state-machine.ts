import { parseDERControlList, serializeMirrorMeterReadingList, findPoint, type MirrorMeterReading } from '@fortress-csip/protocol';
import type { SyntheticGenerator, Snapshot } from './generator.js';
import { applyControl } from './control.js';

export interface Transport {
  get(path: string): Promise<string>;
  post(path: string, xml: string): Promise<{ status: number; location?: string }>;
  put(path: string, xml: string): Promise<{ status: number }>;
}

export interface CsipClientOpts {
  generator: SyntheticGenerator;
  transport: Transport;
  subscription: string[];
  mupHref: string;
  dercHref?: string;                          // DERControlList endpoint; example-server serves it here
  onControlApplied?: (label: string) => void; // surfaces the last applied control (e.g. to /status)
  now?: () => number;          // seconds
}

// Each entry returns the integer wire value plus the powerOfTenMultiplier that declares its
// scale, so a server recovers the real quantity as value * 10^multiplier.
const snapshotValue = (s: Snapshot, point: string): { value: number; multiplier: number } | undefined => {
  switch (point) {
    case 'model101.W': return { value: s.realPowerW, multiplier: 0 };
    case 'model101.VAr': return { value: s.reactivePowerVar, multiplier: 0 };
    case 'model101.Hz': return { value: Math.round(s.frequencyHz * 100), multiplier: -2 };
    case 'model101.PhVphA': return { value: Math.round(s.voltageV * 10), multiplier: -1 };
    case 'model802.SoC': return { value: s.soc, multiplier: 0 };  // posted via DERStatus in full impl; numeric here
    // --- Fortress extension lane: synthetic sources so subscribing one actually posts a
    //     MirrorMeterReading carrying its fortress:* mRID on the wire (vendor lane). ---
    case 'model40101.sohBat': return { value: 98, multiplier: 0 };                          // SoH %
    case 'model40101.pBkupTot': return { value: 0, multiplier: 0 };                          // backup-port W
    default: return undefined;
  }
};

export class CsipClient {
  constructor(private readonly o: CsipClientOpts) {}
  private now() { return this.o.now ? this.o.now() : Math.floor(Date.now() / 1000); }

  async pollAndApplyControl(): Promise<void> {
    const xml = await this.o.transport.get(this.o.dercHref ?? '/derp/0/derc');
    const list = parseDERControlList(xml);
    for (const c of list.items) {
      const label = applyControl(this.o.generator, c);
      const rsp = `<?xml version="1.0"?><DERControlResponse xmlns="urn:ieee:std:2030.5:ns"><createdDateTime>${this.now()}</createdDateTime><status>2</status><subject>${c.mRID}</subject></DERControlResponse>`;
      await this.o.transport.post(`/rsps`, rsp);
      this.o.onControlApplied?.(label);
    }
  }

  async postTelemetry(): Promise<void> {
    const s = this.o.generator.snapshot();
    // Build all of this interval's readings, then POST them as one MirrorMeterReadingList to
    // the MUP — the canonical batch form (IEEE 2030.5 §10.11.3(d)), not one POST per point.
    const readings: MirrorMeterReading[] = [];
    for (const point of this.o.subscription) {
      const entry = findPoint(point);
      if (!entry || entry.mapping.kind === 'off-protocol' || entry.mapping.kind === 'der-status-field' || entry.mapping.kind === 'der-capability-field') continue;
      const reading = snapshotValue(s, point);
      if (reading === undefined) {
        // Subscribed point passed the kind filter but has no synthetic source wired (e.g. a
        // spec-optional reading-type). Surface it instead of silently posting nothing.
        console.warn(`[telemetry] no synthetic source for subscribed point ${point}; skipping`);
        continue;
      }
      const uom = entry.mapping.kind === 'reading-type' || entry.mapping.kind === 'extension' ? entry.mapping.uom : 0;
      readings.push({
        mRID: point.replace(/\W/g, ''),
        description: point,
        ReadingType: { uom: uom as any, powerOfTenMultiplier: reading.multiplier, ...(entry.mapping.kind === 'extension' ? { mRID: entry.mapping.conventionMrid } : {}) },
        Reading: { timePeriod: { start: this.now(), duration: 0 }, value: reading.value },
      });
    }
    if (readings.length === 0) return;
    await this.o.transport.post(this.o.mupHref, serializeMirrorMeterReadingList(readings));
  }
}
