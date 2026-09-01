import { Router, type Request, type Response } from 'express';
import {
  parseDERCapability,
  parseDERControlResponse,
  parseDERStatus,
  parseEndDevice,
  parseMirrorUsagePoint,
  type DERControl,
} from '@fortress-csip/protocol';
import { PartnerDomain, opaqueToken } from './partner-domain.js';
import type { ControlRecord, DeviceRecord, ProgramRecord } from './persistence/port.js';

const NS = 'urn:ieee:std:2030.5:ns';
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 500;

export type ConnectionResolver = (request: Request) => string | undefined | Promise<string | undefined>;

export function partnerCsipRouter(domain: PartnerDomain, resolveConnection: ConnectionResolver): Router {
  const router = Router();

  router.get('/capability', route(async (request, response) => {
    const connectionId = await requireConnection(domain, resolveConnection, request);
    const token = opaqueToken('connection', connectionId, connectionId);
    sendXml(response, document('DeviceCapability', [
      `<EndDeviceListLink href="/sep2/r/${token}/devices"/>`,
      `<MirrorUsagePointListLink href="/sep2/r/${token}/usage-points"/>`,
      `<TimeLink href="/sep2/time"/>`,
    ], ' pollRate="30"'));
  }));

  router.get('/time', route(async (request, response) => {
    await requireConnection(domain, resolveConnection, request);
    const now = Math.floor(Date.now() / 1_000);
    sendXml(response, document('Time', [`<currentTime>${now}</currentTime>`, '<tzOffset>0</tzOffset>']));
  }));

  router.get('/r/:connectionToken/devices', route(async (request, response) => {
    const connectionId = await requireConnectionToken(domain, resolveConnection, request);
    const devices = await domain.devices(connectionId);
    sendXml(response, listDocument(request, 'EndDeviceList', devices.map((device) => endDeviceXml(device)), 30));
  }));

  router.post('/r/:connectionToken/devices', route(async (request, response) => {
    const connectionId = await requireConnectionToken(domain, resolveConnection, request);
    const parsed = parseXml('EndDevice', () => parseEndDevice(bodyText(request)));
    if (!/^[0-9a-f]{40}$/.test(parsed.lFDI)) {
      throw httpError(422, 'EndDevice LFDI must be 40 lowercase hexadecimal characters');
    }
    const { device, created } = await domain.registerDevice(connectionId, parsed.lFDI);
    response.setHeader('Location', deviceHref(device));
    response.status(created ? 201 : 200).end();
  }));

  router.get('/r/:deviceToken/device', route(async (request, response) => {
    const connectionId = await requireConnection(domain, resolveConnection, request);
    const device = await requireDeviceToken(domain, connectionId, request.params.deviceToken);
    sendXml(response, document('EndDevice', [endDeviceXml(device, false)]));
  }));

  router.delete('/r/:deviceToken/device', route(async (request, response) => {
    const connectionId = await requireConnection(domain, resolveConnection, request);
    const device = await requireDeviceToken(domain, connectionId, request.params.deviceToken);
    await domain.deleteDevice(connectionId, device.lFDI);
    response.status(204).end();
  }));

  router.get('/r/:deviceToken/assignments', route(async (request, response) => {
    const connectionId = await requireConnection(domain, resolveConnection, request);
    const device = await requireDeviceToken(domain, connectionId, request.params.deviceToken);
    const items = device.assignedProgramIds.length === 0 ? [] : [
      `<FunctionSetAssignments href="/sep2/r/${device.token}/assignment"><mRID>fsa-${device.token}</mRID>`
        + `<DERProgramListLink href="/sep2/r/${device.token}/programs"/></FunctionSetAssignments>`,
    ];
    sendXml(response, listDocument(request, 'FunctionSetAssignmentsList', items, 30));
  }));

  router.get('/r/:deviceToken/programs', route(async (request, response) => {
    const connectionId = await requireConnection(domain, resolveConnection, request);
    const device = await requireDeviceToken(domain, connectionId, request.params.deviceToken);
    const assignedIds = new Set(device.assignedProgramIds);
    const programs = (await domain.programs(connectionId)).filter((program) => assignedIds.has(program.id));
    sendXml(response, listDocument(request, 'DERProgramList', programs.map(programXml), 30));
  }));

  router.get('/r/:programToken/controls', route(async (request, response) => {
    const connectionId = await requireConnection(domain, resolveConnection, request);
    const program = await requireProgramToken(domain, connectionId, request.params.programToken);
    const controls = await domain.controls(connectionId, program.id);
    sendXml(response, listDocument(request, 'DERControlList', controls.map((control) => controlXml(control, program)), 30));
  }));

  router.post('/r/:programToken/responses', route(async (request, response) => {
    const connectionId = await requireConnection(domain, resolveConnection, request);
    const program = await requireProgramToken(domain, connectionId, request.params.programToken);
    const body = bodyText(request);
    const parsed = parseXml('DERControlResponse', () => parseDERControlResponse(body));
    const [device, control] = await Promise.all([
      domain.device(connectionId, parsed.endDeviceLFDI),
      domain.persistence().get<ControlRecord>(connectionId, 'control', parsed.subject),
    ]);
    if (!device || !control || control.programId !== program.id) throw httpError(422, 'response does not match this connection, device, and program');
    const stored = await domain.recordExchange({
      connectionId,
      recordType: 'response',
      id: opaqueToken('response', connectionId, `${parsed.subject}\0${parsed.endDeviceLFDI}\0${parsed.status}`),
      category: `status-${parsed.status}`,
      deviceLfdi: parsed.endDeviceLFDI,
      subject: parsed.subject,
      xml: body,
    });
    if (parsed.status >= 3) await domain.completeControl(connectionId, parsed.subject, control.currentStatus);
    response.setHeader('Location', `/sep2/r/${program.token}/responses/${stored.id}`);
    response.status(201).end();
  }));

  router.get('/r/:connectionToken/usage-points', route(async (request, response) => {
    const connectionId = await requireConnectionToken(domain, resolveConnection, request);
    const devices = await domain.devices(connectionId);
    const points = devices.flatMap((device) => [usagePointXml(device, 'standard'), usagePointXml(device, 'extensions')]);
    sendXml(response, listDocument(request, 'MirrorUsagePointList', points, 300));
  }));

  router.post('/r/:deviceToken/usage/:lane', route(async (request, response) => {
    const connectionId = await requireConnection(domain, resolveConnection, request);
    const device = await requireDeviceToken(domain, connectionId, request.params.deviceToken);
    const lane = requireLane(request.params.lane);
    const body = bodyText(request);
    const parsed = parseXml('MirrorUsagePoint', () => parseMirrorUsagePoint(body));
    if (parsed.deviceLFDI !== device.lFDI) throw httpError(422, 'telemetry device LFDI does not match its discovered route');
    const expectedMrid = `${lane === 'extensions' ? 'fortress:' : ''}mup-${device.token}`;
    if (parsed.mRID !== expectedMrid) throw httpError(422, 'telemetry mRID does not match its discovered route');
    const extensionFlags = parsed.MirrorMeterReadings.map((reading) => reading.ReadingType.mRID?.startsWith('fortress:') === true);
    if (extensionFlags.some((isExtension) => isExtension !== (lane === 'extensions'))) {
      throw httpError(422, 'standard and extension telemetry must use separate discovered resources');
    }
    const stored = await domain.recordExchange({
      connectionId,
      recordType: 'telemetry',
      category: `mup-${lane}`,
      deviceLfdi: device.lFDI,
      xml: body,
    });
    response.setHeader('Location', `/sep2/r/${device.token}/usage/${lane}/${stored.id}`);
    response.status(201).end();
  }));

  router.get('/r/:deviceToken/ders', route(async (request, response) => {
    const connectionId = await requireConnection(domain, resolveConnection, request);
    const device = await requireDeviceToken(domain, connectionId, request.params.deviceToken);
    const item = `<DER href="/sep2/r/${device.token}/der"><DERStatusLink href="/sep2/r/${device.token}/status"/>`
      + `<DERCapabilityLink href="/sep2/r/${device.token}/capability"/></DER>`;
    sendXml(response, listDocument(request, 'DERList', [item], 300));
  }));

  router.put('/r/:deviceToken/status', route(async (request, response) => {
    const connectionId = await requireConnection(domain, resolveConnection, request);
    const device = await requireDeviceToken(domain, connectionId, request.params.deviceToken);
    const body = bodyText(request);
    parseXml('DERStatus', () => parseDERStatus(body));
    await domain.recordExchange({ connectionId, recordType: 'telemetry', category: 'der-status', deviceLfdi: device.lFDI, xml: body });
    response.status(204).end();
  }));

  router.put('/r/:deviceToken/capability', route(async (request, response) => {
    const connectionId = await requireConnection(domain, resolveConnection, request);
    const device = await requireDeviceToken(domain, connectionId, request.params.deviceToken);
    const body = bodyText(request);
    parseXml('DERCapability', () => parseDERCapability(body));
    await domain.recordExchange({ connectionId, recordType: 'telemetry', category: 'der-capability', deviceLfdi: device.lFDI, xml: body });
    response.status(204).end();
  }));

  return router;
}

