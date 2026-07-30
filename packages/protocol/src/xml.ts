import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import type {
  DERControl,
  DERProgram,
  DERProgramListPage,
  DeviceCapability,
  EndDevice,
  EndDeviceListPage,
  FunctionSetAssignments,
  FunctionSetAssignmentsListPage,
  Link,
  ListLink,
  MirrorMeterReading,
  MirrorMeterReadingListPage,
  ParsedReadingPage,
  Sep2List,
} from './resources.js';

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

const document = (root: Record<string, unknown>): string => (
  `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(root)}`
);

const linkInner = (link: Link | ListLink) => ({
  '@_href': link.href,
  ...('all' in link && link.all !== undefined ? { '@_all': link.all } : {}),
});

const endDeviceInner = (device: EndDevice) => ({
  '@_href': device.href,
  lFDI: device.lFDI,
  sFDI: device.sFDI,
  changedTime: device.changedTime,
  enabled: device.enabled,
  FunctionSetAssignmentsListLink: linkInner(device.FunctionSetAssignmentsListLink),
});

const functionSetAssignmentsInner = (assignments: FunctionSetAssignments) => ({
  '@_href': assignments.href,
  DERProgramListLink: linkInner(assignments.DERProgramListLink),
  TimeLink: linkInner(assignments.TimeLink),
  mRID: assignments.mRID,
});

const derProgramInner = (program: DERProgram) => ({
  '@_href': program.href,
  mRID: program.mRID,
  DERControlListLink: linkInner(program.DERControlListLink),
  primacy: program.primacy,
});

const listInner = <T>(
  page: {
    href: string;
    all: number;
    results: number;
    pollRate: number;
    nextHref?: string;
    items: T[];
  },
  itemName: string,
  item: (value: T) => Record<string, unknown>,
) => ({
  '@_xmlns': NS,
  '@_href': page.href,
  '@_all': page.all,
  '@_results': page.results,
  '@_pollRate': page.pollRate,
  ...(page.nextHref ? { Link: { '@_rel': 'next', '@_href': page.nextHref } } : {}),
  [itemName]: page.items.map(item),
});

export function serializeDeviceCapability(capability: DeviceCapability): string {
  return document({
    DeviceCapability: {
      '@_xmlns': NS,
      '@_href': capability.href,
      '@_pollRate': capability.pollRate,
      ...(capability.TimeLink ? { TimeLink: linkInner(capability.TimeLink) } : {}),
      ...(capability.EndDeviceListLink
        ? { EndDeviceListLink: linkInner(capability.EndDeviceListLink) }
        : {}),
      ...(capability.MirrorUsagePointListLink
        ? { MirrorUsagePointListLink: linkInner(capability.MirrorUsagePointListLink) }
        : {}),
    },
  });
}

export function serializeEndDevice(device: EndDevice): string {
  return document({ EndDevice: { '@_xmlns': NS, ...endDeviceInner(device) } });
}

export function serializeEndDeviceList(page: EndDeviceListPage): string {
  return document({
    EndDeviceList: listInner(page, 'EndDevice', endDeviceInner),
  });
}

export function serializeFunctionSetAssignments(assignments: FunctionSetAssignments): string {
  return document({
    FunctionSetAssignments: {
      '@_xmlns': NS,
      ...functionSetAssignmentsInner(assignments),
    },
  });
}

export function serializeFunctionSetAssignmentsList(
  page: FunctionSetAssignmentsListPage,
): string {
  return document({
    FunctionSetAssignmentsList: listInner(
      page,
      'FunctionSetAssignments',
      functionSetAssignmentsInner,
    ),
  });
}

export function serializeDERProgram(program: DERProgram): string {
  return document({ DERProgram: { '@_xmlns': NS, ...derProgramInner(program) } });
}

export function serializeDERProgramList(page: DERProgramListPage): string {
  return document({
    DERProgramList: listInner(page, 'DERProgram', derProgramInner),
  });
}

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
  return document(obj);
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
  return document(obj);
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
  return document(obj);
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
