import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AssignmentDiscovery,
  CsipDiscoveryError,
  MemorySessionStore,
  ResourceClient,
  type AssignmentSnapshot,
} from '../src/index.js';
import { link, startFixture, xml, type RunningFixture } from './fixture-server.js';

const DEVICE_ALPHA = '1111111111111111111111111111111111111111';
const DEVICE_BETA = '2222222222222222222222222222222222222222';

interface GraphState {
  assignments: Record<string, 'alpha' | 'beta' | 'none'>;
  etag: number;
  unknown?: boolean;
  duplicate?: boolean;
  cycle?: boolean;
  failProgram?: boolean;
  crossOrigin?: boolean;
  sawConditionalGet: boolean;
}

function send(response: ServerResponse, body: string, etag: number): void {
  response.writeHead(200, { 'content-type': 'application/sep+xml', etag: `"${etag}"` });
  response.end(body);
}

function graphHandler(prefix: string, state: GraphState) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    if (request.headers['if-none-match'] === `"${state.etag}"`) {
      state.sawConditionalGet = true;
      response.writeHead(304).end();
      return;
    }

    const path = new URL(request.url ?? '/', 'http://fixture').pathname;
    if (path === `${prefix}/capability`) {
      send(response, xml('DeviceCapability', link('EndDeviceListLink', `${prefix}/devices/page-a`), ' pollRate="17"'), state.etag);
      return;
    }
    if (path === `${prefix}/devices/page-a`) {
      const deviceAlpha = `<EndDevice href="${prefix}/devices/device-alpha"><lFDI>${DEVICE_ALPHA}</lFDI>${link('FunctionSetAssignmentsListLink', `${prefix}/assign/device-alpha`)}</EndDevice>`;
      const duplicate = state.duplicate ? deviceAlpha : '';
      const unknown = state.unknown
        ? `<EndDevice href="${prefix}/devices/unknown"><lFDI>3333333333333333333333333333333333333333</lFDI></EndDevice>`
        : '';
      const extraCount = Number(state.duplicate ?? false) + Number(state.unknown ?? false);
      const total = 2 + extraCount;
      const next = state.cycle ? `${prefix}/devices/page-a` : `${prefix}/devices/page-z`;
      send(response, xml('EndDeviceList', `${deviceAlpha}${duplicate}${unknown}<Link rel="next" href="${next}"/>`, ` all="${total}" results="${1 + extraCount}"`), state.etag);
      return;
    }
    if (path === `${prefix}/devices/page-z`) {
      const deviceBeta = `<EndDevice href="${prefix}/devices/device-beta"><lFDI>${DEVICE_BETA}</lFDI>${link('FunctionSetAssignmentsListLink', `${prefix}/assign/device-beta`)}</EndDevice>`;
      const total = 2 + Number(state.duplicate ?? false) + Number(state.unknown ?? false);
      send(response, xml('EndDeviceList', deviceBeta, ` all="${total}" results="1"`), state.etag);
      return;
    }

    const assignmentMatch = path.match(new RegExp(`^${prefix}/assign/(device-alpha|device-beta)$`));
    if (assignmentMatch) {
      const device = assignmentMatch[1];
      const assigned = state.assignments[device];
      const item = assigned === 'none' ? '' : `<FunctionSetAssignments href="${prefix}/fsa/${device}-${assigned}"><mRID>${device}-${assigned}</mRID>${link('DERProgramListLink', `${prefix}/programs/${assigned}`)}</FunctionSetAssignments>`;
      send(response, xml('FunctionSetAssignmentsList', item, ` all="${item ? 1 : 0}" results="${item ? 1 : 0}" pollRate="23"`), state.etag);
      return;
    }

    const programsMatch = path.match(new RegExp(`^${prefix}/programs/(alpha|beta)$`));
    if (programsMatch) {
      if (state.failProgram) {
        response.writeHead(503).end('unavailable');
        return;
      }
      const name = programsMatch[1];
      const controlHref = state.crossOrigin ? 'https://unapproved.example/controls' : `${prefix}/controls/${name}`;
      const item = `<DERProgram href="${prefix}/program/${name}"><mRID>${name}</mRID><primacy>${name === 'alpha' ? 2 : 7}</primacy>${link('DERControlListLink', controlHref)}</DERProgram>`;
      send(response, xml('DERProgramList', item, ' all="1" results="1"'), state.etag);
      return;
    }
    response.writeHead(404).end();
  };
}

function assignments(snapshot: AssignmentSnapshot, lfdi: string): string[] {
  return snapshot.devices.find((device) => device.lFDI === lfdi)?.programs.map((program) => program.mRID) ?? [];
}

