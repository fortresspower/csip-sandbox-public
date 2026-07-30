import {
  Router,
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import type { Store, QueuedControl } from './store.js';
import {
  buildReadUrl,
  parseMirrorMeterReadingList,
  parseReadQuery,
  serializeDERProgram,
  serializeDERProgramList,
  serializeDeviceCapability,
  serializeEndDevice,
  serializeEndDeviceList,
  serializeFunctionSetAssignments,
  serializeFunctionSetAssignmentsList,
  serializeMirrorMeterReadingListPage,
} from '@fortress-csip/protocol';
import type {
  DERProgram,
  EndDevice,
  FunctionSetAssignments,
  MirrorMeterReading,
} from '@fortress-csip/protocol';
import { synthSeries } from './backfill.js';
import {
  ProgramProjectionCatalog,
  type AssignmentSourceV1,
  type EndDeviceIdentity,
} from './enrollment-source.js';

const NS = 'urn:ieee:std:2030.5:ns';
const xml = (s: string) => `<?xml version="1.0" encoding="UTF-8"?>\n${s}`;
const POLL_RATE = 30;

export interface EnrollmentProjectionOptions {
  assignmentSource: AssignmentSourceV1;
  programCatalog: ProgramProjectionCatalog;
  onProjectionError: (error: Error) => void;
}

const asyncRoute = (
  handler: (req: Request, res: Response) => Promise<void>,
) => (req: Request, res: Response, next: NextFunction): void => {
  void handler(req, res).catch(next);
};

const page = <T>(items: T[], req: Request, path: string) => {
  const query = parseReadQuery(req.query as Record<string, string | string[] | undefined>);
  const selected = items.slice(query.start, query.start + query.limit);
  const nextStart = query.start + query.limit;
  return {
    href: path,
    all: items.length,
    results: selected.length,
    pollRate: POLL_RATE,
    items: selected,
    ...(nextStart < items.length
      ? { nextHref: `${path}?s=${nextStart}&l=${query.limit}` }
      : {}),
  };
};

const endDeviceResource = (identity: EndDeviceIdentity): EndDevice => ({
  href: `/edev/${encodeURIComponent(identity.id)}`,
  lFDI: identity.lFDI,
  sFDI: identity.sFDI,
  changedTime: identity.changedTime,
  enabled: true,
  FunctionSetAssignmentsListLink: {
    href: `/edev/${encodeURIComponent(identity.id)}/fsa`,
    all: 1,
  },
});

const fsaResource = (
  identity: EndDeviceIdentity,
  programCount: number,
): FunctionSetAssignments => ({
  href: `/edev/${encodeURIComponent(identity.id)}/fsa/0`,
  mRID: identity.fsaMRID,
  DERProgramListLink: {
    href: `/edev/${encodeURIComponent(identity.id)}/fsa/0/derp`,
    all: programCount,
  },
  TimeLink: { href: '/tm' },
});

const methodNotAllowed = (_req: Request, res: Response): void => {
  res.setHeader('Allow', 'GET');
  res.status(405).end();
};

export function csipRouter(
  store: Store,
  enrollment: EnrollmentProjectionOptions,
): Router {
  const r = Router();
  const assignedPrograms = async (identity: EndDeviceIdentity): Promise<DERProgram[]> => {
    const snapshot = await enrollment.assignmentSource.getAssignmentSnapshot(identity.siteId);
    if (snapshot.siteId !== identity.siteId) {
      throw new Error('assignment source returned a different site');
    }
    return enrollment.programCatalog.resolve(snapshot.programProjectionKeys);
  };
  const identity = (id: string, res: Response): EndDeviceIdentity | undefined => {
    const found = store.getEndDeviceIdentity(id);
    if (found == null) res.status(404).end();
    return found;
  };

  r.get('/dcap', (_req, res) => send(res, serializeDeviceCapability({
    href: '/dcap',
    pollRate: POLL_RATE,
    MirrorUsagePointListLink: { href: '/mup' },
    EndDeviceListLink: { href: '/edev', all: store.listEndDeviceIdentities().length },
    TimeLink: { href: '/tm' },
  })));
  r.get('/edev', (req, res) => {
    const devices = store.listEndDeviceIdentities()
      .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
      .map(endDeviceResource);
    send(res, serializeEndDeviceList(page(devices, req, '/edev')));
  });
  r.all('/edev', methodNotAllowed);
  r.get('/edev/:deviceId', (req, res) => {
    const device = identity(req.params.deviceId, res);
    if (device != null) send(res, serializeEndDevice(endDeviceResource(device)));
  });
  r.all('/edev/:deviceId', methodNotAllowed);
  r.get('/edev/:deviceId/fsa', asyncRoute(async (req, res) => {
    const device = identity(req.params.deviceId, res);
    if (device == null) return;
    const programs = await assignedPrograms(device);
    send(res, serializeFunctionSetAssignmentsList(page(
      [fsaResource(device, programs.length)],
      req,
      `/edev/${encodeURIComponent(device.id)}/fsa`,
    )));
  }));
  r.all('/edev/:deviceId/fsa', methodNotAllowed);
  r.get('/edev/:deviceId/fsa/:fsaId', asyncRoute(async (req, res) => {
    const device = identity(req.params.deviceId, res);
    if (device == null) return;
    if (req.params.fsaId !== '0') {
      res.status(404).end();
      return;
    }
    const programs = await assignedPrograms(device);
    send(res, serializeFunctionSetAssignments(fsaResource(device, programs.length)));
  }));
  r.all('/edev/:deviceId/fsa/:fsaId', methodNotAllowed);
  r.get('/edev/:deviceId/fsa/:fsaId/derp', asyncRoute(async (req, res) => {
    const device = identity(req.params.deviceId, res);
    if (device == null) return;
    if (req.params.fsaId !== '0') {
      res.status(404).end();
      return;
    }
    const path = `/edev/${encodeURIComponent(device.id)}/fsa/0/derp`;
    send(res, serializeDERProgramList(page(await assignedPrograms(device), req, path)));
  }));
  r.all('/edev/:deviceId/fsa/:fsaId/derp', methodNotAllowed);
  r.get('/derp/:programId', (req, res) => {
    const program = enrollment.programCatalog.get(req.params.programId);
    if (program == null) {
      res.status(404).end();
      return;
    }
    send(res, serializeDERProgram(program));
  });
  r.all('/derp/:programId', methodNotAllowed);
  r.get('/derp/:programId/derc', (req, res) => {
    const controls = store.drainControls(req.params.programId);
    const items = controls.map(controlXml).join('');
    const body = xml(`<DERControlList xmlns="${NS}" all="${controls.length}" results="${controls.length}">${items}</DERControlList>`);
    store.logWire({ dir: 'poll', method: 'GET', path: req.path, status: 200, label: `DERControlList · ${controls.length} control(s)`, body });
    send(res, body);
  });
  // Canonical telemetry read (§4.6.2): paginated MirrorMeterReadingList. Same endpoint serves
  // "latest" (s=0,l=1) and "history" (a=…, paged by s/l) — only the params differ.
  r.get('/mup/:m/mr', (req, res) => {
    const mup = (Number(req.params.m) === 1 ? 1 : 0) as 0 | 1;
    const q = parseReadQuery(req.query as Record<string, string | string[] | undefined>);
    let rows = store.gather({ mup, after: q.after, mrids: q.mrids });
    // Synthesize-on-read: any requested mRID with no stored data still returns a series, so a
    // consumer can read ANY catalog point. Reads are per-mRID; selection isn't gated by a
    // subscription (the live client's CSIP_SUBSCRIPTION only governs what it chooses to post).
    if (q.mrids && q.mrids.length) {
      const present = new Set(rows.map((r2) => r2.mrid));
      const missing = q.mrids.filter((m) => !present.has(m));
      if (missing.length) rows = rows.concat(synthSeries(mup, missing, { now: Math.floor(Date.now() / 1000), after: q.after }));
    }
    rows = rows.sort((a, b) => a.ts - b.ts);
    const all = rows.length;
    const items: MirrorMeterReading[] = rows.slice(q.start, q.start + q.limit).map((sr) => ({
      mRID: sr.mrid, description: sr.point,
      // NOTE: extension-point readings use the `fortress:` mRID convention (e.g. `fortress:soh`);
      // that prefix is the signal to echo the mRID into ReadingType so the client can correlate.
      ReadingType: { uom: sr.uom as any, mRID: sr.mrid.startsWith('fortress:') ? sr.mrid : undefined },
      Reading: { timePeriod: { start: sr.ts, duration: 0 }, value: sr.value },
    }));
    const nextStart = q.start + q.limit;
    const nextHref = nextStart < all
      ? buildReadUrl({ mup, after: q.after, start: nextStart, limit: q.limit, mrids: q.mrids })
      : undefined;
    const body = serializeMirrorMeterReadingListPage({ items, all, results: items.length, nextHref });
    store.logWire({ dir: 'poll', method: 'GET', path: req.originalUrl, status: 200, label: `MirrorMeterReadingList · ${items.length}/${all}`, body });
    send(res, body);
  });
  // Canonical batch (IEEE 2030.5 §10.11.3(d)): POST a MirrorMeterReadingList (or a single
  // MirrorMeterReading) to the MUP resource. We unpack the list and store each reading.
  r.post('/mup/:m', (req, res) => {
    const body = bodyText(req);
    const readings = splitMeterReadings(body);
    for (const mmr of readings) store.addMeterReading(mmr);
    ingestPostedReadings(store, (Number(req.params.m) === 1 ? 1 : 0), body);
    const label = readings.length > 1 ? `MirrorMeterReadingList · ${readings.length} readings` : mmrLabel(body);
    store.logWire({ dir: 'post', method: 'POST', path: `/mup/${req.params.m}`, status: 201, label, body });
    res.setHeader('Location', `/mup/${req.params.m}`); res.status(201).end();
  });
  // Single-reading form (POST one MirrorMeterReading) — also valid per the spec; kept for compat.
  r.post('/mup/:m/mr', (req, res) => {
    const body = bodyText(req);
    store.addMeterReading(body);
    ingestPostedReadings(store, (Number(req.params.m) === 1 ? 1 : 0), body);
    const id = store.meterReadings().length - 1;
    store.logWire({ dir: 'post', method: 'POST', path: `/mup/${req.params.m}/mr`, status: 201, label: mmrLabel(body), body });
    res.setHeader('Location', `/mup/${req.params.m}/mr/${id}`); res.status(201).end();
  });
  r.put('/edev/0/der/0/ders', (req, res) => {
    const body = bodyText(req);
    store.addDerStatus(body);
    store.logWire({ dir: 'post', method: 'PUT', path: '/edev/0/der/0/ders', status: 204, label: 'DERStatus', body });
    res.status(204).end();
  });
  r.post('/rsps', (req, res) => {
    store.logWire({ dir: 'post', method: 'POST', path: '/rsps', status: 201, label: 'DERControlResponse ack', body: bodyText(req) });
    res.status(201).setHeader('Location', '/rsps/0').end();
  });
  const projectionError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const normalized = error instanceof Error ? error : new Error('assignment projection failed');
    enrollment.onProjectionError(normalized);
    res.status(503).type('text/plain').send('Enrollment projection unavailable');
  };
  r.use(projectionError);
  return r;
}
function controlXml(c: QueuedControl): string {
  const base = [c.opModConnect !== undefined ? `<opModConnect>${c.opModConnect}</opModConnect>` : '', c.opModMaxLimW !== undefined ? `<opModMaxLimW>${c.opModMaxLimW}</opModMaxLimW>` : '', c.opModFixedW !== undefined ? `<opModFixedW>${c.opModFixedW}</opModFixedW>` : ''].join('');
  // Per-control timing (U9): emit the injected interval/eventStatus, falling back to the historical
  // hardcodes when omitted so existing immediate-control callers are unaffected.
  const { start, duration } = c.interval ?? { start: 0, duration: 600 };
  const currentStatus = c.eventStatus ?? 1;
  return `<DERControl><mRID>${c.mRID}</mRID><creationTime>0</creationTime><EventStatus><currentStatus>${currentStatus}</currentStatus></EventStatus><interval><start>${start}</start><duration>${duration}</duration></interval><DERControlBase>${base}</DERControlBase></DERControl>`;
}
function send(res: Response, body: string) { res.setHeader('Content-Type', 'application/sep+xml'); res.status(200).send(body); }
function bodyText(req: Request): string { return typeof req.body === 'string' ? req.body : String(req.body ?? ''); }
/** Split a MirrorMeterReadingList (or single MirrorMeterReading) body into individual reading
 *  XML fragments so each is stored/inspectable on its own. Falls back to the whole body. */
