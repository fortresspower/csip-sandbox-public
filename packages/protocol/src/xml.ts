import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import type { DERControl, MirrorMeterReading, Sep2List, MirrorMeterReadingListPage, ParsedReadingPage } from './resources.js';

const NS = 'urn:ieee:std:2030.5:ns';
const builder = new XMLBuilder({ ignoreAttributes: false, format: true, suppressEmptyNode: true });
// Coerce numeric tag text (creationTime, opModFixedW, ...) but keep mRID as a raw string —
// numeric-looking mRIDs (e.g. all-digit or "1E3") must not be coerced/round-tripped lossily.
// Attributes ARE parsed (prefixed `@_`) so List `all`/`results` survive — without this they were
// dropped and `all` fell back to items.length (wrong for paged lists). Mirrors readParser below.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: true,
  tagValueProcessor: (tagName: string, val: string) => (tagName === 'mRID' ? String(val) : undefined),
});

/** The inner MirrorMeterReading object (no namespace) — shared by the single + list serializers. */
function mmrInner(m: MirrorMeterReading) {
  return {
    mRID: m.mRID,
    ...(m.description ? { description: m.description } : {}),
    ReadingType: {
      ...(m.ReadingType.mRID ? { mRID: m.ReadingType.mRID } : {}),
      uom: m.ReadingType.uom,
      ...(m.ReadingType.flowDirection !== undefined ? { flowDirection: m.ReadingType.flowDirection } : {}),
      ...(m.ReadingType.powerOfTenMultiplier !== undefined ? { powerOfTenMultiplier: m.ReadingType.powerOfTenMultiplier } : {}),
      ...(m.ReadingType.dataQualifier !== undefined ? { dataQualifier: m.ReadingType.dataQualifier } : {}),
    },
    Reading: { timePeriod: { start: m.Reading.timePeriod.start, duration: m.Reading.timePeriod.duration }, value: m.Reading.value },
  };
}

export function serializeMirrorMeterReading(m: MirrorMeterReading): string {
  const obj = { MirrorMeterReading: { '@_xmlns': NS, ...mmrInner(m) } };
  return `<?xml version="1.0" encoding="UTF-8"?>\n` + builder.build(obj);
}

/** Canonical batch form (IEEE 2030.5 §10.11.3(d)): all of an interval's readings in one POST. */
export function serializeMirrorMeterReadingList(items: MirrorMeterReading[]): string {
  const obj = {
    MirrorMeterReadingList: {
      '@_xmlns': NS,
      '@_all': items.length,
      '@_results': items.length,
      MirrorMeterReading: items.map(mmrInner),
    },
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n` + builder.build(obj);
}

export function parseDERControlList(xml: string): Sep2List<DERControl> {
  const root = parser.parse(xml).DERControlList ?? {};
  const raw = root.DERControl ? (Array.isArray(root.DERControl) ? root.DERControl : [root.DERControl]) : [];
  const items: DERControl[] = raw.map((c: any) => ({
    mRID: String(c.mRID),
    creationTime: Number(c.creationTime),
    EventStatus: { currentStatus: Number(c.EventStatus?.currentStatus ?? 0) },
    interval: { start: Number(c.interval?.start ?? 0), duration: Number(c.interval?.duration ?? 0) },
    DERControlBase: {
      ...(c.DERControlBase?.opModConnect !== undefined ? { opModConnect: c.DERControlBase.opModConnect === true || c.DERControlBase.opModConnect === 'true' } : {}),
      ...(c.DERControlBase?.opModMaxLimW !== undefined ? { opModMaxLimW: Number(c.DERControlBase.opModMaxLimW) } : {}),
      ...(c.DERControlBase?.opModFixedW !== undefined ? { opModFixedW: Number(c.DERControlBase.opModFixedW) } : {}),
    },
  }));
  return { all: Number(root['@_all'] ?? items.length), results: Number(root['@_results'] ?? items.length), items };
}

/** A read response page: a MirrorMeterReadingList with all/results and an optional next Link. */
export function serializeMirrorMeterReadingListPage(p: MirrorMeterReadingListPage): string {
  const obj = {
    MirrorMeterReadingList: {
      '@_xmlns': NS,
      '@_all': p.all,
      '@_results': p.results,
      ...(p.nextHref ? { Link: { '@_rel': 'next', '@_href': p.nextHref } } : {}),
      MirrorMeterReading: p.items.map(mmrInner),
    },
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n` + builder.build(obj);
}

const readParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: true,
  tagValueProcessor: (t: string, v: string) => (t === 'mRID' ? String(v) : undefined) });

export function parseMirrorMeterReadingList(xml: string): ParsedReadingPage {
  const root = readParser.parse(xml).MirrorMeterReadingList ?? {};
  const raw = root.MirrorMeterReading ? (Array.isArray(root.MirrorMeterReading) ? root.MirrorMeterReading : [root.MirrorMeterReading]) : [];
  const readings = raw.map((m: any) => ({
    mRID: String(m.mRID),
    description: m.description !== undefined ? String(m.description) : undefined,
    uom: Number(m.ReadingType?.uom ?? 0),
    convention: m.ReadingType?.mRID !== undefined ? String(m.ReadingType.mRID) : undefined,
    value: Number(m.Reading?.value),
    start: Number(m.Reading?.timePeriod?.start ?? 0),
  }));
  return { readings, all: Number(root['@_all'] ?? readings.length), results: Number(root['@_results'] ?? readings.length),
    nextHref: root.Link?.['@_href'] ? String(root.Link['@_href']) : undefined };
}