describe('assignment discovery', () => {
  const fixtures: RunningFixture[] = [];
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.close())));

  it('walks randomized, paginated links and treats partner assignment changes as authoritative', async () => {
    const state: GraphState = {
      assignments: { 'device-alpha': 'alpha', 'device-beta': 'beta' },
      etag: 1,
      sawConditionalGet: false,
    };
    let fixture!: RunningFixture;
    fixture = await startFixture((request, response) => graphHandler(fixture.prefix, state)(request, response));
    fixtures.push(fixture);
    const store = new MemorySessionStore();
    const discovery = new AssignmentDiscovery({
      resources: new ResourceClient({ transport: fixture.transport, store }),
      store,
    });

    const initial = await discovery.reconcile(`${fixture.prefix}/capability`, new Set([DEVICE_ALPHA, DEVICE_BETA]));
    expect(initial.valid).toBe(true);
    expect(assignments(initial, DEVICE_ALPHA)).toEqual(['alpha']);
    expect(assignments(initial, DEVICE_BETA)).toEqual(['beta']);

    await discovery.reconcile(`${fixture.prefix}/capability`, new Set([DEVICE_ALPHA, DEVICE_BETA]));
    expect(state.sawConditionalGet).toBe(true);

    state.assignments['device-alpha'] = 'beta';
    state.etag += 1;
    const moved = await discovery.reconcile(`${fixture.prefix}/capability`, new Set([DEVICE_ALPHA, DEVICE_BETA]));
    expect(assignments(moved, DEVICE_ALPHA)).toEqual(['beta']);
    expect(assignments(moved, DEVICE_BETA)).toEqual(['beta']);
    expect(moved.devices.map((device) => device.lFDI)).toEqual([DEVICE_ALPHA, DEVICE_BETA]);
  });

  it.each([
    ['unknown LFDI', { unknown: true }],
    ['duplicate LFDI', { duplicate: true }],
    ['link cycle', { cycle: true }],
    ['cross-origin link', { crossOrigin: true }],
    ['partially failed graph', { failProgram: true }],
  ])('fails closed for %s and clears any previous target snapshot', async (_name, fault) => {
    const state: GraphState = {
      assignments: { 'device-alpha': 'alpha', 'device-beta': 'beta' },
      etag: 1,
      sawConditionalGet: false,
      ...fault,
    };
    let fixture!: RunningFixture;
    fixture = await startFixture((request, response) => graphHandler(fixture.prefix, state)(request, response));
    fixtures.push(fixture);
    const store = new MemorySessionStore();
    await store.saveAssignmentSnapshot({
      valid: true,
      devices: [{ lFDI: DEVICE_ALPHA, programs: [{ mRID: 'stale', primacy: 1, controlListHref: '/stale' }] }],
    });
    const discovery = new AssignmentDiscovery({
      resources: new ResourceClient({ transport: fixture.transport, store, maxPages: 4 }),
      store,
      maxResources: 16,
    });

    await expect(discovery.reconcile(`${fixture.prefix}/capability`, new Set([DEVICE_ALPHA, DEVICE_BETA])))
      .rejects.toBeInstanceOf(CsipDiscoveryError);
    expect(await store.loadAssignmentSnapshot()).toMatchObject({ valid: false, devices: [] });
  });

  it('converges when a previously visible EndDevice is removed', async () => {
    const store = new MemorySessionStore();
    const state: GraphState = {
      assignments: { 'device-alpha': 'alpha', 'device-beta': 'none' },
      etag: 1,
      sawConditionalGet: false,
    };
    let fixture!: RunningFixture;
    fixture = await startFixture((request, response) => {
      if (new URL(request.url ?? '/', 'http://fixture').pathname === `${fixture.prefix}/devices/page-a`) {
        const item = `<EndDevice href="${fixture.prefix}/devices/device-alpha"><lFDI>${DEVICE_ALPHA}</lFDI>${link('FunctionSetAssignmentsListLink', `${fixture.prefix}/assign/device-alpha`)}</EndDevice>`;
        send(response, xml('EndDeviceList', item, ' all="1" results="1"'), state.etag);
        return;
      }
      graphHandler(fixture.prefix, state)(request, response);
    });
    fixtures.push(fixture);
    const discovery = new AssignmentDiscovery({ resources: new ResourceClient({ transport: fixture.transport, store }), store });
    const snapshot = await discovery.reconcile(`${fixture.prefix}/capability`, new Set([DEVICE_ALPHA, DEVICE_BETA]));
    expect(snapshot.devices.map((device) => device.lFDI)).toEqual([DEVICE_ALPHA]);
  });

  it('keeps registrations visible while limiting assignment reads to command-eligible sites', async () => {
    const state: GraphState = {
      assignments: { 'device-alpha': 'alpha', 'device-beta': 'beta' },
      etag: 1,
      sawConditionalGet: false,
    };
    let fixture!: RunningFixture;
    fixture = await startFixture((request, response) => graphHandler(fixture.prefix, state)(request, response));
    fixtures.push(fixture);
    const store = new MemorySessionStore();
    const discovery = new AssignmentDiscovery({
      resources: new ResourceClient({ transport: fixture.transport, store }),
      store,
    });

    const snapshot = await discovery.reconcile(
      `${fixture.prefix}/capability`,
      new Set([DEVICE_ALPHA, DEVICE_BETA]),
      new Set([DEVICE_ALPHA]),
    );

    expect(snapshot.devices.map((device) => device.lFDI)).toEqual([DEVICE_ALPHA, DEVICE_BETA]);
    expect(assignments(snapshot, DEVICE_ALPHA)).toEqual(['alpha']);
    expect(assignments(snapshot, DEVICE_BETA)).toEqual([]);
  });

  it('continues assignment reads for an accepted active control after eligibility is revoked', async () => {
    const state: GraphState = {
      assignments: { 'device-alpha': 'alpha', 'device-beta': 'beta' },
      etag: 1,
      sawConditionalGet: false,
    };
    let fixture!: RunningFixture;
    fixture = await startFixture((request, response) => graphHandler(fixture.prefix, state)(request, response));
    fixtures.push(fixture);
    const store = new MemorySessionStore();
    await store.saveControl({
      internalEventId: 'accepted-beta',
      materialFingerprint: 'accepted-beta-fingerprint',
      lastStatus: 1,
      admissionState: 'accepted',
      intent: {
        family: 'csip',
        connectionId: 'partner-a',
        internalEventId: 'accepted-beta',
        wireMrid: 'accepted-beta',
        programMrid: 'beta',
        programPrimacy: 7,
        assignedLFDIs: [DEVICE_BETA],
        responseRequired: '00',
        creationTime: 1,
        eventStatus: 1,
        interval: { start: 1, duration: 1_000 },
        control: { opModFixedW: -500 },
      },
    });
    const discovery = new AssignmentDiscovery({
      resources: new ResourceClient({ transport: fixture.transport, store }),
      store,
      now: () => 100,
    });

    const snapshot = await discovery.reconcile(
      `${fixture.prefix}/capability`,
      new Set([DEVICE_ALPHA, DEVICE_BETA]),
      new Set([DEVICE_ALPHA]),
    );

    expect(assignments(snapshot, DEVICE_ALPHA)).toEqual(['alpha']);
    expect(assignments(snapshot, DEVICE_BETA)).toEqual(['beta']);
  });

  it('bounds nested reads and deduplicates identical assignment hrefs', async () => {
    const lFDIs = Array.from({ length: 12 }, (_, index) => (index + 10).toString(16).padStart(40, '0'));
    let fixture!: RunningFixture;
    let activeNestedReads = 0;
    let maxActiveNestedReads = 0;
    const nestedReads = new Map<string, number>();
    fixture = await startFixture(async (request, response) => {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname;
      if (path === `${fixture.prefix}/capability`) {
        response.end(xml('DeviceCapability', link('EndDeviceListLink', `${fixture.prefix}/devices`), ' pollRate="30"'));
        return;
      }
      if (path === `${fixture.prefix}/devices`) {
        const items = lFDIs.map((lFDI, index) =>
          `<EndDevice href="${fixture.prefix}/device/${lFDI}"><lFDI>${lFDI}</lFDI>${link('FunctionSetAssignmentsListLink', `${fixture.prefix}/assign/${index % 3}`)}</EndDevice>`,
        ).join('');
        response.end(xml('EndDeviceList', items, ` all="${lFDIs.length}" results="${lFDIs.length}"`));
        return;
      }
      if (path.startsWith(`${fixture.prefix}/assign/`) || path === `${fixture.prefix}/programs/shared`) {
        activeNestedReads += 1;
        maxActiveNestedReads = Math.max(maxActiveNestedReads, activeNestedReads);
        nestedReads.set(path, (nestedReads.get(path) ?? 0) + 1);
        await new Promise((resolve) => setTimeout(resolve, 3));
        activeNestedReads -= 1;
        if (path.startsWith(`${fixture.prefix}/assign/`)) {
          const suffix = path.at(-1)!;
          const item = `<FunctionSetAssignments href="${fixture.prefix}/fsa/${suffix}"><mRID>fsa-${suffix}</mRID>${link('DERProgramListLink', `${fixture.prefix}/programs/shared`)}</FunctionSetAssignments>`;
          response.end(xml('FunctionSetAssignmentsList', item, ' all="1" results="1"'));
          return;
        }
        const item = `<DERProgram href="${fixture.prefix}/program/shared"><mRID>shared</mRID><primacy>1</primacy>${link('DERControlListLink', `${fixture.prefix}/controls/shared`)}</DERProgram>`;
        response.end(xml('DERProgramList', item, ' all="1" results="1"'));
        return;
      }
      response.writeHead(404).end();
    });
    fixtures.push(fixture);
    const store = new MemorySessionStore();
    const discovery = new AssignmentDiscovery({
      resources: new ResourceClient({ transport: fixture.transport, store }),
      store,
      concurrency: 2,
    });

    const snapshot = await discovery.reconcile(`${fixture.prefix}/capability`, new Set(lFDIs));
    expect(snapshot.devices).toHaveLength(lFDIs.length);
    expect(snapshot.devices.every((device) => device.programs[0]?.mRID === 'shared')).toBe(true);
    expect(maxActiveNestedReads).toBe(2);
    expect([...nestedReads.values()].every((count) => count === 1)).toBe(true);
    expect(nestedReads.size).toBe(4);
  });
});
