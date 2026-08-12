import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import type {
  DERCapability,
  DERControl,
  DERControlResponse,
  DER,
  DERProgram,
  DERStatus,
  DeviceCapability,
  EndDevice,
  FunctionSetAssignments,
  MirrorMeterReading,
  MirrorMeterReadingListPage,
  MirrorUsagePoint,
  ParsedReadingPage,
  ReadingType,
  ResponseStatus,
  Sep2List,
} from './resources.js';

const NS = 'urn:ieee:std:2030.5:ns';
export const DEFAULT_XML_MAX_BYTES = 1024 * 1024;

export interface XmlParseOptions {
  maxBytes?: number;
}

type RawRecord = Record<string, unknown>;

const builder = new XMLBuilder({
  ignoreAttributes: false,
  format: true,
  suppressEmptyNode: true,
});

// Keep all text as strings. Numeric fields are converted explicitly below so
// malformed values cannot silently become NaN and identifier-like values are
// never rounded or normalized.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
});

function parseRoot(xml: string, rootName: string, options: XmlParseOptions = {}): RawRecord {
  const maxBytes = options.maxBytes ?? DEFAULT_XML_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('XML size limit must be a positive safe integer');
  }
  if (Buffer.byteLength(xml, 'utf8') > maxBytes) {
    throw new Error(`XML document exceeds size limit of ${maxBytes} bytes`);
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new Error('XML DTD and entity declarations are not allowed');
  }

  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(`Malformed XML: ${validation.err.msg}`);
  }

  const document = parser.parse(xml) as RawRecord;
  const root = asRecord(singleton(document[rootName], rootName, true), rootName);
  if (scalarString(root['@_xmlns'], 'xmlns') !== NS) {
    throw new Error(`${rootName} must use the IEEE 2030.5 XML namespace`);
  }
  return root;
}

function asRecord(value: unknown, field: string): RawRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an XML object`);
  }
  return value as RawRecord;
}

function singleton(value: unknown, field: string, required = false): unknown {
  if (Array.isArray(value)) {
    throw new Error(`${field} must be a singleton field`);
  }
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required`);
    return undefined;
  }
  return value;
}

function scalarString(value: unknown, field: string, required = false): string | undefined {
  const single = singleton(value, field, required);
  if (single === undefined) return undefined;
  if (typeof single === 'object') throw new Error(`${field} must be a scalar string`);
  const result = String(single);
  if (required && result.length === 0) throw new Error(`${field} is required`);
  return result;
}

function requiredString(parent: RawRecord, field: string): string {
  return scalarString(parent[field], field, true)!;
}

function optionalString(parent: RawRecord, field: string): string | undefined {
  return scalarString(parent[field], field);
}

function parseNumber(value: unknown, field: string, required = false): number | undefined {
  const raw = scalarString(value, field, required);
  if (raw === undefined) return undefined;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) {
    throw new Error(`${field} must be a finite number`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a finite number`);
  return parsed;
}

function requiredNumber(parent: RawRecord, field: string): number {
  return parseNumber(parent[field], field, true)!;
}

function optionalNumber(parent: RawRecord, field: string): number | undefined {
  return parseNumber(parent[field], field);
}

function optionalBoolean(parent: RawRecord, field: string): boolean | undefined {
  const raw = scalarString(parent[field], field);
  if (raw === undefined) return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${field} must be a boolean`);
}

function resourceHref(resource: RawRecord): string | undefined {
  return scalarString(resource['@_href'], 'href');
}

function resourceAttribute(resource: RawRecord, field: string): string | undefined {
  return scalarString(resource[`@_${field}`], field);
}

function linkHref(resource: RawRecord, field: string): string | undefined {
  const raw = singleton(resource[field], field);
  if (raw === undefined) return undefined;
  return scalarString(asRecord(raw, field)['@_href'], `${field}.href`, true);
}