function endDeviceXml(device: DeviceRecord, includeRoot = true): string {
  const inner = `<lFDI>${escapeXml(device.lFDI)}</lFDI>`
    + `<FunctionSetAssignmentsListLink href="/sep2/r/${device.token}/assignments"/>`
    + `<DERListLink href="/sep2/r/${device.token}/ders"/>`;
  return includeRoot ? `<EndDevice href="${deviceHref(device)}">${inner}</EndDevice>` : inner;
}

function programXml(program: ProgramRecord): string {
  return `<DERProgram href="/sep2/r/${program.token}/program"><mRID>${escapeXml(program.mRID)}</mRID>`
    + `<primacy>${program.primacy}</primacy><DERControlListLink href="/sep2/r/${program.token}/controls"/></DERProgram>`;
}

function controlXml(control: ControlRecord, program: ProgramRecord): string {
  const base = [
    control.opModConnect !== undefined ? `<opModConnect>${control.opModConnect}</opModConnect>` : '',
    control.opModMaxLimW !== undefined ? `<opModMaxLimW>${control.opModMaxLimW}</opModMaxLimW>` : '',
    control.opModFixedW !== undefined ? `<opModFixedW>${control.opModFixedW}</opModFixedW>` : '',
  ].join('');
  const value: DERControl = {
    replyTo: `/sep2/r/${program.token}/responses`,
    responseRequired: control.responseRequired,
    mRID: control.mRID,
    creationTime: control.creationTime,
    EventStatus: { currentStatus: control.currentStatus },
    interval: { start: control.start, duration: control.duration },
    DERControlBase: {
      ...(control.opModConnect !== undefined ? { opModConnect: control.opModConnect } : {}),
      ...(control.opModMaxLimW !== undefined ? { opModMaxLimW: control.opModMaxLimW } : {}),
      ...(control.opModFixedW !== undefined ? { opModFixedW: control.opModFixedW } : {}),
    },
  };
  return `<DERControl replyTo="${value.replyTo}" responseRequired="${escapeXml(value.responseRequired)}">`
    + `<mRID>${escapeXml(value.mRID)}</mRID><creationTime>${value.creationTime}</creationTime>`
    + `<EventStatus><currentStatus>${value.EventStatus.currentStatus}</currentStatus></EventStatus>`
    + `<interval><start>${value.interval.start}</start><duration>${value.interval.duration}</duration></interval>`
    + `<DERControlBase>${base}</DERControlBase></DERControl>`;
}

