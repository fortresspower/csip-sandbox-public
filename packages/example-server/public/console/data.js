/* Fortress CSIP Sandbox Console — protocol data + wire serializers.
   Ported 1:1 from the repo so the console maps onto the real contract:
   - packages/protocol/src/catalog.ts   (telemetry point catalog + tiers)
   - packages/protocol/src/uom.ts       (IEEE 2030.5 Annex A UomType codes)
   - packages/protocol/src/xml.ts       (serializeMirrorMeterReading / parseDERControlList)
   - packages/client/src/generator.ts   (SyntheticGenerator fixture)
   Exposes a single global: window.FP
*/
(function () {
  const NS = 'urn:ieee:std:2030.5:ns';

  // IEEE 2030.5-2018 Annex A UomType (IEC 61968-9) — uom.ts
  const Uom = { Amps: 5, Voltage: 29, Hz: 33, W: 38, VA: 61, var: 63, CosTheta: 65, Wh: 72 };
  const UOM_LABEL = {
    0: 'n/a', 5: 'A', 29: 'V', 33: 'Hz', 38: 'W', 61: 'VA', 63: 'var', 65: 'PF', 72: 'Wh',
  };

  // catalog.ts — single source of truth for Fortress telemetry → 2030.5 mapping.
  // `display`/`unit`/`desc`/`scale` are console-only display metadata (not on the wire).
  // LANE: 'standard' = native IEEE 2030.5 representation (csip-required / spec-optional).
  //       'extension' = no native 2030.5 slot, carried as first-class Fortress extension
  //       telemetry on the vendor lane via published fortress:* mRIDs (off-spec tier).
  // `scale` = powerOfTenMultiplier (engineering value = posted integer × 10^scale); null when N/A.
  const CATALOG = [
    // --- csip-required (BASIC-029 / BASIC-028 / CORE-014) ---
    { fortressPoint: 'model101.W',      display: 'Real Power',        unit: 'W',  scale: 0,    sunspec: { modelId: 101, offset: 14 }, tier: 'csip-required', category: 'AC Side', levelOfDetail: 'standard', mapping: { kind: 'reading-type', uom: Uom.W, flowDirection: 1 }, desc: 'Net AC active power at the point of common coupling. Negative = exporting / discharging, positive = importing / charging.' },
    { fortressPoint: 'model101.VAr',    display: 'Reactive Power',    unit: 'var',scale: 0,    sunspec: { modelId: 101, offset: 20 }, tier: 'csip-required', category: 'AC Side', levelOfDetail: 'standard', mapping: { kind: 'reading-type', uom: Uom.var }, desc: 'AC reactive power at the inverter terminals.' },
    { fortressPoint: 'model101.Hz',     display: 'Frequency',         unit: 'Hz', scale: -2,   sunspec: { modelId: 101, offset: 16 }, tier: 'csip-required', category: 'AC Side', levelOfDetail: 'standard', mapping: { kind: 'reading-type', uom: Uom.Hz }, desc: 'Grid frequency at the inverter AC terminals. Posted as centi-hertz (×10⁻²).' },
    { fortressPoint: 'model101.PhVphA', display: 'Voltage · Phase A', unit: 'V',  scale: -1,   sunspec: { modelId: 101, offset: 10 }, tier: 'csip-required', category: 'AC Side', levelOfDetail: 'standard', mapping: { kind: 'reading-type', uom: Uom.Voltage }, desc: 'Phase-A line voltage. Posted as deci-volts (×10⁻¹).' },
    { fortressPoint: 'model802.SoC',    display: 'State of Charge',   unit: '%',  scale: null, sunspec: { modelId: 802, offset: 11 }, tier: 'csip-required', category: 'Battery', levelOfDetail: 'standard', mapping: { kind: 'der-status-field', field: 'stateOfChargeStatus' }, desc: 'Battery state of charge. Travels in a DERStatus document (stateOfChargeStatus), not a MirrorMeterReading.' },
    { fortressPoint: 'model802.State',  display: 'Operational State', unit: '',   scale: null, sunspec: { modelId: 802, offset: 22 }, tier: 'csip-required', category: 'Battery', levelOfDetail: 'standard', mapping: { kind: 'der-status-field', field: 'operationalModeStatus' }, desc: 'Operational mode / connection state of the storage DER. Travels in DERStatus.operationalModeStatus.' },
    { fortressPoint: 'model802.WHRtg',  display: 'Storage Nameplate', unit: 'Wh', scale: null, sunspec: { modelId: 802, offset: 3  }, tier: 'csip-required', category: 'Battery', levelOfDetail: 'standard', mapping: { kind: 'der-capability-field', field: 'rtgMaxWh' }, desc: 'Rated usable energy capacity (nameplate Wh). Travels in DERCapability.rtgMaxWh.' },
    // --- spec-optional (a real 2030.5 home, beyond the floor) ---
    { fortressPoint: 'model101.WH',     display: 'AC Energy',         unit: 'Wh', scale: 0,    sunspec: { modelId: 101, offset: 24 }, tier: 'spec-optional', category: 'AC Side', levelOfDetail: 'extended', mapping: { kind: 'reading-type', uom: Uom.Wh }, desc: 'Lifetime AC energy throughput.' },
    { fortressPoint: 'model101.PF',     display: 'Power Factor',      unit: 'PF', scale: -2,   sunspec: { modelId: 101, offset: 22 }, tier: 'spec-optional', category: 'AC Side', levelOfDetail: 'extended', mapping: { kind: 'reading-type', uom: Uom.CosTheta }, desc: 'Displacement power factor (cos θ). Posted ×10⁻².' },
    { fortressPoint: 'model101.AphA',   display: 'Current · Phase A', unit: 'A',  scale: -2,   sunspec: { modelId: 101, offset: 3  }, tier: 'spec-optional', category: 'AC Side', levelOfDetail: 'extended', mapping: { kind: 'reading-type', uom: Uom.Amps }, desc: 'Phase-A line current. Posted as centi-amps (×10⁻²).' },
    // --- off-spec: Fortress extension showcase on a real 40k model (vendor lane via fortress:* mRIDs) ---
    { fortressPoint: 'model40101.sohBat',  display: 'State of Health',   unit: '%', scale: 0,  sunspec: { modelId: 40101, offset: 42 }, tier: 'off-spec', category: 'Battery', levelOfDetail: 'extended', mapping: { kind: 'extension', uom: 0,     conventionMrid: 'fortress:soh' }, desc: 'Battery state of health, as a percentage. IEEE 2030.5-2018 Annex A has no percent UomType, so uom is 0 (not applicable); the fortress:soh mRID conveys that this reading is a SoH % out of band.' },
    { fortressPoint: 'model40101.pBkupTot',display: 'Backup Port Power', unit: 'W', scale: 0,  sunspec: { modelId: 40101, offset: 88 }, tier: 'off-spec', category: 'Backup Power', levelOfDetail: 'extended', mapping: { kind: 'extension', uom: Uom.W, conventionMrid: 'fortress:backup-power' }, desc: 'Total power delivered to the protected backup port. A watt value with no dedicated CSIP point — carried on the Fortress lane.' },
  ];
  // Append generated extension-lane points (catalog-data.js); curated entries win on key.
  (function mergeGenerated() {
    const gen = (typeof window !== 'undefined' && window.FP_GENERATED) || [];
    const have = new Set(CATALOG.map((e) => e.fortressPoint));
    for (const e of gen) if (!have.has(e.fortressPoint)) CATALOG.push(e);
  })();

  const TIERS = {
    'csip-required': { label: 'CSIP Required', blurb: 'The floor that locks the contract — real/reactive power, frequency, voltage, SoC, operational state, storage nameplate.' },
    'spec-optional': { label: 'Spec Optional', blurb: 'Beyond the floor but with a real 2030.5 home — AC energy, power factor, per-phase current.' },
    'off-spec':      { label: 'Off Spec',      blurb: 'No native IEEE 2030.5 slot — carried as first-class Fortress extension telemetry on the vendor lane via published fortress:* mRIDs.' },
  };

  // generator.ts fixture
  const FIXTURE = { lFDI: 'SANDBOX-SITE-1', nameplateW: 5000, capacityWh: 13500, initialSoC: 50 };

  // config.ts default subscription (the five CSIP-required points)
  const SUB_DEFAULT = ['model101.W', 'model101.VAr', 'model101.Hz', 'model101.PhVphA', 'model802.SoC'];

  const findPoint = (p) => CATALOG.find((e) => e.fortressPoint === p);
  const byTier = (t) => CATALOG.filter((e) => e.tier === t);

  // lane: standard (native 2030.5) vs extension (Fortress vendor lane via fortress:* mRIDs)
  const laneOf = (e) => (e.tier === 'off-spec' ? 'extension' : 'standard');
  const LANES = {
    standard:  { label: 'IEEE 2030.5',       short: 'Standard',     blurb: 'Native IEEE 2030.5 representation — MirrorMeterReading, DERStatus or DERCapability.' },
    extension: { label: 'Fortress extension', short: 'Fortress ext', blurb: 'No native 2030.5 slot. Carried as data on the Fortress vendor lane via a published fortress:* mRID — partners need the fortress:* mRID dictionary to decode these.' },
  };
  // the identifier a point is keyed by on the wire (null when it travels in DERStatus/DERCapability)
  const wireMrid = (e) => {
    if (e.mapping.kind === 'extension') return e.mapping.conventionMrid;
    if (e.mapping.kind === 'reading-type') return e.fortressPoint.replace(/\W/g, '');
    return null;
  };

  // ---- read-url helpers (mirror protocol/src/read-url.ts for the console) ----
  function buildReadUrl({ mup, after, start, limit, mrids }) {
    const q = [];
    if (after !== undefined && after !== null) q.push('a=' + after);
    q.push('s=' + (start || 0)); q.push('l=' + (limit || 1));
    for (const m of mrids || []) q.push('mrid=' + encodeURIComponent(m));
    return '/mup/' + mup + '/mr?' + q.join('&');
  }
  function parseReadPage(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const root = doc.getElementsByTagName('MirrorMeterReadingList')[0];
    const readings = Array.from(doc.getElementsByTagName('MirrorMeterReading')).map((m) => {
      const g = (t) => m.getElementsByTagName(t)[0]?.textContent ?? '';
      const rt = m.getElementsByTagName('ReadingType')[0];
      return { mRID: g('mRID'), description: g('description'), uom: Number(rt?.getElementsByTagName('uom')[0]?.textContent ?? 0),
        convention: rt?.getElementsByTagName('mRID')[0]?.textContent ?? undefined,
        value: Number(m.getElementsByTagName('value')[0]?.textContent), start: Number(m.getElementsByTagName('start')[0]?.textContent ?? 0) };
    });
    const link = doc.getElementsByTagName('Link')[0];
    return { readings, all: Number(root?.getAttribute('all') ?? readings.length), results: Number(root?.getAttribute('results') ?? readings.length),
      nextHref: link?.getAttribute('href') ?? null };
  }

  // ---- wire serializers (mirror routes.ts / xml.ts / state-machine.ts) ----
  const decl = '<?xml version="1.0" encoding="UTF-8"?>\n';

  function xmlDcap() {
    return decl + `<DeviceCapability xmlns="${NS}" href="/dcap" pollRate="30"><MirrorUsagePointListLink href="/mup"/><EndDeviceListLink href="/edev"/><TimeLink href="/tm"/></DeviceCapability>`;
  }
  function controlInner(c) {
    const base = [
      c.opModConnect !== undefined ? `<opModConnect>${c.opModConnect}</opModConnect>` : '',
      c.opModMaxLimW !== undefined ? `<opModMaxLimW>${c.opModMaxLimW}</opModMaxLimW>` : '',
      c.opModFixedW !== undefined ? `<opModFixedW>${c.opModFixedW}</opModFixedW>` : '',
    ].join('');
    return `<DERControl><mRID>${c.mRID}</mRID><creationTime>0</creationTime><EventStatus><currentStatus>1</currentStatus></EventStatus><interval><start>0</start><duration>600</duration></interval><DERControlBase>${base}</DERControlBase></DERControl>`;
  }
  function xmlDERControlList(controls) {
    const items = controls.map(controlInner).join('');
    return decl + `<DERControlList xmlns="${NS}" all="${controls.length}" results="${controls.length}">${items}</DERControlList>`;
  }
  function xmlControlResponse(mRID, t) {
    return `<?xml version="1.0"?><DERControlResponse xmlns="${NS}"><createdDateTime>${t}</createdDateTime><status>2</status><subject>${mRID}</subject></DERControlResponse>`;
  }
  // mirrors fast-xml-parser XMLBuilder({ format:true, suppressEmptyNode:true }) over serializeMirrorMeterReading
  function mmrInnerLines(m, p) {
    const L = [`${p}<MirrorMeterReading>`, `${p}  <mRID>${m.mRID}</mRID>`];
    if (m.description) L.push(`${p}  <description>${m.description}</description>`);
    L.push(`${p}  <ReadingType>`);
    if (m.ReadingType.mRID) L.push(`${p}    <mRID>${m.ReadingType.mRID}</mRID>`);
    L.push(`${p}    <uom>${m.ReadingType.uom}</uom>`);
    if (m.ReadingType.flowDirection !== undefined) L.push(`${p}    <flowDirection>${m.ReadingType.flowDirection}</flowDirection>`);
    if (m.ReadingType.powerOfTenMultiplier !== undefined) L.push(`${p}    <powerOfTenMultiplier>${m.ReadingType.powerOfTenMultiplier}</powerOfTenMultiplier>`);
    L.push(`${p}  </ReadingType>`, `${p}  <Reading>`, `${p}    <timePeriod>`,
      `${p}      <start>${m.Reading.timePeriod.start}</start>`, `${p}      <duration>${m.Reading.timePeriod.duration}</duration>`,
      `${p}    </timePeriod>`, `${p}    <value>${m.Reading.value}</value>`, `${p}  </Reading>`, `${p}</MirrorMeterReading>`);
    return L;
  }
  function xmlMirrorMeterReading(m) {
    const lines = mmrInnerLines(m, '');
    lines[0] = `<MirrorMeterReading xmlns="${NS}">`;   // namespace on the single-resource root
    return decl + lines.join('\n');
  }
  // Canonical batch form (IEEE 2030.5 §10.11.3(d)) — all of an interval's readings in one POST.
  function xmlMirrorMeterReadingList(items) {
    const L = [`<MirrorMeterReadingList xmlns="${NS}" all="${items.length}" results="${items.length}">`];
    for (const m of items) for (const line of mmrInnerLines(m, '  ')) L.push(line);
    L.push(`</MirrorMeterReadingList>`);
    return decl + L.join('\n');
  }

  window.FP = {
    NS, Uom, UOM_LABEL, CATALOG, TIERS, FIXTURE, SUB_DEFAULT, LANES,
    findPoint, byTier, laneOf, wireMrid,
    buildReadUrl, parseReadPage,
    xml: { xmlDcap, xmlDERControlList, controlInner, xmlControlResponse, xmlMirrorMeterReading, xmlMirrorMeterReadingList },
  };
})();
