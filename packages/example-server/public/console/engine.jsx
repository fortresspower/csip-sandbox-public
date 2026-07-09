/* Fortress CSIP Console — engine.
   - Simulator: 1:1 port of packages/client/src/generator.ts (SyntheticGenerator)
   - FakeServer: in-browser mirror of packages/example-server (Store + routes + admin)
   - useConsole(): drives the closed loop, talks LIVE to the running sandbox when
     reachable (localhost:7001 admin/2030.5 + localhost:7100 client /status), and
     transparently falls back to the in-browser simulation when it is not.
   Exposes: window.useConsole
*/
(function () {
  const { useState, useRef, useEffect, useCallback } = React;
  const FP = window.FP;

  // ---------- SyntheticGenerator (generator.ts) ----------
  class Simulator {
    constructor(fx) {
      this.fx = fx;
      this.soc = fx.initialSoC;
      this.setpointW = 0;          // signed: + charge, - discharge
      this.maxLimitW = fx.nameplateW;
      this.connected = true;
      this.t = 0;
    }
    setDischargeSetpoint(w) { this.setpointW = -Math.abs(w); }
    setChargeSetpoint(w) { this.setpointW = Math.abs(w); }
    setMaxLimitW(w) { this.maxLimitW = Math.max(0, w); }
    setConnected(on) { this.connected = on; }
    currentPowerW() {
      if (!this.connected) return 0;
      return Math.max(-this.maxLimitW, Math.min(this.maxLimitW, this.setpointW));
    }
    step(dt) {
      this.t += dt;
      if (!this.connected) return;
      const powerW = this.currentPowerW();
      const deltaWh = (powerW * dt) / 3600;
      const deltaSoC = (deltaWh / this.fx.capacityWh) * 100;
      this.soc = Math.min(100, Math.max(0, this.soc + deltaSoC));
    }
    snapshot() {
      const p = this.currentPowerW();
      const jitter = Math.sin(this.t / 600);
      return {
        lFDI: this.fx.lFDI,
        realPowerW: this.connected ? p : 0,
        reactivePowerVar: this.connected ? Math.round(p * 0.05) : 0,
        voltageV: 240 + jitter,
        frequencyHz: 60 + jitter * 0.02,
        soc: Math.round(this.soc * 10) / 10,
        connected: this.connected,
      };
    }
  }

  // applyControl (control.ts) — returns a human label
  function applyControl(sim, c) {
    const applied = [];
    if (c.opModConnect !== undefined) { sim.setConnected(c.opModConnect); applied.push(`connect=${c.opModConnect}`); }
    if (c.opModMaxLimW !== undefined) { sim.setMaxLimitW(c.opModMaxLimW); applied.push(`maxLimW=${c.opModMaxLimW}`); }
    if (c.opModFixedW !== undefined) {
      if (c.opModFixedW < 0) sim.setDischargeSetpoint(c.opModFixedW); else sim.setChargeSetpoint(c.opModFixedW);
      applied.push(`fixedW=${c.opModFixedW}`);
    }
    return `${c.mRID}: ${applied.join(', ') || 'no-op'}`;
  }

  // Synthesize-on-read (mirror of example-server backfill.ts synthSeries) — a deterministic
  // per-mRID series so any requested catalog point returns data in SIM.
  function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function genericValue(mrid, t) { const h = hashStr(mrid); const amp = 20 + (h % 480); const phase = (h % 628) / 100; const base = (h >> 9) % 100; return Math.round(base + amp * Math.sin(t / 3600 + phase)); }
  function synthSeries(mup, mrids, opts) {
    const step = opts.stepSec || 300;
    const start = Math.max(opts.after || 0, opts.now - (opts.hours || 24) * 3600);
    const out = [];
    for (const mrid of mrids) {
      const entry = FP.CATALOG.find((e) => FP.wireMrid(e) === mrid);
      const k = entry && entry.mapping.kind;
      const uom = (k === 'reading-type' || k === 'extension') ? entry.mapping.uom : 0;
      const point = entry ? entry.fortressPoint : mrid;
      for (let t = start; t <= opts.now; t += step) out.push({ ts: t, mup, mrid, point, uom, value: genericValue(mrid, t) });
    }
    return out;
  }

  // ---------- FakeServer (example-server Store) ----------
  class FakeServer {
    constructor() { this.mr = []; this.der = []; this.ctrl = []; this.readings = []; }
    queueControl(c) { this.ctrl.push(c); }
    controls() { return this.ctrl; }
    drainControls() { const out = this.ctrl; this.ctrl = []; return out; }
    addMeterReading(xml) { this.mr.push(xml); }
    meterReadings() { return this.mr; }
    addReading(r) { this.readings.push(r); }
    readReadings({ mup, after, start, limit, mrids }) {
      let rows = this.readings.filter((r) => r.mup === mup);
      if (after !== undefined) rows = rows.filter((r) => r.ts >= after);
      if (mrids && mrids.length) { const set = new Set(mrids); rows = rows.filter((r) => set.has(r.mrid)); }
      // Synthesize-on-read (SIM parity with the server): any requested mRID with no stored data
      // still returns a series, so every catalog point is explorable.
      if (mrids && mrids.length) {
        const present = new Set(rows.map((r) => r.mrid));
        const missing = mrids.filter((m) => !present.has(m));
        if (missing.length) rows = rows.concat(synthSeries(mup, missing, { now: Math.floor(Date.now() / 1000), after }));
      }
      rows.sort((a, b) => a.ts - b.ts);
      const all = rows.length;
      const items = rows.slice(start, start + limit);
      return { items, all, results: items.length };
    }
    addDerStatus(xml) { this.der.push(xml); }
    derStatuses() { return this.der; }
    reset() { this.mr = []; this.der = []; this.ctrl = []; this.readings = []; }
  }

  const SEED_POINTS = ['model101.W', 'model101.VAr', 'model101.Hz', 'model101.PhVphA', 'model802.SoC', 'model40101.sohBat', 'model40101.pBkupTot'];
  function seedFakeBackfill(srv, now) {
    const BACKFILL_HOURS = 24, STEP_MS = 300000;
    const start = now - BACKFILL_HOURS * 3600 * 1000;
    for (const point of SEED_POINTS) {
      const entry = FP.findPoint(point); if (!entry) continue;
      const k = entry.mapping.kind;
      const mup = entry.tier === 'off-spec' ? 1 : 0;
      const mrid = k === 'extension' ? entry.mapping.conventionMrid : point.replace(/\W/g, '');
      const uom = (k === 'reading-type' || k === 'extension') ? entry.mapping.uom : 0;
      for (let t = start; t <= now; t += STEP_MS) {
        const phase = Math.sin(t / 3600000);
        let v = Math.round(phase * 100);
        if (point === 'model101.W') v = Math.round(-3000 + phase * 1500);
        else if (point === 'model101.VAr') v = Math.round(phase * 150);
        else if (point === 'model101.Hz') v = Math.round((60 + phase * 0.02) * 100);
        else if (point === 'model101.PhVphA') v = Math.round((240 + phase) * 10);
        else if (point === 'model802.SoC') v = Math.round(50 + phase * 30);
        else if (point === 'model40101.sohBat') v = 98;
        else if (point === 'model40101.pBkupTot') v = 0;
        srv.addReading({ ts: Math.floor(t / 1000), mup, mrid, point, uom, value: v });
      }
    }
  }

  // snapshotValue (state-machine.ts) + synthetic values for Fortress extension points
  function snapshotValue(s, point) {
    switch (point) {
      case 'model101.W': return s.realPowerW;
      case 'model101.VAr': return s.reactivePowerVar;
      case 'model101.Hz': return Math.round(s.frequencyHz * 100);
      case 'model101.PhVphA': return Math.round(s.voltageV * 10);
      case 'model802.SoC': return s.soc;
      // --- Fortress extension lane (synthetic, so subscribing actually posts on the wire) ---
      case 'model40101.sohBat': return 98;                              // SoH %
      case 'model40101.pBkupTot': return s.connected ? 0 : 0;           // backup-port W
      default: return undefined;
    }
  }

  // parse a MirrorMeterReading XML back into a display row
  function parseMmr(xml) {
    try {
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const g = (t) => doc.getElementsByTagName(t)[0]?.textContent ?? '';
      const rt = doc.getElementsByTagName('ReadingType')[0];
      const rtMrid = rt ? rt.getElementsByTagName('mRID')[0]?.textContent ?? '' : '';
      return {
        mRID: g('mRID'),
        description: g('description'),
        uom: Number(g('uom')),
        convention: rtMrid,
        value: Number(g('value')),
        start: Number(doc.getElementsByTagName('start')[0]?.textContent ?? 0),
      };
    } catch (e) { return { mRID: '?', description: 'parse error', uom: 0, value: NaN, start: 0 }; }
  }

  let WIRE_ID = 0;

  // Default the API URLs to the host the console was loaded from, so LIVE mode works whether
  // it's opened at localhost, a Tailscale host, or behind a tunnel — not just localhost.
  // (Falls back to localhost when opened from file://.)
  const originHost = (typeof location !== 'undefined' && location.hostname) ? location.hostname : 'localhost';
  const originProto = (typeof location !== 'undefined' && location.protocol && location.protocol.startsWith('http')) ? location.protocol : 'http:';

  function useConsole() {
    const [config, setConfigState] = useState(() => ({
      serverUrl: `${originProto}//${originHost}:7001`,
      clientUrl: `${originProto}//${originHost}:7100`,
      controlPollSec: 4,
      telemetryPostSec: 4,
      subscription: FP.SUB_DEFAULT.slice(),
    }));
    const [mode, setMode] = useState('sim');            // 'sim' | 'live'
    const [autoMode, setAutoMode] = useState(true);     // auto-detect on
    const [conn, setConn] = useState({ server: false, client: false, probed: false });

    const [snapshot, setSnapshot] = useState(null);
    const [lastControl, setLastControl] = useState(null);
    const [lastPostAt, setLastPostAt] = useState(null);
    const [controls, setControls] = useState([]);       // queued on server
    const [readings, setReadings] = useState([]);       // server-received meter readings (parsed)
    const [statuses, setStatuses] = useState([]);       // server-received DER statuses (raw)
    const [history, setHistory] = useState([]);         // [{t, powerW, soc, voltageV, freqHz}]
    const [wire, setWire] = useState([]);
    const [query, setQuery] = useState({ mrids: [], points: [], after: undefined, start: 0, limit: 1, follow: false });
    const [page, setPage] = useState({ readings: [], all: 0, results: 0, nextHref: null });

    const sim = useRef(new Simulator(FP.FIXTURE));
    const srv = useRef((() => { const s = new FakeServer(); seedFakeBackfill(s, Date.now()); return s; })());
    const cfgRef = useRef(config); cfgRef.current = config;
    const modeRef = useRef(mode); modeRef.current = mode;
    const tick = useRef(0);
    const h = useRef([]);
    const cadenceSyncedRef = useRef(false);   // sync the live client's cadence into the sliders once per live session

    const log = useCallback((e) => {
      const entry = { id: ++WIRE_ID, ts: Date.now(), ...e };
      setWire((w) => { const n = w.concat(entry); return n.length > 300 ? n.slice(n.length - 300) : n; });
    }, []);

    // ---------------- SIM loop ----------------
    const simControlCycle = useCallback(() => {
      const list = srv.current.drainControls();   // poll drains the queue, like the real server
      log({ dir: 'poll', method: 'GET', path: '/derp/0/derc', status: 200, label: `DERControlList · ${list.length} control(s)`, body: FP.xml.xmlDERControlList(list) });
      for (const c of list) {
        const label = applyControl(sim.current, c);
        const t = Math.floor(Date.now() / 1000);
        log({ dir: 'post', method: 'POST', path: '/rsps', status: 201, label: `DERControlResponse ack · ${c.mRID}`, body: FP.xml.xmlControlResponse(c.mRID, t) });
        setLastControl(label);
      }
      setControls(srv.current.controls().slice());
    }, [log]);

    const simTelemetryCycle = useCallback(() => {
      const cfg = cfgRef.current;
      const s = sim.current.snapshot();
      // Batch all of this interval's readings into one MirrorMeterReadingList POST to the MUP
      // (canonical 2030.5 §10.11.3(d)), rather than one POST per point.
      const readings = [];
      for (const point of cfg.subscription) {
        const entry = FP.findPoint(point);
        if (!entry) continue;
        const k = entry.mapping.kind;
        if (k === 'off-protocol' || k === 'der-status-field' || k === 'der-capability-field') continue;
        const value = snapshotValue(s, point);
        if (value === undefined) continue;
        const uom = (k === 'reading-type' || k === 'extension') ? entry.mapping.uom : 0;
        readings.push({
          mRID: point.replace(/\W/g, ''),
          description: point,
          ReadingType: Object.assign({ uom }, k === 'extension' ? { mRID: entry.mapping.conventionMrid } : {},
            entry.mapping.flowDirection !== undefined ? { flowDirection: entry.mapping.flowDirection } : {},
            (entry.scale !== null && entry.scale !== undefined) ? { powerOfTenMultiplier: entry.scale } : {}),
          Reading: { timePeriod: { start: Math.floor(Date.now() / 1000), duration: 0 }, value },
        });
      }
      if (readings.length) {
        const body = FP.xml.xmlMirrorMeterReadingList(readings);
        for (const r of readings) {
          srv.current.addMeterReading(FP.xml.xmlMirrorMeterReading(r)); // store raw XML for inspection
          const e = FP.findPoint(r.description);
          srv.current.addReading({
            ts: r.Reading.timePeriod.start,
            mup: (e && e.tier === 'off-spec') ? 1 : 0,
            mrid: (r.ReadingType && r.ReadingType.mRID) ? r.ReadingType.mRID : r.mRID,
            point: r.description,
            uom: r.ReadingType ? r.ReadingType.uom : 0,
            value: r.Reading.value,
          });
        }
        log({ dir: 'post', method: 'POST', path: '/mup/0', status: 201, label: `MirrorMeterReadingList · ${readings.length} readings`, body });
        setReadings(srv.current.meterReadings().map(parseMmr));
      }
      setLastPostAt(Date.now());
    }, [log]);

    // ---------------- LIVE helpers ----------------
    const liveFetch = useCallback(async (base, path, opts) => {
      const r = await fetch(base + path, opts);
      return r;
    }, []);

    const livePoll = useCallback(async () => {
      const cfg = cfgRef.current;
      let serverOk = false, clientOk = false;
      // client /status
      try {
        const r = await fetch(cfg.clientUrl + '/status', { headers: { Accept: 'application/json' } });
        if (r.ok) {
          const j = await r.json();
          setSnapshot(j.snapshot); setLastControl(j.lastControl ?? null); setLastPostAt(j.lastPostAt ?? null);
          // Reflect the live client's real cadence in the sliders — once per live session, so a
          // user dragging a slider isn't fought by the poll loop overwriting it.
          if (j.cadence && !cadenceSyncedRef.current) {
            setConfigState((c) => Object.assign({}, c, { controlPollSec: j.cadence.controlPollSec, telemetryPostSec: j.cadence.telemetryPostSec }));
            cadenceSyncedRef.current = true;
          }
          clientOk = true;
        }
      } catch (e) {}
      // server meter-readings
      try {
        const r = await fetch(cfg.serverUrl + '/test/meter-readings', { headers: { Accept: 'application/json' } });
        if (r.ok) { const arr = await r.json(); setReadings(arr.map(parseMmr)); serverOk = true; }
      } catch (e) {}
      // server der-statuses
      try {
        const r = await fetch(cfg.serverUrl + '/test/der-statuses', { headers: { Accept: 'application/json' } });
        if (r.ok) { setStatuses(await r.json()); serverOk = true; }
      } catch (e) {}
      // the real client<->server 2030.5 wire, observed server-side (poll/post/admin).
      // In LIVE the traffic is container-to-container, so the browser can't see it directly —
      // the server records it and we mirror it here. (Also our serverOk health signal.)
      try {
        const r = await fetch(cfg.serverUrl + '/test/wire', { headers: { Accept: 'application/json' } });
        if (r.ok) { setWire(await r.json()); serverOk = true; }
      } catch (e) {}
      // pending controls the server will serve to the client on its next poll (peek; non-draining)
      try {
        const r = await fetch(cfg.serverUrl + '/test/controls', { headers: { Accept: 'application/json' } });
        if (r.ok) { setControls(await r.json()); serverOk = true; }
      } catch (e) {}
      setConn({ server: serverOk, client: clientOk, probed: true });
      return { serverOk, clientOk };
    }, []);

    // auto-detect once on mount
    useEffect(() => {
      let cancelled = false;
      (async () => {
        const { serverOk, clientOk } = await livePoll();
        if (cancelled) return;
        if (autoMode) setMode(serverOk || clientOk ? 'live' : 'sim');
      })();
      return () => { cancelled = true; };
      // eslint-disable-next-line
    }, []);

    // ---------------- master 1s loop ----------------
    useEffect(() => {
      const iv = setInterval(() => {
        tick.current += 1;
        const cfg = cfgRef.current;
        if (modeRef.current === 'sim') {
          sim.current.step(1);
          const s = sim.current.snapshot();
          setSnapshot(s);
          h.current.push({ t: Date.now(), powerW: s.realPowerW, soc: s.soc, voltageV: s.voltageV, freqHz: s.frequencyHz });
          if (h.current.length > 240) h.current.shift();
          setHistory(h.current.slice());
          if (cfg.controlPollSec > 0 && tick.current % cfg.controlPollSec === 0) simControlCycle();
          if (cfg.telemetryPostSec > 0 && tick.current % cfg.telemetryPostSec === 0) simTelemetryCycle();
        } else {
          // live: poll on a ~2s cadence
          if (tick.current % 2 === 0) {
            livePoll().then(() => {
              setSnapshot((s) => {
                if (s) { h.current.push({ t: Date.now(), powerW: s.realPowerW, soc: s.soc, voltageV: s.voltageV, freqHz: s.frequencyHz }); if (h.current.length > 240) h.current.shift(); setHistory(h.current.slice()); }
                return s;
              });
            });
          }
        }
      }, 1000);
      return () => clearInterval(iv);
    }, [simControlCycle, simTelemetryCycle, livePoll]);

    // keep queued-control list in sync (sim)
    useEffect(() => { if (mode === 'sim') setControls(srv.current.controls().slice()); }, [mode, wire.length]);

    // ---------------- actions ----------------
    const dispatchControl = useCallback(async (ctrl) => {
      const cfg = cfgRef.current;
      const clean = { mRID: ctrl.mRID };
      if (ctrl.opModConnect !== undefined) clean.opModConnect = ctrl.opModConnect;
      if (ctrl.opModMaxLimW !== undefined && ctrl.opModMaxLimW !== '' && ctrl.opModMaxLimW !== null) clean.opModMaxLimW = Number(ctrl.opModMaxLimW);
      if (ctrl.opModFixedW !== undefined && ctrl.opModFixedW !== '' && ctrl.opModFixedW !== null) clean.opModFixedW = Number(ctrl.opModFixedW);
      if (modeRef.current === 'sim') {
        srv.current.queueControl(clean);
        setControls(srv.current.controls().slice());   // shows in the queue until the next poll drains it
        log({ dir: 'admin', method: 'POST', path: '/test/dercontrol', status: 202, label: `inject DERControl · ${clean.mRID} (sandbox admin — not 2030.5)`, body: JSON.stringify(clean, null, 2) });
        return { ok: true, status: 202 };
      }
      try {
        // LIVE: the server records this admin call (and the resulting 2030.5 poll/post) into
        // /test/wire, which the next livePoll mirrors — so we don't log locally (avoids dupes).
        const r = await fetch(cfg.serverUrl + '/test/dercontrol', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(clean) });
        return { ok: r.ok, status: r.status };
      } catch (e) {
        log({ dir: 'admin', method: 'POST', path: '/test/dercontrol', status: 0, label: `inject failed — server unreachable`, body: String(e) });
        return { ok: false, status: 0, error: String(e) };
      }
    }, [log, simControlCycle]);

    const reset = useCallback(async () => {
      const cfg = cfgRef.current;
      if (modeRef.current === 'sim') {
        srv.current.reset(); seedFakeBackfill(srv.current, Date.now()); sim.current = new Simulator(FP.FIXTURE);
        setControls([]); setReadings([]); setStatuses([]); h.current = []; setHistory([]); setLastControl(null); setLastPostAt(null);
        log({ dir: 'admin', method: 'POST', path: '/test/reset', status: 204, label: 'reset all in-memory stores', body: '(no body)' });
        return;
      }
      try {
        // LIVE: server records the reset into /test/wire; the next livePoll mirrors it.
        const r = await fetch(cfg.serverUrl + '/test/reset', { method: 'POST' });
        void r;
        setReadings([]); setStatuses([]); h.current = []; setHistory([]); setWire([]);
      } catch (e) {
        log({ dir: 'admin', method: 'POST', path: '/test/reset', status: 0, label: 'reset failed — server unreachable', body: String(e) });
      }
    }, [log]);

    const setConfig = useCallback((patch) => setConfigState((c) => Object.assign({}, c, patch)), []);
    // Cadence change: drives the in-browser loop in SIM, and pushes to the live client
    // (POST /control/cadence) in LIVE so the real poll/post loop is retuned/stopped too.
    const setCadence = useCallback((patch) => {
      setConfigState((c) => Object.assign({}, c, patch));
      if (modeRef.current === 'live') {
        fetch(cfgRef.current.clientUrl + '/control/cadence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).catch(() => {});
      }
    }, []);
    // Clear the wire view. In LIVE the wire is mirrored from the server's /test/wire, so a
    // local clear would be overwritten on the next poll — clear the server's log too.
    const clearWire = useCallback(async () => {
      setWire([]);
      if (modeRef.current === 'live') {
        try { await fetch(cfgRef.current.serverUrl + '/test/wire/clear', { method: 'POST' }); } catch (e) {}
      }
    }, []);
    const switchMode = useCallback((m) => { setAutoMode(false); cadenceSyncedRef.current = false; setMode(m); }, []);
    const reprobe = useCallback(async () => {
      cadenceSyncedRef.current = false;   // re-sync the client's cadence into the sliders on an explicit re-probe
      const { serverOk, clientOk } = await livePoll();
      if (autoMode) setMode(serverOk || clientOk ? 'live' : 'sim');
      return { serverOk, clientOk };
    }, [livePoll, autoMode]);

    // Issues the canonical paginated read for the selected points. In SIM it pages the
    // FakeServer; in LIVE it GETs the real /mup/:m/mr and parses the MirrorMeterReadingList.
    const runRead = useCallback(async (override) => {
      const q = Object.assign({}, query, override);
      // group selected points by MUP (std → 0, fortress → 1)
      const groups = { 0: [], 1: [] };
      for (const p of q.points) { const e = FP.findPoint(p); if (!e) continue; (e.tier === 'off-spec' ? groups[1] : groups[0]).push(FP.wireMrid(e)); }
      const out = []; let all = 0; let nextHref = null;
      for (const mup of [0, 1]) {
        const mrids = groups[mup].filter(Boolean);
        if (!mrids.length) continue;
        if (modeRef.current === 'sim') {
          const r = srv.current.readReadings({ mup, after: q.after, start: q.start, limit: q.limit, mrids });
          const url = FP.buildReadUrl({ mup, after: q.after, start: q.start, limit: q.limit, mrids });
          const mupItems = r.items.map((it) => ({ mRID: it.mrid, description: it.point, ReadingType: { uom: it.uom }, Reading: { timePeriod: { start: it.ts, duration: 0 }, value: it.value } }));
          for (const it of r.items) out.push({ mRID: it.mrid, description: it.point, uom: it.uom, value: it.value, start: it.ts });
          all += r.all;
          log({ dir: 'poll', method: 'GET', path: url, status: 200, label: `MirrorMeterReadingList · ${r.results}/${r.all}`, body: FP.xml.xmlMirrorMeterReadingList(mupItems) });
          if (q.start + q.limit < r.all) nextHref = FP.buildReadUrl({ mup, after: q.after, start: q.start + q.limit, limit: q.limit, mrids });
        } else {
          const url = FP.buildReadUrl({ mup, after: q.after, start: q.start, limit: q.limit, mrids });
          try {
            const resp = await fetch(cfgRef.current.serverUrl + url, { headers: { Accept: 'application/sep+xml' } });
            if (!resp.ok) continue;
            const xml = await resp.text();
            const parsed = FP.parseReadPage(xml);
            for (const it of parsed.readings) out.push(it);
            all += parsed.all; if (parsed.nextHref) nextHref = parsed.nextHref;
          } catch (e) { /* surfaced via empty page + wire log on next livePoll */ }
        }
      }
      setPage({ readings: out, all, results: out.length, nextHref });
      setQuery(q);
    }, [query, log]);

    return {
      config, setConfig, setCadence, mode, switchMode, autoMode, setAutoMode, conn, reprobe,
      snapshot, lastControl, lastPostAt, controls, readings, statuses, history, wire,
      dispatchControl, reset, clearWire,
      query, setQuery, page, runRead,
      fixture: FP.FIXTURE,
    };
  }

  window.useConsole = useConsole;
})();