function usagePointXml(device: DeviceRecord, lane: 'standard' | 'extensions'): string {
  const extension = lane === 'extensions';
  return `<MirrorUsagePoint href="/sep2/r/${device.token}/usage/${lane}">`
    + `<mRID>${extension ? 'fortress:' : ''}mup-${device.token}</mRID>`
    + `<postRate>${extension ? 600 : 300}</postRate><deviceLFDI>${device.lFDI}</deviceLFDI></MirrorUsagePoint>`;
}

function listDocument(request: Request, root: string, allItems: string[], pollRate: number): string {
  const { start, limit } = pagination(request);
  const items = allItems.slice(start, start + limit);
  const nextStart = start + limit;
  const next = nextStart < allItems.length
    ? `<Link rel="next" href="${escapeXml(`${request.baseUrl}${request.path}?s=${nextStart}&l=${limit}`)}"/>`
    : '';
  return document(root, [items.join(''), `<pollRate>${pollRate}</pollRate>`, next], ` all="${allItems.length}" results="${items.length}"`);
}

function pagination(request: Request): { start: number; limit: number } {
  const start = positiveInteger(request.query.s, 0, 's');
  const limit = positiveInteger(request.query.l, DEFAULT_PAGE_SIZE, 'l');
  if (limit < 1 || limit > MAX_PAGE_SIZE) throw httpError(400, `l must be between 1 and ${MAX_PAGE_SIZE}`);
  return { start, limit };
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw httpError(400, `${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw httpError(400, `${name} must be a safe integer`);
  return parsed;
}

async function requireConnection(
  domain: PartnerDomain,
  resolver: ConnectionResolver,
  request: Request,
): Promise<string> {
  const connectionId = await resolver(request);
  if (!connectionId) throw httpError(401, 'authenticated partner connection is required');
  if (!await domain.connection(connectionId)) throw httpError(403, 'partner connection is not authorized');
  return connectionId;
}

async function requireConnectionToken(domain: PartnerDomain, resolver: ConnectionResolver, request: Request): Promise<string> {
  const connectionId = await requireConnection(domain, resolver, request);
  if (request.params.connectionToken !== opaqueToken('connection', connectionId, connectionId)) throw httpError(404, 'resource not found');
  return connectionId;
}

async function requireDeviceToken(domain: PartnerDomain, connectionId: string, token: string): Promise<DeviceRecord> {
  const device = await domain.deviceByToken(connectionId, token);
  if (!device) throw httpError(404, 'EndDevice not found');
  return device;
}

async function requireProgramToken(domain: PartnerDomain, connectionId: string, token: string): Promise<ProgramRecord> {
  const program = (await domain.programs(connectionId)).find((candidate) => candidate.token === token);
  if (!program) throw httpError(404, 'DERProgram not found');
  return program;
}

function requireLane(value: string): 'standard' | 'extensions' {
  if (value !== 'standard' && value !== 'extensions') throw httpError(404, 'telemetry lane not found');
  return value;
}

function route(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: (error?: unknown) => void): void => {
    handler(request, response).catch(next);
  };
}

function document(root: string, contents: string[], attributes = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="${NS}"${attributes}>${contents.join('')}</${root}>`;
}

function sendXml(response: Response, body: string): void {
  response.type('application/sep+xml').status(200).send(body);
}

function bodyText(request: Request): string {
  if (typeof request.body !== 'string' || request.body.length === 0) throw httpError(400, 'SEP XML request body is required');
  return request.body;
}

function deviceHref(device: DeviceRecord): string {
  return `/sep2/r/${device.token}/device`;
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function parseXml<T>(resource: string, parser: () => T): T {
  try {
    return parser();
  } catch (error) {
    throw httpError(400, `invalid ${resource}: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface HttpError extends Error { status: number }

function httpError(status: number, message: string): HttpError {
  return Object.assign(new Error(message), { status });
}