function listItems(root: RawRecord, itemName: string): RawRecord[] {
  const raw = root[itemName];
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((value, index) => asRecord(value, `${itemName}[${index}]`));
}

function listMetadata(root: RawRecord, itemCount: number): Omit<Sep2List<never>, 'items'> {
  const all = parseNumber(root['@_all'] ?? root.all, 'all') ?? itemCount;
  const results = parseNumber(root['@_results'] ?? root.results, 'results') ?? itemCount;
  const pollRate = parseNumber(root.pollRate ?? root['@_pollRate'], 'pollRate');

  const links = root.Link === undefined
    ? []
    : (Array.isArray(root.Link) ? root.Link : [root.Link])
      .map((link, index) => asRecord(link, `Link[${index}]`));
  const nextLinks = links.filter((link) => scalarString(link['@_rel'], 'Link.rel') === 'next');
  if (nextLinks.length > 1) throw new Error('Link rel=next must be a singleton field');
  const nextHref = nextLinks.length === 1
    ? scalarString(nextLinks[0]['@_href'], 'Link.href', true)
    : undefined;

  return {
    all,
    results,
    ...(pollRate !== undefined ? { pollRate } : {}),
    ...(nextHref !== undefined ? { nextHref } : {}),
  };
}

function xmlDocument(rootName: string, value: RawRecord): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build({
    [rootName]: { '@_xmlns': NS, ...value },
  })}`;
}

function mmrInner(meterReading: MirrorMeterReading): RawRecord {
  return {
    mRID: meterReading.mRID,
    ...(meterReading.description ? { description: meterReading.description } : {}),
    ReadingType: {
      ...(meterReading.ReadingType.mRID ? { mRID: meterReading.ReadingType.mRID } : {}),
      uom: meterReading.ReadingType.uom,
      ...(meterReading.ReadingType.kind !== undefined ? { kind: meterReading.ReadingType.kind } : {}),
      ...(meterReading.ReadingType.flowDirection !== undefined
        ? { flowDirection: meterReading.ReadingType.flowDirection }
        : {}),
      ...(meterReading.ReadingType.powerOfTenMultiplier !== undefined
        ? { powerOfTenMultiplier: meterReading.ReadingType.powerOfTenMultiplier }
        : {}),
      ...(meterReading.ReadingType.dataQualifier !== undefined
        ? { dataQualifier: meterReading.ReadingType.dataQualifier }
        : {}),
    },
    Reading: {
      timePeriod: {
        start: meterReading.Reading.timePeriod.start,
        duration: meterReading.Reading.timePeriod.duration,
      },
      value: meterReading.Reading.value,
    },
  };
}

function parseReadingType(raw: unknown): ReadingType {
  const value = asRecord(singleton(raw, 'ReadingType', true), 'ReadingType');
  const kind = optionalNumber(value, 'kind');
  const dataQualifier = optionalNumber(value, 'dataQualifier');
  const flowDirection = optionalNumber(value, 'flowDirection');
  const powerOfTenMultiplier = optionalNumber(value, 'powerOfTenMultiplier');
  const mRID = optionalString(value, 'mRID');
  return {
    uom: requiredNumber(value, 'uom') as ReadingType['uom'],
    ...(kind !== undefined ? { kind } : {}),
    ...(dataQualifier !== undefined ? { dataQualifier } : {}),
    ...(flowDirection !== undefined ? { flowDirection } : {}),
    ...(powerOfTenMultiplier !== undefined ? { powerOfTenMultiplier } : {}),
    ...(mRID !== undefined ? { mRID } : {}),
  };
}

function parseMirrorMeterReading(raw: RawRecord): MirrorMeterReading {
  const reading = asRecord(singleton(raw.Reading, 'Reading', true), 'Reading');
  const timePeriod = asRecord(singleton(reading.timePeriod, 'timePeriod', true), 'timePeriod');
  const description = optionalString(raw, 'description');
  return {
    mRID: requiredString(raw, 'mRID'),
    ...(description !== undefined ? { description } : {}),
    ReadingType: parseReadingType(raw.ReadingType),
    Reading: {
      timePeriod: {
        start: requiredNumber(timePeriod, 'start'),
        duration: requiredNumber(timePeriod, 'duration'),
      },
      value: requiredNumber(reading, 'value'),
    },
  };
}

function parseMirrorUsagePointRecord(root: RawRecord): MirrorUsagePoint {
  const href = resourceHref(root);
  const description = optionalString(root, 'description');
  const postRate = optionalNumber(root, 'postRate');
  return {
    ...(href !== undefined ? { href } : {}),
    mRID: requiredString(root, 'mRID'),
    ...(description !== undefined ? { description } : {}),
    ...(postRate !== undefined ? { postRate } : {}),
    deviceLFDI: requiredString(root, 'deviceLFDI'),
    MirrorMeterReadings: listItems(root, 'MirrorMeterReading').map(parseMirrorMeterReading),
  };
}

function parseEndDeviceRecord(device: RawRecord): EndDevice {
  const href = resourceHref(device);
  const functionSetAssignmentsListLink = linkHref(device, 'FunctionSetAssignmentsListLink');
  const derListLink = linkHref(device, 'DERListLink');
  return {
    ...(href !== undefined ? { href } : {}),
    lFDI: requiredString(device, 'lFDI'),
    ...(functionSetAssignmentsListLink !== undefined
      ? { FunctionSetAssignmentsListLink: functionSetAssignmentsListLink }
      : {}),
    ...(derListLink !== undefined ? { DERListLink: derListLink } : {}),
  };
}

export function parseDeviceCapability(
  xml: string,
  options: XmlParseOptions = {},
): DeviceCapability {
  const root = parseRoot(xml, 'DeviceCapability', options);
  const endDeviceListLink = linkHref(root, 'EndDeviceListLink');
  const mirrorUsagePointListLink = linkHref(root, 'MirrorUsagePointListLink');
  const timeLink = linkHref(root, 'TimeLink');
  return {
    pollRate: parseNumber(root.pollRate ?? root['@_pollRate'], 'pollRate', true)!,
    ...(endDeviceListLink !== undefined ? { EndDeviceListLink: endDeviceListLink } : {}),
    ...(mirrorUsagePointListLink !== undefined
      ? { MirrorUsagePointListLink: mirrorUsagePointListLink }
      : {}),
    ...(timeLink !== undefined ? { TimeLink: timeLink } : {}),
  };
}

export function parseEndDeviceList(xml: string, options: XmlParseOptions = {}): Sep2List<EndDevice> {
  const root = parseRoot(xml, 'EndDeviceList', options);
  const items = listItems(root, 'EndDevice').map(parseEndDeviceRecord);
  return { ...listMetadata(root, items.length), items };
}

export function parseEndDevice(xml: string, options: XmlParseOptions = {}): EndDevice {
  return parseEndDeviceRecord(parseRoot(xml, 'EndDevice', options));
}

export function serializeEndDevice(device: Pick<EndDevice, 'lFDI'>): string {
  return xmlDocument('EndDevice', { lFDI: device.lFDI });
}

export function parseFunctionSetAssignmentsList(
  xml: string,
  options: XmlParseOptions = {},
): Sep2List<FunctionSetAssignments> {
  const root = parseRoot(xml, 'FunctionSetAssignmentsList', options);
  const items = listItems(root, 'FunctionSetAssignments').map((assignment) => {
    const href = resourceHref(assignment);
    const derProgramListLink = linkHref(assignment, 'DERProgramListLink');
    return {
      ...(href !== undefined ? { href } : {}),
      mRID: requiredString(assignment, 'mRID'),
      ...(derProgramListLink !== undefined ? { DERProgramListLink: derProgramListLink } : {}),
    };
  });
  return { ...listMetadata(root, items.length), items };
}

export function parseDERProgramList(
  xml: string,
  options: XmlParseOptions = {},
): Sep2List<DERProgram> {
  const root = parseRoot(xml, 'DERProgramList', options);
  const items = listItems(root, 'DERProgram').map((program) => {
    const href = resourceHref(program);
    const derControlListLink = linkHref(program, 'DERControlListLink');
    return {
      ...(href !== undefined ? { href } : {}),
      mRID: requiredString(program, 'mRID'),
      primacy: requiredNumber(program, 'primacy'),
      ...(derControlListLink !== undefined ? { DERControlListLink: derControlListLink } : {}),
    };
  });
  return { ...listMetadata(root, items.length), items };
}

export function parseDERControlList(
  xml: string,
  options: XmlParseOptions = {},
): Sep2List<DERControl> {
  const root = parseRoot(xml, 'DERControlList', options);
  const items = listItems(root, 'DERControl').map((control) => {
    const mRID = requiredString(control, 'mRID');
    const creationTime = requiredNumber(control, 'creationTime');
    const eventStatus = asRecord(singleton(control.EventStatus, 'EventStatus', true), 'EventStatus');
    const interval = asRecord(singleton(control.interval, 'interval', true), 'interval');
    const rawControlBase = singleton(control.DERControlBase, 'DERControlBase', true);
    const controlBase = rawControlBase === ''
      ? {}
      : asRecord(rawControlBase, 'DERControlBase');
    const opModConnect = optionalBoolean(controlBase, 'opModConnect');
    const opModMaxLimW = optionalNumber(controlBase, 'opModMaxLimW');
    const opModFixedW = optionalNumber(controlBase, 'opModFixedW');
    const href = resourceHref(control);
    const replyTo = resourceAttribute(control, 'replyTo');
    const rawResponseRequired = resourceAttribute(control, 'responseRequired') ?? '00';
    if (!/^[0-9a-fA-F]{2}$/.test(rawResponseRequired)) {
      throw new Error('responseRequired must be a one-byte hexadecimal value');
    }
    const responseRequired = rawResponseRequired.toLowerCase();
    const eventDateTime = optionalNumber(eventStatus, 'dateTime');
    const potentiallySuperseded = optionalBoolean(eventStatus, 'potentiallySuperseded');
    const potentiallySupersededTime = optionalNumber(eventStatus, 'potentiallySupersededTime');
    return {
      ...(href !== undefined ? { href } : {}),
      ...(replyTo !== undefined ? { replyTo } : {}),
      responseRequired,
      mRID,
      creationTime,
      EventStatus: {
        currentStatus: requiredNumber(eventStatus, 'currentStatus'),
        ...(eventDateTime !== undefined ? { dateTime: eventDateTime } : {}),
        ...(potentiallySuperseded !== undefined ? { potentiallySuperseded } : {}),
        ...(potentiallySupersededTime !== undefined ? { potentiallySupersededTime } : {}),
      },
      interval: {
        start: requiredNumber(interval, 'start'),
        duration: requiredNumber(interval, 'duration'),
      },
      DERControlBase: {
        ...(opModConnect !== undefined ? { opModConnect } : {}),
        ...(opModMaxLimW !== undefined ? { opModMaxLimW } : {}),
        ...(opModFixedW !== undefined ? { opModFixedW } : {}),
      },
    };
  });
  return { ...listMetadata(root, items.length), items };
}

export function serializeDERControlResponse(response: DERControlResponse): string {
  return xmlDocument('DERControlResponse', {
    createdDateTime: response.createdDateTime,
    endDeviceLFDI: response.endDeviceLFDI,
    status: response.status,
    subject: response.subject,
  });
}

export function parseDERControlResponse(
  xml: string,
  options: XmlParseOptions = {},
): DERControlResponse {
  const root = parseRoot(xml, 'DERControlResponse', options);
  const status = requiredNumber(root, 'status');
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 252, 253, 254].includes(status)) {
    throw new Error('status is not a supported ResponseStatus');
  }
  return {
    createdDateTime: requiredNumber(root, 'createdDateTime'),
    endDeviceLFDI: requiredString(root, 'endDeviceLFDI'),
    status: status as ResponseStatus,
    subject: requiredString(root, 'subject'),
  };
}

export function serializeMirrorMeterReading(meterReading: MirrorMeterReading): string {
  return xmlDocument('MirrorMeterReading', mmrInner(meterReading));
}

/** Canonical batch form (IEEE 2030.5 section 10.11.3(d)): one interval per POST. */
export function serializeMirrorMeterReadingList(items: MirrorMeterReading[]): string {
  return xmlDocument('MirrorMeterReadingList', {
    '@_all': items.length,
    '@_results': items.length,
    MirrorMeterReading: items.map(mmrInner),
  });
}

export function serializeMirrorUsagePoint(usagePoint: MirrorUsagePoint): string {
  return xmlDocument('MirrorUsagePoint', {
    mRID: usagePoint.mRID,
    ...(usagePoint.description ? { description: usagePoint.description } : {}),
    ...(usagePoint.postRate !== undefined ? { postRate: usagePoint.postRate } : {}),
    deviceLFDI: usagePoint.deviceLFDI,
    MirrorMeterReading: usagePoint.MirrorMeterReadings.map(mmrInner),
  });
}

export function parseMirrorUsagePoint(
  xml: string,
  options: XmlParseOptions = {},
): MirrorUsagePoint {
  return parseMirrorUsagePointRecord(parseRoot(xml, 'MirrorUsagePoint', options));
}

export function parseMirrorUsagePointList(
  xml: string,
  options: XmlParseOptions = {},
): Sep2List<MirrorUsagePoint> {
  const root = parseRoot(xml, 'MirrorUsagePointList', options);
  const items = listItems(root, 'MirrorUsagePoint').map(parseMirrorUsagePointRecord);
  return { ...listMetadata(root, items.length), items };
}

export function parseDERList(xml: string, options: XmlParseOptions = {}): Sep2List<DER> {
  const root = parseRoot(xml, 'DERList', options);
  const items = listItems(root, 'DER').map((der) => {
    const href = resourceHref(der);
    const derStatusLink = linkHref(der, 'DERStatusLink');
    const derCapabilityLink = linkHref(der, 'DERCapabilityLink');
    return {
      ...(href !== undefined ? { href } : {}),
      ...(derStatusLink !== undefined ? { DERStatusLink: derStatusLink } : {}),
      ...(derCapabilityLink !== undefined ? { DERCapabilityLink: derCapabilityLink } : {}),
    };
  });
  return { ...listMetadata(root, items.length), items };
}

export function serializeDERStatus(status: DERStatus): string {
  return xmlDocument('DERStatus', {
    readingTime: status.readingTime,
    ...(status.operationalModeStatus ? { operationalModeStatus: status.operationalModeStatus } : {}),
    ...(status.genConnectStatus ? { genConnectStatus: status.genConnectStatus } : {}),
    ...(status.alarmStatus ? { alarmStatus: status.alarmStatus } : {}),
    ...(status.stateOfChargeStatus ? { stateOfChargeStatus: status.stateOfChargeStatus } : {}),
    ...(status.storConnectStatus ? { storConnectStatus: status.storConnectStatus } : {}),
  });
}

function optionalStatusValue(root: RawRecord, field: string): { value: number } | undefined {
  const raw = singleton(root[field], field);
  if (raw === undefined) return undefined;
  return { value: requiredNumber(asRecord(raw, field), 'value') };
}

export function parseDERStatus(xml: string, options: XmlParseOptions = {}): DERStatus {
  const root = parseRoot(xml, 'DERStatus', options);
  const operationalModeStatus = optionalStatusValue(root, 'operationalModeStatus');
  const genConnectStatus = optionalStatusValue(root, 'genConnectStatus');
  const alarmStatus = optionalStatusValue(root, 'alarmStatus');
  const stateOfChargeStatus = optionalStatusValue(root, 'stateOfChargeStatus');
  const storConnectStatus = optionalStatusValue(root, 'storConnectStatus');
  return {
    readingTime: requiredNumber(root, 'readingTime'),
    ...(operationalModeStatus ? { operationalModeStatus } : {}),
    ...(genConnectStatus ? { genConnectStatus } : {}),
    ...(alarmStatus ? { alarmStatus } : {}),
    ...(stateOfChargeStatus ? { stateOfChargeStatus } : {}),
    ...(storConnectStatus ? { storConnectStatus } : {}),
  };
}

export function serializeDERCapability(capability: DERCapability): string {
  return xmlDocument('DERCapability', {
    ...(capability.rtgMaxW !== undefined ? { rtgMaxW: capability.rtgMaxW } : {}),
    ...(capability.rtgMaxWh !== undefined ? { rtgMaxWh: capability.rtgMaxWh } : {}),
    ...(capability.rtgMaxAh !== undefined ? { rtgMaxAh: capability.rtgMaxAh } : {}),
    ...(capability.rtgMaxChargeRateW !== undefined
      ? { rtgMaxChargeRateW: capability.rtgMaxChargeRateW }
      : {}),
    ...(capability.rtgMaxDischargeRateW !== undefined
      ? { rtgMaxDischargeRateW: capability.rtgMaxDischargeRateW }
      : {}),
  });
}

export function parseDERCapability(
  xml: string,
  options: XmlParseOptions = {},
): DERCapability {
  const root = parseRoot(xml, 'DERCapability', options);
  const rtgMaxW = optionalNumber(root, 'rtgMaxW');
  const rtgMaxWh = optionalNumber(root, 'rtgMaxWh');
  const rtgMaxAh = optionalNumber(root, 'rtgMaxAh');
  const rtgMaxChargeRateW = optionalNumber(root, 'rtgMaxChargeRateW');
  const rtgMaxDischargeRateW = optionalNumber(root, 'rtgMaxDischargeRateW');
  return {
    ...(rtgMaxW !== undefined ? { rtgMaxW } : {}),
    ...(rtgMaxWh !== undefined ? { rtgMaxWh } : {}),
    ...(rtgMaxAh !== undefined ? { rtgMaxAh } : {}),
    ...(rtgMaxChargeRateW !== undefined ? { rtgMaxChargeRateW } : {}),
    ...(rtgMaxDischargeRateW !== undefined ? { rtgMaxDischargeRateW } : {}),
  };
}

/** A read response page with list metadata and an optional next link. */
export function serializeMirrorMeterReadingListPage(page: MirrorMeterReadingListPage): string {
  return xmlDocument('MirrorMeterReadingList', {
    '@_all': page.all,
    '@_results': page.results,
    ...(page.nextHref ? { Link: { '@_rel': 'next', '@_href': page.nextHref } } : {}),
    MirrorMeterReading: page.items.map(mmrInner),
  });
}

export function parseMirrorMeterReadingList(
  xml: string,
  options: XmlParseOptions = {},
): ParsedReadingPage {
  const root = parseRoot(xml, 'MirrorMeterReadingList', options);
  const meterReadings = listItems(root, 'MirrorMeterReading').map(parseMirrorMeterReading);
  const metadata = listMetadata(root, meterReadings.length);
  return {
    readings: meterReadings.map((meterReading) => ({
      mRID: meterReading.mRID,
      ...(meterReading.description !== undefined ? { description: meterReading.description } : {}),
      uom: meterReading.ReadingType.uom,
      ...(meterReading.ReadingType.mRID !== undefined
        ? { convention: meterReading.ReadingType.mRID }
        : {}),
      value: meterReading.Reading.value,
      start: meterReading.Reading.timePeriod.start,
    })),
    all: metadata.all,
    results: metadata.results,
    ...(metadata.nextHref !== undefined ? { nextHref: metadata.nextHref } : {}),
  };
}
