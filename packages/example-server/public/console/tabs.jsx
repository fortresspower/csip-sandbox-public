/* Fortress CSIP Console — tab views + wire log. Exposes window.TABS */
(function () {
  const { useState, useMemo, useRef, useEffect } = React;
  const U = window.UI, FP = window.FP, h = U.h;

  // ---- formatters ----
  const fmtW = (w) => { if (w == null || isNaN(w)) return '—'; const a = Math.abs(w); return a >= 1000 ? (w / 1000).toFixed(2) : String(Math.round(w)); };
  const unitW = (w) => (Math.abs(w) >= 1000 ? 'kW' : 'W');
  const sign = (w) => (w > 0 ? '+' : w < 0 ? '−' : '');
  const flowLabel = (w) => (w < 0 ? 'Discharging' : w > 0 ? 'Charging' : 'Idle');
  const flowTone = (w) => (w < 0 ? 'amber' : w > 0 ? 'green' : 'neutral');
  const ago = (ts) => { if (!ts) return 'never'; const s = Math.round((Date.now() - ts) / 1000); return s < 2 ? 'just now' : s < 60 ? s + 's ago' : Math.round(s / 60) + 'm ago'; };

  // ===================== DISPATCH =====================
  // Diagram for the "Learn more" modal: northbound admin-injection vs southbound 2030.5 wire.
  const DISPATCH_DIAGRAM = `
<svg viewBox="0 0 760 250" width="100%" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="ah-v" markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto"><path d="M0 0 L7 3 L0 6 z" fill="#7A5AE0"/></marker>
    <marker id="ah-b" markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto"><path d="M0 0 L7 3 L0 6 z" fill="#2563EB"/></marker>
    <marker id="ah-g" markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto"><path d="M0 0 L7 3 L0 6 z" fill="#1B9E4B"/></marker>
  </defs>
  <line x1="247" y1="30" x2="247" y2="232" stroke="#D3D9D6" stroke-dasharray="4 4"/>
  <text x="132" y="24" text-anchor="middle" fill="#9BA49F" font-size="11" font-weight="700" letter-spacing="0.05em">NORTHBOUND · PROPRIETARY</text>
  <text x="505" y="24" text-anchor="middle" fill="#9BA49F" font-size="11" font-weight="700" letter-spacing="0.05em">SOUTHBOUND · IEEE 2030.5</text>
  <!-- boxes -->
  <rect x="24" y="108" width="180" height="74" rx="10" fill="#FAFBFA" stroke="#D3D9D6"/>
  <text x="114" y="139" text-anchor="middle" fill="#15201B" font-size="13" font-weight="700">Your aggregator logic</text>
  <text x="114" y="158" text-anchor="middle" fill="#6C7773" font-size="11">operator · VPP optimizer</text>
  <rect x="290" y="108" width="180" height="74" rx="10" fill="#FAFBFA" stroke="#D3D9D6"/>
  <text x="380" y="139" text-anchor="middle" fill="#15201B" font-size="13" font-weight="700">Example server</text>
  <text x="380" y="158" text-anchor="middle" fill="#6C7773" font-size="11">:7001 · control queue</text>
  <rect x="556" y="108" width="180" height="74" rx="10" fill="#FAFBFA" stroke="#D3D9D6"/>
  <text x="646" y="139" text-anchor="middle" fill="#15201B" font-size="13" font-weight="700">Fortress client (DER)</text>
  <text x="646" y="158" text-anchor="middle" fill="#6C7773" font-size="11">:7100 · the device</text>
  <!-- A: admin inject (northbound) -->
  <line x1="206" y1="136" x2="286" y2="136" stroke="#7A5AE0" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#ah-v)"/>
  <text x="246" y="86" text-anchor="middle" fill="#7A5AE0" font-size="11.5" font-weight="700">POST /test/dercontrol</text>
  <text x="246" y="100" text-anchor="middle" fill="#7A5AE0" font-size="10">JSON · admin, not 2030.5</text>
  <!-- B: 2030.5 poll -->
  <line x1="472" y1="128" x2="554" y2="128" stroke="#2563EB" stroke-width="2" marker-end="url(#ah-b)"/>
  <text x="513" y="86" text-anchor="middle" fill="#2563EB" font-size="11.5" font-weight="700">GET /derp/0/derc</text>
  <text x="513" y="100" text-anchor="middle" fill="#2563EB" font-size="10">DERControlList · XML</text>
  <!-- C: 2030.5 telemetry return -->
  <line x1="554" y1="162" x2="472" y2="162" stroke="#1B9E4B" stroke-width="2" marker-end="url(#ah-g)"/>
  <text x="513" y="206" text-anchor="middle" fill="#1B9E4B" font-size="11.5" font-weight="700">POST MirrorMeterReading · XML</text>
  <text x="513" y="220" text-anchor="middle" fill="#1B9E4B" font-size="10">+ DERControlResponse ack</text>
</svg>`;

  function DispatchTab({ c }) {
    const ctr = useRef(2);
    const [mRID, setMRID] = useState('DEMO');
    const [connect, setConnect] = useState('unset');     // unset | true | false
    const [useMax, setUseMax] = useState(false);
    const [maxLim, setMaxLim] = useState(2000);
    const [useFixed, setUseFixed] = useState(true);
    const [fixedW, setFixedW] = useState(-3000);
    const [flash, setFlash] = useState(null);
    const [learn, setLearn] = useState(false);

    const ctrl = useMemo(() => {
      const o = { mRID: mRID || 'DEMO' };
      if (connect !== 'unset') o.opModConnect = connect === 'true';
      if (useMax) o.opModMaxLimW = Number(maxLim);
      if (useFixed) o.opModFixedW = Number(fixedW);
      return o;
    }, [mRID, connect, useMax, maxLim, useFixed, fixedW]);

    const previewXml = useMemo(() => FP.xml.xmlDERControlList([ctrl]), [ctrl]);

    const preset = (p) => {
      setConnect('unset'); setUseMax(false); setUseFixed(false);
      if (p === 'discharge') { setUseFixed(true); setFixedW(-3000); }
      if (p === 'charge') { setUseFixed(true); setFixedW(2000); }
      if (p === 'cap') { setUseMax(true); setMaxLim(2000); }
      if (p === 'idle') { setUseFixed(true); setFixedW(0); }
      if (p === 'disconnect') { setConnect('false'); }
      if (p === 'connect') { setConnect('true'); }
    };

    const send = async () => {
      const res = await c.dispatchControl(ctrl);
      setFlash(res.ok ? { ok: true, msg: `202 Accepted · queued ${ctrl.mRID}` } : { ok: false, msg: res.status ? `${res.status}` : 'server unreachable — switch to Simulated in Config' });
      ctr.current += 1; setMRID('CTL-' + ctr.current);
      setTimeout(() => setFlash(null), 4000);
    };

    const s = c.snapshot;
    const p = s ? s.realPowerW : 0;
    const powerSeries = c.history.map((d) => ({ powerW: d.powerW }));

    return h('div', { className: 'grid-dispatch' },
      // composer
      h(U.Card, { title: 'Compose DERControl', sub: 'Sandbox admin (JSON) — stands in for your aggregator’s control logic; not a 2030.5 message. It queues a control the server serves to the client as the 2030.5 DERControlList (XML) shown below.', className: 'span-compose',
        right: h(U.Button, { size: 'sm', variant: 'ghost', icon: 'doc', onClick: () => setLearn(true) }, 'Learn more') },
        h('div', { className: 'presets' },
          h(U.Button, { size: 'sm', variant: 'ghost', icon: 'arrowDown', onClick: () => preset('discharge') }, 'Discharge 3 kW'),
          h(U.Button, { size: 'sm', variant: 'ghost', icon: 'arrowUp', onClick: () => preset('charge') }, 'Charge 2 kW'),
          h(U.Button, { size: 'sm', variant: 'ghost', icon: 'bolt', onClick: () => preset('cap') }, 'Cap 2 kW'),
          h(U.Button, { size: 'sm', variant: 'ghost', icon: 'power', onClick: () => preset('idle') }, 'Idle'),
          h(U.Button, { size: 'sm', variant: 'ghost', icon: 'plug', onClick: () => preset('disconnect') }, 'Disconnect'),
          h(U.Button, { size: 'sm', variant: 'ghost', icon: 'check', onClick: () => preset('connect') }, 'Connect'),
        ),
        h('div', { className: 'compose-head' },
          h(U.Field, { label: 'mRID', hint: 'event id — a control needs an mRID' },
            h(U.TextInput, { value: mRID, onChange: (e) => setMRID(e.target.value), placeholder: 'DEMO' })),
          h(U.Field, { label: 'opModConnect', hint: 'BASIC-009 · connect / disconnect' },
            h(U.Segmented, { value: connect, onChange: setConnect, options: [{ value: 'unset', label: 'Not set' }, { value: 'true', label: 'Connect' }, { value: 'false', label: 'Disconnect' }] })),
        ),
        h('div', { className: 'mode-row' },
          h('div', { className: 'mode-head' },
            h(U.Toggle, { checked: useMax, onChange: setUseMax }),
            h('div', null, h('div', { className: 'mode-t' }, 'opModMaxLimW'), h('div', { className: 'mode-s' }, 'BASIC-010 · clamp max active power (W)'))),
          useMax && h('div', { className: 'mode-ctl' },
            h('input', { className: 'range', type: 'range', min: 0, max: c.fixture.nameplateW, step: 100, value: maxLim, onChange: (e) => setMaxLim(Number(e.target.value)) }),
            h(U.NumberInput, { value: maxLim, onChange: (e) => setMaxLim(Number(e.target.value)), style: { width: 96 } }),
            h('span', { className: 'unit' }, 'W')),
        ),
        h('div', { className: 'mode-row' },
          h('div', { className: 'mode-head' },
            h(U.Toggle, { checked: useFixed, onChange: setUseFixed }),
            h('div', null, h('div', { className: 'mode-t' }, 'opModFixedW'), h('div', { className: 'mode-s' }, 'BASIC-013/014 · signed setpoint · − discharge / + charge'))),
          useFixed && h('div', { className: 'mode-ctl' },
            h('input', { className: 'range', type: 'range', min: -c.fixture.nameplateW, max: c.fixture.nameplateW, step: 100, value: fixedW, onChange: (e) => setFixedW(Number(e.target.value)) }),
            h(U.NumberInput, { value: fixedW, onChange: (e) => setFixedW(Number(e.target.value)), style: { width: 96 } }),
            h('span', { className: 'unit' }, 'W')),
        ),
        h('div', { className: 'compose-foot' },
          h(U.Button, { variant: 'primary', icon: 'bolt', onClick: send }, 'Dispatch control'),
          flash && h('span', { className: 'flash ' + (flash.ok ? 'ok' : 'err') }, h(U.Icon, { name: flash.ok ? 'check' : 'x', size: 14 }), flash.msg)),
        h('div', { className: 'preview' },
          h('div', { className: 'preview-l' }, 'Resulting 2030.5 DERControlList (XML) — GET /derp/0/derc'),
          h(U.Code, { code: previewXml, lang: 'xml' })),
      ),
      // device response + control queue — own column so the tall compose column can't stretch them apart
      h('div', { className: 'dispatch-side' },
      h(U.Card, { title: 'Device response', sub: c.mode === 'live' ? 'how the device reacted · live client /status' : 'how the emulated device reacted · in-browser', className: 'span-live', right: h(U.Badge, { tone: s && s.connected ? 'green' : 'red' }, s && s.connected ? 'connected' : 'disconnected') },
        h('div', { className: 'live-hero', 'data-tone': flowTone(p) },
          h('div', { className: 'live-power' },
            h('span', { className: 'lp-v' }, sign(p), fmtW(p)),
            h('span', { className: 'lp-u' }, unitW(p))),
          h(U.Badge, { tone: flowTone(p) }, flowLabel(p))),
        h('div', { className: 'live-spark' },
          h(U.LineChart, { data: powerSeries.length ? powerSeries : [{ powerW: 0 }], series: [{ key: 'powerW', color: 'var(--c-accent)', fill: true }], height: 76, zeroLine: true, fmtY: (v) => fmtW(v) })),
        h('div', { className: 'live-stats' },
          h(U.Stat, { label: 'State of Charge', value: s ? s.soc.toFixed(1) : '—', unit: '%' }),
          h(U.Stat, { label: 'Voltage ϕA', value: s ? s.voltageV.toFixed(1) : '—', unit: 'V' }),
          h(U.Stat, { label: 'Frequency', value: s ? s.frequencyHz.toFixed(2) : '—', unit: 'Hz' }),
          h(U.Stat, { label: 'Reactive', value: s ? s.reactivePowerVar : '—', unit: 'var' }),
        ),
        h('div', { className: 'live-meta' },
          h('div', null, h('span', { className: 'lm-k' }, 'Last control'), h('span', { className: 'lm-v mono' }, c.lastControl || '—')),
          h('div', null, h('span', { className: 'lm-k' }, 'Last telemetry post'), h('span', { className: 'lm-v' }, ago(c.lastPostAt)))),
      ),
      // queue
      h(U.Card, { title: 'Control queue', sub: 'controls the server will serve to the client', className: 'span-queue' },
        c.controls.length === 0
          ? h(U.Empty, { icon: 'list', title: 'No controls queued', children: 'Dispatch one above — the client applies it on its next poll.' })
          : h('div', { className: 'queue' }, c.controls.slice().reverse().map((q, i) => h('div', { key: i, className: 'queue-i' },
              h('span', { className: 'q-mrid mono' }, q.mRID),
              h('span', { className: 'q-modes' },
                q.opModConnect !== undefined && h(U.Badge, { tone: 'blue' }, 'connect=' + q.opModConnect),
                q.opModMaxLimW !== undefined && h(U.Badge, { tone: 'neutral' }, 'maxLimW=' + q.opModMaxLimW),
                q.opModFixedW !== undefined && h(U.Badge, { tone: flowTone(q.opModFixedW) }, 'fixedW=' + q.opModFixedW)),
            ))))),
      // learn-more modal
      learn && h(U.Modal, { title: 'Two layers: admin injection vs the 2030.5 wire', sub: 'why dispatch uses JSON but the protocol on the wire is XML', wide: true, onClose: () => setLearn(false) },
        h('p', { className: 'prose' }, 'Dispatching a control touches ', h('b', null, 'two different layers'), ' — and only one of them is IEEE 2030.5.'),
        h('div', { className: 'diagram', dangerouslySetInnerHTML: { __html: DISPATCH_DIAGRAM } }),
        h('div', { className: 'learn-cols' },
          h('div', null,
            h('div', { className: 'learn-h', style: { color: 'var(--c-violet)' } }, 'Northbound — how a control is born'),
            h('p', { className: 'prose' }, 'In production this is ', h('b', null, 'your own system'), ' — an operator clicking “curtail,” or a VPP optimizer reacting to a grid signal. IEEE 2030.5 says nothing about it; there is no “create a DERControl” message in the spec. The sandbox fakes this layer with ', h('code', { className: 'inline-mrid' }, 'POST /test/dercontrol'), ' (JSON) so you can drive the loop without an optimizer. It lives under ', h('code', { className: 'inline-mrid' }, '/test/*'), ' precisely because it is not part of the real surface.')),
          h('div', null,
            h('div', { className: 'learn-h', style: { color: 'var(--c-blue)' } }, 'Southbound — how the device learns it'),
            h('p', { className: 'prose' }, 'This is the actual 2030.5 contract. The server merely ', h('b', null, 'serves'), ' what its brain already decided: the DER polls ', h('code', { className: 'inline-mrid' }, 'GET /derp/0/derc'), ' and reads a ', h('code', { className: 'inline-mrid' }, 'DERControlList'), ' (XML), applies it, ACKs with a ', h('code', { className: 'inline-mrid' }, 'DERControlResponse'), ', and posts telemetry as ', h('code', { className: 'inline-mrid' }, 'MirrorMeterReading'), ' (XML).'))),
        h('p', { className: 'prose' }, h('b', null, 'In production you delete '), h('code', { className: 'inline-mrid' }, '/test/dercontrol'), ' and originate controls from your real logic, then serve them as 2030.5 XML. Merging the two would wrongly imply that telling an aggregator what to do is itself a 2030.5 message — it isn’t.')),
    );
  }

  // ===================== TELEMETRY (reader) =====================
  const WINDOW_PRESETS = {
    latest:  { label: 'Latest',     apply: () => ({ after: undefined, start: 0, limit: 1 }) },
    hour:    { label: 'Last hour',  apply: (now) => ({ after: Math.floor(now / 1000) - 3600, start: 0, limit: 50 }) },
    day:     { label: 'Last 24h',   apply: (now) => ({ after: Math.floor(now / 1000) - 86400, start: 0, limit: 50 }) },
    all:     { label: 'Walk all',   apply: () => ({ after: undefined, start: 0, limit: 50 }) },
  };

  function TelemetryTab({ c }) {
    const [drawer, setDrawer] = useState(false);
    const [preset, setPreset] = useState('latest');
    const [learn, setLearn] = useState(false);
    const points = c.query.points;
    const selectedEntries = points.map((p) => FP.findPoint(p)).filter(Boolean);

    const applyPoints = (pts) => { setDrawer(false); c.runRead({ points: pts, start: 0 }); };
    const setWindow = (key) => { setPreset(key); const w = WINDOW_PRESETS[key].apply(Date.now()); c.runRead(w); };
    const removePoint = (p) => c.runRead({ points: points.filter((x) => x !== p), start: 0 });

    const readUrls = [0, 1].map((mup) => {
      const mrids = selectedEntries.filter((e) => (e.tier === 'off-spec' ? 1 : 0) === mup).map((e) => FP.wireMrid(e)).filter(Boolean);
      if (!mrids.length) return null;
      return FP.buildReadUrl({ mup, after: c.query.after, start: c.query.start, limit: c.query.limit, mrids });
    }).filter(Boolean);

    // Group the page's readings into one series per point (by description), so multiple
    // selected points render as distinct lines rather than one interleaved line.
    const byPoint = {};
    for (const r of c.page.readings) (byPoint[r.description] = byPoint[r.description] || []).push(r);
    const seriesNames = Object.keys(byPoint);
    const SERIES_COLORS = ['var(--c-accent)', 'var(--c-blue)', 'var(--c-violet)', 'var(--c-soc)', 'var(--c-amber)', 'var(--c-red)'];
    const maxLen = seriesNames.reduce((m, n) => Math.max(m, byPoint[n].length), 0);
    const chartData = [];
    for (let i = 0; i < maxLen; i++) { const row = {}; for (const n of seriesNames) row[n] = byPoint[n][i] ? byPoint[n][i].value : undefined; chartData.push(row); }
    const chartSeries = seriesNames.map((n, i) => ({ key: n, color: SERIES_COLORS[i % SERIES_COLORS.length], fill: seriesNames.length === 1 }));

    // Follow: while on, re-poll the newest page on a cadence (the current window preset,
    // re-evaluated against Date.now() so "Last 24h" stays a sliding window).
    const refreshRef = useRef(null);
    refreshRef.current = () => { const w = WINDOW_PRESETS[preset].apply(Date.now()); c.runRead(Object.assign({ start: 0 }, w)); };
    useEffect(() => {
      if (!c.query.follow || points.length === 0) return;
      const id = setInterval(() => { if (refreshRef.current) refreshRef.current(); }, 4000);
      return () => clearInterval(id);
    }, [c.query.follow, points.length, preset]);

    return h('div', { className: 'grid-reader' },
      // compose
      h(U.Card, { title: 'Compose a read', sub: 'Pick points by mRID, then a window. Live and historical are the SAME endpoint — only the a/s/l paging params differ.', className: 'span-full',
        right: h(U.Button, { size: 'sm', variant: 'ghost', icon: 'doc', onClick: () => setLearn(true) }, 'Learn more') },
        h('div', { className: 'read-compose' },
          h('div', { className: 'read-row' },
            h(U.Button, { variant: 'primary', icon: 'list', onClick: () => setDrawer(true) }, `Select points (${points.length})`),
            h(U.Segmented, { value: preset, onChange: setWindow, options: Object.keys(WINDOW_PRESETS).map((k) => ({ value: k, label: WINDOW_PRESETS[k].label })) }),
            h(U.Toggle, { checked: c.query.follow, onChange: (v) => c.setQuery(Object.assign({}, c.query, { follow: v })), label: 'Follow' })),
          points.length === 0
            ? h(U.Empty, { icon: 'wave', title: 'No points selected', children: 'Select one or more points to read their telemetry.' })
            : h('div', { className: 'selchips' }, selectedEntries.map((e) => h('span', { key: e.fortressPoint, className: 'selchip' + (e.tier === 'off-spec' ? ' ext' : '') },
                e.display, h('span', { className: 'mono dim' }, FP.wireMrid(e)), h('span', { className: 'x', onClick: () => removePoint(e.fortressPoint) }, '✕')))),
          h('div', { className: 'read-params' },
            h(U.Stat, { label: 'a · after', value: c.query.after ?? '—' }),
            h(U.Stat, { label: 's · start', value: c.query.start }),
            h(U.Stat, { label: 'l · limit', value: c.query.limit })))),
      // request preview
      h(U.Card, { title: 'Resulting 2030.5 request', sub: 'updates as you compose — one GET per MUP touched', className: 'span-reqprev' },
        readUrls.length === 0 ? h(U.Empty, { icon: 'doc', title: 'Select points to see the request' })
          : h(U.Code, { code: readUrls.map((u) => 'GET ' + u).join('\n'), lang: 'text' })),
      // response
      // Note: different points may have different units, so lines share one Y axis.
      h(U.Card, { title: 'Response · MirrorMeterReadingList', sub: 'GET /mup/:m/mr — chart + table + paging', className: 'span-full',
        right: h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
          seriesNames.length ? h(U.Legend, { items: seriesNames.map((n, i) => ({ label: n, color: SERIES_COLORS[i % SERIES_COLORS.length] })) }) : null,
          h(U.Badge, { tone: 'neutral' }, `${c.page.results} / ${c.page.all}`)) },
        c.page.readings.length === 0
          ? h(U.Empty, { icon: 'wave', title: 'No readings', children: 'Pick points and a window, then the response lands here.' })
          : [
            h(U.LineChart, { key: 'ch', data: chartData.length ? chartData : [{ v: 0 }], series: chartSeries.length ? chartSeries : [{ key: 'v', color: 'var(--c-accent)' }], height: 180, zeroLine: true }),
            h(LastReadings, { key: 'tb', readings: c.page.readings }),
            h('div', { className: 'read-meta', key: 'pg' },
              h(U.Button, { size: 'sm', variant: 'ghost', disabled: c.query.start === 0, onClick: () => c.runRead({ start: Math.max(0, c.query.start - c.query.limit) }) }, '◀ Prev'),
              h('span', null, `start ${c.query.start}`),
              h(U.Button, { size: 'sm', variant: 'default', disabled: !c.page.nextHref, onClick: () => c.runRead({ start: c.query.start + c.query.limit }) }, 'Next ▶'),
              h('span', { className: 'sp' }),
              h('span', null, `all=${c.page.all} · results=${c.page.results}`)),
          ]),
      learn && h(U.Modal, { title: 'One read API — live and historical are the same call', sub: 'IEEE 2030.5 §4.6.2 paginated list read', wide: true, onClose: () => setLearn(false) },
        h('p', { className: 'prose' }, 'There is no separate "live" vs "historical" telemetry path. Both are the same paginated ',
          h('code', { className: 'inline-mrid' }, 'GET /mup/{m}/mr'), ' — only the §4.6.2 query params differ: ',
          h('b', null, 'Latest'), ' is the newest page (', h('code', { className: 'inline-mrid' }, 's=0&l=1'),
          '); ', h('b', null, 'history'), ' sets ', h('code', { className: 'inline-mrid' }, 'a'), ' (after-time) and pages forward with ',
          h('code', { className: 'inline-mrid' }, 's'), '/', h('code', { className: 'inline-mrid' }, 'l'), ', stopping reader-side when timestamps pass your upper bound.'),
        h('p', { className: 'prose' }, 'Points are selected by ', h('b', null, 'mRID'), ' (resource addressing) — official like ',
          h('code', { className: 'inline-mrid' }, 'model101W'), ' or ', h('code', { className: 'inline-mrid' }, 'fortress:soh'),
          '. There is no "filter by mRID set" verb in the spec; you address the per-point resources. ',
          h('code', { className: 'inline-mrid' }, 'fortress:*'), ' points ride a second MirrorUsagePoint (', h('code', { className: 'inline-mrid' }, '/mup/1'), ').')),
      drawer && h(window.TABS.PointsDrawer, { selected: points, onApply: applyPoints, onClose: () => setDrawer(false) }));
  }

  function LastReadings({ readings }) {
    // collapse to latest per description
    const latest = {};
    readings.forEach((r) => { latest[r.description || r.mRID] = r; });
    const rows = Object.values(latest);
    return h('table', { className: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, 'Point'), h('th', null, 'mRID'), h('th', null, 'uom'), h('th', { className: 'r' }, 'value'), h('th', null, 'convention'))),
      h('tbody', null, rows.map((r) => h('tr', { key: r.description || r.mRID },
        h('td', { className: 'mono' }, r.description || '—'),
        h('td', { className: 'mono dim' }, r.mRID),
        h('td', null, FP.UOM_LABEL[r.uom] || r.uom),
        h('td', { className: 'r mono' }, isNaN(r.value) ? '—' : r.value),
        h('td', { className: 'mono dim' }, r.convention || '')))));
  }

  // ===================== LANE BADGE (used by drawer) =====================
  function LaneBadge({ lane }) {
    const L = FP.LANES[lane];
    return h('span', { className: 'lane-badge lane-' + lane, title: L.blurb },
      lane === 'extension' && h('span', { className: 'lane-dot' }), L.label);
  }

  // ===================== CONFIG =====================
  function ConfigTab({ c }) {
    const cfg = c.config;
    const [learn, setLearn] = useState(false);
    const [probe, setProbe] = useState(null);
    const lastPoll = useRef(cfg.controlPollSec || 4);
    const lastPost = useRef(cfg.telemetryPostSec || 4);
    const doReprobe = async () => {
      setProbe({ msg: 'Probing…', ok: null });
      const { serverOk, clientOk } = await c.reprobe();
      const reached = serverOk && clientOk ? 'example-server + client /status reachable'
        : serverOk ? 'example-server reachable; client /status not responding'
        : clientOk ? 'client /status reachable; example-server not responding'
        : 'nothing reachable on those URLs';
      const result = (serverOk || clientOk)
        ? (c.autoMode ? '— connected, switched to Live' : '— live data refreshed')
        : (c.autoMode ? '— staying Simulated (in-browser loop)' : '— still nothing live');
      setProbe({ msg: reached + ' ' + result, ok: serverOk || clientOk });
      setTimeout(() => setProbe(null), 6000);
    };
    const pollOn = cfg.controlPollSec > 0, postOn = cfg.telemetryPostSec > 0;
    const envStr = [
      `CSIP_SERVER_URL=${cfg.serverUrl}`,
      `CSIP_CONTROL_POLL_SEC=${cfg.controlPollSec}`,
      `CSIP_TELEMETRY_POST_SEC=${cfg.telemetryPostSec}`,
      `CSIP_SUBSCRIPTION=${cfg.subscription.join(',')}`,
      `CSIP_INSPECT_PORT=7100`,
    ].join('\n');
    return h('div', { className: 'grid-config' },
      h(U.Card, { title: 'Connection', sub: 'auto-detects the running sandbox; falls back to the in-browser simulation', className: 'span-conn',
        right: h(U.Button, { size: 'sm', variant: 'ghost', icon: 'doc', onClick: () => setLearn(true) }, 'Why two modes?') },
        h('div', { className: 'conn-mode' },
          h(U.Field, { label: 'Mode' },
            h(U.Segmented, { value: c.autoMode ? 'auto' : c.mode, onChange: (v) => { if (v === 'auto') { c.setAutoMode(true); doReprobe(); } else c.switchMode(v); },
              options: [{ value: 'auto', label: 'Auto' }, { value: 'live', label: 'Live', icon: 'plug' }, { value: 'sim', label: 'Simulated', icon: 'wave' }] })),
          h('div', { className: 'conn-now' }, h(U.Badge, { tone: c.mode === 'live' ? 'green' : 'blue' }, c.mode === 'live' ? 'LIVE — talking to sandbox' : 'SIMULATED — in-browser loop'))),
        h('div', { className: 'conn-dots' },
          h('div', { className: 'conn-dot' }, h(U.StatusDot, { ok: c.conn.server, pulse: c.conn.server }), h('span', null, 'example-server'), h('code', null, cfg.serverUrl)),
          h('div', { className: 'conn-dot' }, h(U.StatusDot, { ok: c.conn.client, pulse: c.conn.client }), h('span', null, 'client /status'), h('code', null, cfg.clientUrl))),
        h('div', { className: 'compose-grid' },
          h(U.Field, { label: 'Server URL', hint: 'CSIP_SERVER_URL · admin + 2030.5' }, h(U.TextInput, { value: cfg.serverUrl, onChange: (e) => c.setConfig({ serverUrl: e.target.value }) })),
          h(U.Field, { label: 'Client URL', hint: 'CSIP_INSPECT_PORT · /status' }, h(U.TextInput, { value: cfg.clientUrl, onChange: (e) => c.setConfig({ clientUrl: e.target.value }) }))),
        h('div', { className: 'conn-actions' },
          h(U.Button, { variant: 'default', icon: 'refresh', onClick: doReprobe }, 'Re-probe connection'),
          h('a', { className: 'btn btn-ghost btn-sm', href: cfg.serverUrl + '/docs', target: '_blank', rel: 'noopener' }, h(U.Icon, { name: 'doc', size: 14 }), h('span', null, 'API docs (Swagger)')),
          probe && h('span', { className: 'probe-msg', 'data-ok': probe.ok === null ? undefined : String(probe.ok) },
            h(U.Icon, { name: probe.ok === null ? 'refresh' : probe.ok ? 'check' : 'x', size: 13 }), probe.msg))),
      h(U.Card, { title: 'Cadence', sub: c.mode === 'live' ? 'retunes the live client’s poll/post loop in real time · toggle off or set the interval' : 'drives the in-browser simulated loop · toggle off or set the interval', className: 'span-cad' },
        h('div', { className: 'cad' },
          h('div', { className: 'cad-row' },
            h('div', { className: 'cad-head' },
              h('span', { className: 'cad-l' }, pollOn ? `Control poll · every ${cfg.controlPollSec}s` : 'Control poll · Off'),
              h('code', { className: 'cad-env' }, 'CSIP_CONTROL_POLL_SEC')),
            h('div', { className: 'cad-ctl' },
              h(U.Toggle, { checked: pollOn, onChange: (on) => { if (on) c.setCadence({ controlPollSec: lastPoll.current || 4 }); else { lastPoll.current = cfg.controlPollSec; c.setCadence({ controlPollSec: 0 }); } } }),
              h('input', { className: 'range', type: 'range', min: 1, max: 30, value: pollOn ? cfg.controlPollSec : (lastPoll.current || 4), disabled: !pollOn, onChange: (e) => c.setCadence({ controlPollSec: Number(e.target.value) }) }))),
          h('div', { className: 'cad-row' },
            h('div', { className: 'cad-head' },
              h('span', { className: 'cad-l' }, postOn ? `Telemetry post · every ${cfg.telemetryPostSec}s` : 'Telemetry post · Off'),
              h('code', { className: 'cad-env' }, 'CSIP_TELEMETRY_POST_SEC')),
            h('div', { className: 'cad-ctl' },
              h(U.Toggle, { checked: postOn, onChange: (on) => { if (on) c.setCadence({ telemetryPostSec: lastPost.current || 4 }); else { lastPost.current = cfg.telemetryPostSec; c.setCadence({ telemetryPostSec: 0 }); } } }),
              h('input', { className: 'range', type: 'range', min: 1, max: 30, value: postOn ? cfg.telemetryPostSec : (lastPost.current || 4), disabled: !postOn, onChange: (e) => c.setCadence({ telemetryPostSec: Number(e.target.value) }) }))))),
      h(U.Card, { title: 'Site fixture', sub: 'SyntheticGenerator · SANDBOX-SITE-1', className: 'span-fix' },
        h('div', { className: 'fix-grid' },
          h(U.Stat, { label: 'LFDI', value: c.fixture.lFDI }),
          h(U.Stat, { label: 'Nameplate', value: (c.fixture.nameplateW / 1000).toFixed(1), unit: 'kW' }),
          h(U.Stat, { label: 'Capacity', value: (c.fixture.capacityWh / 1000).toFixed(1), unit: 'kWh' }),
          h(U.Stat, { label: 'Initial SoC', value: c.fixture.initialSoC, unit: '%' }))),
      h(U.Card, { title: 'Equivalent environment', sub: 'docker-compose / client env for the current settings', className: 'span-env' },
        h(U.Code, { code: envStr, lang: 'text' })),
      h(U.Card, { title: 'Sandbox state', sub: 'clear all in-memory stores', className: 'span-danger', accent: 'danger' },
        h('p', { className: 'prose' }, 'POST /test/reset clears queued controls, received meter readings and DER statuses', c.mode === 'sim' ? ' and resets the simulated site to 50% SoC.' : '.'),
        h(U.Button, { variant: 'danger', icon: 'refresh', onClick: () => c.reset() }, 'Reset sandbox')),
      learn && h(U.Modal, { title: 'Two modes: Simulated vs Live', sub: 'why the console has both', wide: true, onClose: () => setLearn(false) },
        h('div', { className: 'learn-cols' },
          h('div', null,
            h('div', { className: 'learn-h', style: { color: 'var(--c-blue)' } }, 'Simulated — the zero-setup demo'),
            h('p', { className: 'prose' }, 'The whole closed loop runs ', h('b', null, 'in this browser tab'), ' — a 1:1 port of the real client plus a mock server. No Docker, works offline, deterministic. Ideal for learning the protocol shapes and the UX. But it is an imitation, single-tab: there is no real wire, and no seam to plug in your own server.')),
          h('div', null,
            h('div', { className: 'learn-h', style: { color: 'var(--c-accent-d)' } }, 'Live — the real integration surface'),
            h('p', { className: 'prose' }, 'The console talks to the ', h('b', null, 'actual running artifacts'), ' — the real Fortress client (', h('code', { className: 'inline-mrid' }, ':7100'), ') and example-server (', h('code', { className: 'inline-mrid' }, ':7001'), '). Real 2030.5 XML over a real socket, real status codes, real failures, real persistence you can also hit from curl or Swagger.'))),
        h('p', { className: 'prose' }, h('b', null, 'Why it matters: '), 'your job is to ', h('b', null, 'replace the example-server with your own server'), ' and run it against the real Fortress client. Point ', h('code', { className: 'inline-mrid' }, 'Server URL'), ' at your server and switch to Live — the console becomes a window onto how your server handles the real client’s traffic. Simulated can’t do that; it has no real wire. In short: ', h('b', null, 'Simulated is the tutorial; Live is what you integrate against.'))),
    );
  }

  // ===================== WIRE LOG =====================
  const DIR_META = {
    poll: { label: 'POLL', tone: 'blue' }, post: { label: 'POST', tone: 'green' }, admin: { label: 'ADMIN', tone: 'violet' },
  };
  function statusTone(s) { return s === 0 ? 'red' : s < 300 ? 'green' : s < 400 ? 'blue' : 'red'; }

  function WireLog({ c, compact }) {
    const [filter, setFilter] = useState('all');
    const [selId, setSelId] = useState(null);
    const listRef = useRef(null);
    const items = filter === 'all' ? c.wire : c.wire.filter((w) => w.dir === filter);
    const sel = items.find((w) => w.id === selId) || items[items.length - 1];
    useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [c.wire.length, filter]);

    const list = h('div', { className: 'wire-list', ref: listRef },
      items.length === 0 ? h(U.Empty, { icon: 'doc', title: 'No traffic yet' }) :
        items.map((w) => h('button', { key: w.id, className: 'wire-row' + (sel && sel.id === w.id ? ' on' : ''), onClick: () => setSelId(w.id) },
          h('span', { className: 'wr-time mono' }, new Date(w.ts).toLocaleTimeString('en-US', { hour12: false })),
          h('span', { className: 'badge tone-' + DIR_META[w.dir].tone + ' xs' }, DIR_META[w.dir].label),
          h('span', { className: 'wr-method mono' }, w.method),
          h('span', { className: 'wr-path mono' }, w.path),
          h('span', { className: 'badge tone-' + statusTone(w.status) + ' xs' }, w.status || 'ERR'),
          h('span', { className: 'wr-label' }, w.label))));

    const detail = h('div', { className: 'wire-detail' },
      sel ? [
        h('div', { className: 'wd-head', key: 'hd' },
          h('span', { className: 'wr-method mono' }, sel.method), h('span', { className: 'wr-path mono' }, sel.path),
          h('span', { className: 'badge tone-' + statusTone(sel.status) + ' xs' }, sel.status || 'ERR'),
          h('span', { className: 'wd-label' }, sel.label)),
        h(U.Code, { key: 'cd', code: sel.body, lang: sel.body && sel.body.trim().startsWith('{') ? 'json' : 'xml' }),
      ] : h(U.Empty, { icon: 'doc', title: 'Select a request' }));

    return h('div', { className: 'wire' + (compact ? ' compact' : '') },
      h('div', { className: 'wire-bar' },
        h(U.Segmented, { value: filter, onChange: setFilter, options: [{ value: 'all', label: 'All' }, { value: 'poll', label: 'Poll' }, { value: 'post', label: 'Post' }, { value: 'admin', label: 'Admin' }] }),
        h('span', { className: 'wire-count' }, items.length + ' / 300'),
        h(U.Button, { size: 'sm', variant: 'ghost', icon: 'x', onClick: c.clearWire }, 'Clear')),
      h('div', { className: 'wire-body' }, list, detail));
  }

  // Detail level → which tiers are visible (progressive disclosure for hundreds of points).
  const DETAIL_LEVELS = { standard: ['standard'], extended: ['standard', 'extended'], complete: ['standard', 'extended', 'complete'] };

  function PointsDrawer({ selected, onApply, onClose }) {
    const [sel, setSel] = useState(() => new Set(selected));
    const [q, setQ] = useState('');
    const [detail, setDetail] = useState('standard');
    const [open, setOpen] = useState(() => new Set());   // expanded model groups
    const levels = DETAIL_LEVELS[detail];

    const matches = (e) => {
      if (!levels.includes(e.levelOfDetail || 'complete')) return false;
      if (!q.trim()) return true;
      const s = q.toLowerCase();
      return `${e.display} ${e.fortressPoint} ${e.desc || ''} ${FP.wireMrid(e) || ''}`.toLowerCase().includes(s);
    };
    const shown = FP.CATALOG.filter(matches);
    const groups = {};
    for (const e of shown) { const key = e.category || 'Other'; (groups[key] = groups[key] || []).push(e); }
    const groupKeys = Object.keys(groups).sort();
    const toggleGroup = (k) => setOpen((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
    const toggle = (pt) => setSel((p) => { const n = new Set(p); n.has(pt) ? n.delete(pt) : n.add(pt); return n; });

    return h('div', { className: 'drawer-overlay', onClick: onClose },
      h('div', { className: 'drawer', onClick: (e) => e.stopPropagation() },
        h('div', { className: 'drawer-h' }, h(U.Icon, { name: 'list', size: 17 }), h('h3', null, 'Select telemetry points'),
          h('button', { className: 'drawer-x', onClick: onClose, 'aria-label': 'Close' }, h(U.Icon, { name: 'x', size: 18 }))),
        h('div', { className: 'drawer-tools' },
          h('div', { className: 'cat-search' }, h(U.Icon, { name: 'list', size: 15, className: 'cs-icn' }),
            h('input', { className: 'cs-inp', placeholder: 'Search points, descriptions, mRIDs…', value: q, onChange: (e) => setQ(e.target.value) })),
          h('div', { className: 'drawer-detail' }, h('span', null, 'Detail level'),
            h(U.Segmented, { value: detail, onChange: setDetail, options: [{ value: 'standard', label: 'Standard' }, { value: 'extended', label: 'Extended' }, { value: 'complete', label: 'Complete' }] }),
            h('span', { className: 'dim' }, 'Standard = core points · Extended = + common · Complete = everything'))),
        h('div', { className: 'drawer-body' },
          groupKeys.length === 0 ? h(U.Empty, { icon: 'list', title: 'No points match' })
          : h('div', { className: 'cat-acc' }, groupKeys.map((k) => {
              const isOpen = open.has(k); const pts = groups[k];
              const subCount = pts.filter((e) => sel.has(e.fortressPoint)).length;
              return h('div', { key: k, className: 'mgrp' },
                h('button', { className: 'mgrp-h', onClick: () => toggleGroup(k), 'aria-expanded': isOpen },
                  h(U.Icon, { name: 'chevron', size: 14, className: 'mg-chev' + (isOpen ? ' open' : '') }),
                  h('span', { className: 'mgrp-n' }, k),
                  h('span', { className: 'mgrp-c' }, subCount > 0 ? `${subCount}/${pts.length}` : pts.length)),
                isOpen && h('div', { className: 'mgrp-b' }, pts.map((e) => h('div', { key: e.fortressPoint, className: 'pt-row' + (sel.has(e.fortressPoint) ? ' on' : '') },
                  h(U.Toggle, { checked: sel.has(e.fortressPoint), onChange: () => toggle(e.fortressPoint) }),
                  h('div', { className: 'pt-main', onClick: () => toggle(e.fortressPoint) },
                    h('div', { className: 'pt-name' }, e.display, h('span', { className: 'pt-unit' }, e.unit || '—')),
                    h('div', { className: 'pt-meta' }, h('span', { className: 'pm mono' }, FP.wireMrid(e) || e.fortressPoint))),
                  h(LaneBadge, { lane: FP.laneOf(e) })))));
            }))),
        h('div', { className: 'drawer-foot' },
          h('span', { className: 'cnt' }, sel.size + ' selected'),
          h('span', { className: 'sp' }),
          h(U.Button, { size: 'sm', variant: 'ghost', onClick: () => setSel(new Set()) }, 'Clear'),
          h(U.Button, { size: 'sm', variant: 'primary', onClick: () => onApply([...sel]) }, 'Apply'))));
  }

  // ===================== DEVELOPER GUIDE =====================
  function GuideTab({ c }) {
    const go = (tab) => () => { window.location.hash = tab; };
    const code = (s) => h('code', { className: 'inline-mrid' }, s);
    const STEPS = [
      { n: 1, tag: 'Start here', tone: 'green', title: 'Stream the basic telemetry', tab: 'telemetry', icon: 'wave', cta: 'Open Telemetry',
        body: [
          h('p', { className: 'prose' }, h('b', null, 'Goal — '), 'see the CSIP-required readings flow over the real 2030.5 wire.'),
          h('p', { className: 'prose' }, h('b', null, 'How — '), 'open ', h('b', null, 'Telemetry → Select points'), ', keep ', h('b', null, 'Detail level: Standard'), ', and pick Real Power, State of Charge, and Voltage. Choose the ', h('b', null, 'Latest'), ' window and turn ', h('b', null, 'Follow'), ' on.'),
          h('p', { className: 'prose' }, h('b', null, 'Watch — '), 'the request preview shows ', code('GET /mup/0/mr?s=0&l=1'), ', and the 2030.5 wire rail logs each read. This is the one canonical telemetry read.'),
        ] },
      { n: 2, tag: null, title: 'Add more telemetry (incl. the Fortress lane)', tab: 'telemetry', icon: 'wave', cta: 'Open Telemetry',
        body: [
          h('p', { className: 'prose' }, h('b', null, 'Goal — '), 'subscribe to more points, including Fortress extension points carried on the vendor lane.'),
          h('p', { className: 'prose' }, h('b', null, 'How — '), 'in the points drawer raise ', h('b', null, 'Detail level'), ' to ', h('b', null, 'Extended'), ' or ', h('b', null, 'Complete'), ', then add points from groups like ', h('b', null, 'Battery'), ' or ', h('b', null, 'Grid'), ', plus a ', code('fortress:'), ' point such as State of Health.'),
          h('p', { className: 'prose' }, h('b', null, 'Watch — '), 'Fortress points are addressed by ', code('fortress:*'), ' mRIDs and ride a ', h('b', null, 'second MirrorUsagePoint'), ' (', code('/mup/1'), ') — a second ', code('GET'), ' appears in the request preview and wire.'),
        ] },
      { n: 3, tag: null, title: 'Read historical telemetry', tab: 'telemetry', icon: 'wave', cta: 'Open Telemetry',
        body: [
          h('p', { className: 'prose' }, h('b', null, 'Goal — '), 'page back through history — the same endpoint, just different paging params.'),
          h('p', { className: 'prose' }, h('b', null, 'How — '), 'switch the window to ', h('b', null, 'Last hour'), ', ', h('b', null, 'Last 24h'), ', or ', h('b', null, 'Walk all'), ', then page with ', h('b', null, 'Next ▶'), '.'),
          h('p', { className: 'prose' }, h('b', null, 'Watch — '), 'only the §4.6.2 params change: ', code('a'), ' (after), ', code('s'), ' (start), ', code('l'), ' (limit). ', h('b', null, 'Live and historical are the same call'), ' — live is the newest page; history pages backward.'),
        ] },
      { n: 4, tag: 'Optional', tone: 'neutral', title: 'Dispatch a control', tab: 'dispatch', icon: 'bolt', cta: 'Open Dispatch',
        body: [
          h('p', { className: 'prose' }, h('b', null, 'Goal — '), 'if your program issues controls, drive the DER and watch it respond. Telemetry-only integrations can skip this.'),
          h('p', { className: 'prose' }, h('b', null, 'How — '), 'open ', h('b', null, 'Dispatch'), ', compose ', code('opModConnect'), ' / ', code('opModMaxLimW'), ' / ', code('opModFixedW'), ' with an mRID (or use a preset), and dispatch.'),
          h('p', { className: 'prose' }, h('b', null, 'Watch — '), 'the server queues it; the client applies it on its next poll and ACKs with a ', code('DERControlResponse'), '. The composed ', code('DERControlList'), ' XML previews live as you build it.'),
        ] },
    ];
    return h('div', { className: 'grid-guide' },
      h(U.Card, { title: 'Developer guide', sub: 'A suggested path to build your IEEE 2030.5 / CSIP integration against the Fortress client' },
        h('p', { className: 'prose' }, 'This sandbox runs a correct Fortress ', h('b', null, 'client'), ' (the DER) against an example ', h('b', null, 'server'), ' (the aggregator you’ll eventually replace with your own). Work through the steps below in order — each links to the tab where you do it. Most integrations are ', h('b', null, 'telemetry-first'), '; control is optional.'),
        h('p', { className: 'prose' }, 'Not sure whether you’re seeing simulated or real traffic? See ', h('b', null, 'Config → Why two modes?'), ' — ', h('b', null, 'Simulated'), ' runs entirely in this browser tab; ', h('b', null, 'Live'), ' talks to the running containers.')),
      STEPS.map((s) => h(U.Card, { key: s.n, className: 'gstep' },
        h('div', { className: 'gstep-h' },
          h('div', { className: 'gstep-n' }, String(s.n)),
          h('div', { className: 'gstep-t' }, s.title),
          s.tag && h(U.Badge, { tone: s.tone }, s.tag)),
        s.body,
        h('div', { className: 'gstep-foot' },
          h(U.Button, { variant: 'default', size: 'sm', icon: s.icon, onClick: go(s.tab) }, s.cta)))),
      h(U.Card, { title: 'When you’re ready: bring your own server', sub: 'the example server is a stand-in', accent: undefined },
        h('p', { className: 'prose' }, 'To integrate for real, ', h('b', null, 'replace the example server with your own'), ', point ', h('b', null, 'Config → Server URL'), ' at it, and switch to ', h('b', null, 'Live'), '. The console then becomes a window onto how your server handles the real Fortress client’s traffic.'),
        h('div', { className: 'gstep-foot' },
          h(U.Button, { variant: 'default', size: 'sm', icon: 'gear', onClick: () => { window.location.hash = 'config'; } }, 'Open Config'),
          h('a', { className: 'btn btn-ghost btn-sm', href: c.config.serverUrl + '/docs', target: '_blank', rel: 'noopener' }, h(U.Icon, { name: 'doc', size: 14 }), h('span', null, 'API reference (Swagger)')))),
    );
  }

  window.TABS = { GuideTab, DispatchTab, TelemetryTab, ConfigTab, WireLog, PointsDrawer };
})();
