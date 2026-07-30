import type { EndDeviceIdentity } from './enrollment-source.js';

export interface QueuedControl {
  mRID: string;
  programId?: string;
  opModConnect?: boolean;
  opModMaxLimW?: number;
  opModFixedW?: number;
  // Per-control timing. Omit for back-compat (controlXml falls back to start=0/duration=600).
  // `start` + `duration` are 2030.5 epoch SECONDS; a future `start` exercises the scheduled branch.
  interval?: { start: number; duration: number };
  eventStatus?: number; // EventStatus.currentStatus; defaults to 1 when omitted
}

/** One observed exchange, for the wire log. `dir`: poll = 2030.5 GET the client makes,
 *  post = 2030.5 POST/PUT the client makes, admin = sandbox /test/* call (not 2030.5). */
export interface WireEntry { id: number; ts: number; dir: 'poll' | 'post' | 'admin'; method: string; path: string; status: number; label: string; body: string; }

export interface StoredReading { ts: number; mup: 0 | 1; mrid: string; point: string; uom: number; value: number; }
export interface ReadQuery { mup: 0 | 1; after?: number; start: number; limit: number; mrids?: string[]; }
export interface ReadPage { items: StoredReading[]; all: number; results: number; }

const WIRE_CAP = 300;

export class Store {
  private mr: string[] = [];
  private der: string[] = [];
  private ctrl: QueuedControl[] = [];
  private wireBuf: WireEntry[] = [];
  private wireId = 0;
  private readings: StoredReading[] = [];

  constructor(private readonly endDevices: EndDeviceIdentity[] = []) {}

  addMeterReading(xml: string) { this.mr.push(xml); }
  meterReadings() { return this.mr; }
  addDerStatus(xml: string) { this.der.push(xml); }
  derStatuses() { return this.der; }
  queueControl(c: QueuedControl) { this.ctrl.push(c); }
  controls() { return this.ctrl; }
  drainControls(programId = '0') {
    const out = this.ctrl.filter(control => (control.programId ?? '0') === programId);
    this.ctrl = this.ctrl.filter(control => (control.programId ?? '0') !== programId);
    return out;
  }
  listEndDeviceIdentities() {
    return this.endDevices.map(device => ({ ...device }));
  }
  getEndDeviceIdentity(id: string) {
    const device = this.endDevices.find(candidate => candidate.id === id);
    return device == null ? undefined : { ...device };
  }

  addReading(r: StoredReading) { this.readings.push(r); }

  /** §4.6.2-style windowed/paged read: filter by mup (+ optional after-time + mrids), page by start/limit. */
  /** Filter stored readings by mup (+ optional after-time + mrids) — no sort/paging. */
  gather(q: { mup: 0 | 1; after?: number; mrids?: string[] }): StoredReading[] {
    let rows = this.readings.filter((r) => r.mup === q.mup);
    if (q.after !== undefined) rows = rows.filter((r) => r.ts >= q.after!);
    if (q.mrids && q.mrids.length) { const set = new Set(q.mrids); rows = rows.filter((r) => set.has(r.mrid)); }
    return rows;
  }

  readReadings(q: ReadQuery): ReadPage {
    const rows = this.gather(q).sort((a, b) => a.ts - b.ts);
    const all = rows.length;
    const items = rows.slice(q.start, q.start + q.limit);
    return { items, all, results: items.length };
  }

  /** Record an observed exchange so the console can show the real client↔server wire. */
  logWire(e: Omit<WireEntry, 'id' | 'ts'>) {
    this.wireBuf.push({ id: ++this.wireId, ts: Date.now(), ...e });
    if (this.wireBuf.length > WIRE_CAP) this.wireBuf = this.wireBuf.slice(this.wireBuf.length - WIRE_CAP);
  }
  wire() { return this.wireBuf; }
  clearWire() { this.wireBuf = []; }
  reset() { this.mr = []; this.der = []; this.ctrl = []; this.wireBuf = []; this.readings = []; }
}