function splitMeterReadings(body: string): string[] {
  const matches = body.match(/<MirrorMeterReading\b[\s\S]*?<\/MirrorMeterReading>/g);
  return matches && matches.length ? matches : [body];
}
/** Ingest a POSTed MirrorMeterReading(List) body into the typed reading store so it becomes
 *  readable via GET /mup/:m/mr. Wraps a bare single reading in a List so the list parser applies. */
function ingestPostedReadings(store: Store, mup: 0 | 1, body: string) {
  const listXml = /<MirrorMeterReadingList[\s>]/.test(body)
    ? body
    : `<MirrorMeterReadingList xmlns="urn:ieee:std:2030.5:ns">${body.replace(/<\?xml[^>]*\?>\s*/, '')}</MirrorMeterReadingList>`;
  const parsed = parseMirrorMeterReadingList(listXml);
  for (const r of parsed.readings) {
    store.addReading({
      ts: r.start,
      mup,
      mrid: r.convention || r.mRID,
      point: r.description || r.mRID,
      uom: r.uom,
      value: r.value,
    });
  }
}

/** Pull the reading's point/convention out of a MirrorMeterReading body for the wire-log label. */
function mmrLabel(xml: string): string {
  const conv = xml.match(/<ReadingType>[\s\S]*?<mRID>([^<]+)<\/mRID>/)?.[1];
  const desc = xml.match(/<description>([^<]+)<\/description>/)?.[1];
  return `MirrorMeterReading${conv ? ` · ${conv}` : desc ? ` · ${desc}` : ''}`;
}
