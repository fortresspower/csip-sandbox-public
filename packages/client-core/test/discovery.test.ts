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

const HILDA = '1111111111111111111111111111111111111111';
const LAB = '2222222222222222222222222222222222222222';

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

    const path = request.url ?? '';
    if (path === `${prefix}/capability`) {
      send(response, xml('DeviceCapability', link('EndDeviceListLink', `${prefix}/devices/page-a`), ' pollRate="17"'), state.etag);
      return;
    }
    if (path === `${prefix}/devices/page-a`) {
      const hilda = `<EndDevice href="${prefix}/devices/hilda"><lFDI>${HILDA}</lFDI>${link('FunctionSetAssignmentsListLink', `${prefix}/assign/hilda`)}</EndDevice>`;
      const duplicate = state.duplicate ? hilda : '';
      const unknown = state.unknown
        ? `<EndDevice href="${prefix}/devices/unknown"><lFDI>3333333333333333333333333333333333333333</lFDI></EndDevice>`
        : '';
      const extraCount = Number(state.duplicate ?? false) + Number(state.unknown ?? false);
      const total = 2 + extraCount;
      const next = state.cycle ? `${prefix}/devices/page-a` : `${prefix}/devices/page-z`;
      send(response, xml('EndDeviceList', `${hilda}${duplicate}${unknown}<Link rel="next" href="${next}"/>`, ` all="${total}" results="${1 + extraCount}"`), state.etag);
      return;
    }
    if (path === `${prefix}/devices/page-z`) {
      const lab = `<EndDevice href="${prefix}/devices/lab"><lFDI>${LAB}</lFDI>${link('FunctionSetAssignmentsListLink', `${prefix}/assign/lab`)}</EndDevice>`;
      const total = 2 + Number(state.duplicate ?? false) + Number(state.unknown ?? false);
      send(response, xml('EndDeviceList', lab, ` all="${total}" results="1"`), state.etag);
      return;
    }

    const assignmentMatch = path.match(new RegExp(`^${prefix}/assign/(hilda|lab)$`));
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
      assignments: { hilda: 'alpha', lab: 'beta' },
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

    const initial = await discovery.reconcile(`${fixture.prefix}/capability`, new Set([HILDA, LAB]));
    expect(initial.valid).toBe(true);
    expect(assignments(initial, HILDA)).toEqual(['alpha']);
    expect(assignments(initial, LAB)).toEqual(['beta']);

    await discovery.reconcile(`${fixture.prefix}/capability`, new Set([HILDA, LAB]));
    expect(state.sawConditionalGet).toBe(true);

    state.assignments.hilda = 'beta';
    state.etag += 1;
    const moved = await discovery.reconcile(`${fixture.prefix}/capability`, new Set([HILDA, LAB]));
    expect(assignments(moved, HILDA)).toEqual(['beta']);
    expect(assignments(moved, LAB)).toEqual(['beta']);
    expect(moved.devices.map((device) => device.lFDI)).toEqual([HILDA, LAB]);
  });

  it.each([
    ['unknown LFDI', { unknown: true }],
    ['duplicate LFDI', { duplicate: true }],
    ['link cycle', { cycle: true }],
    ['cross-origin link', { crossOrigin: true }],
    ['partially failed graph', { failProgram: true }],
  ])('fails closed for %s and clears any previous target snapshot', async (_name, fault) => {
    const state: GraphState = {
      assignments: { hilda: 'alpha', lab: 'beta' },
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
      devices: [{ lFDI: HILDA, programs: [{ mRID: 'stale', primacy: 1, controlListHref: '/stale' }] }],
    });
    const discovery = new AssignmentDiscovery({
      resources: new ResourceClient({ transport: fixture.transport, store, maxPages: 4 }),
      store,
      maxResources: 16,
    });

    await expect(discovery.reconcile(`${fixture.prefix}/capability`, new Set([HILDA, LAB])))
      .rejects.toBeInstanceOf(CsipDiscoveryError);
    expect(await store.loadAssignmentSnapshot()).toMatchObject({ valid: false, devices: [] });
  });

  it('converges when a previously visible EndDevice is removed', async () => {
    const store = new MemorySessionStore();
    const state: GraphState = {
      assignments: { hilda: 'alpha', lab: 'none' },
      etag: 1,
      sawConditionalGet: false,
    };
    let fixture!: RunningFixture;
    fixture = await startFixture((request, response) => {
      if (request.url === `${fixture.prefix}/devices/page-a`) {
        const item = `<EndDevice href="${fixture.prefix}/devices/hilda"><lFDI>${HILDA}</lFDI>${link('FunctionSetAssignmentsListLink', `${fixture.prefix}/assign/hilda`)}</EndDevice>`;
        send(response, xml('EndDeviceList', item, ' all="1" results="1"'), state.etag);
        return;
      }
      graphHandler(fixture.prefix, state)(request, response);
    });
    fixtures.push(fixture);
    const discovery = new AssignmentDiscovery({ resources: new ResourceClient({ transport: fixture.transport, store }), store });
    const snapshot = await discovery.reconcile(`${fixture.prefix}/capability`, new Set([HILDA, LAB]));
    expect(snapshot.devices.map((device) => device.lFDI)).toEqual([HILDA]);
  });

  it('keeps known registrations visible while excluding execution-ineligible assignments', async () => {
    const state: GraphState = {
      assignments: { hilda: 'alpha', lab: 'beta' },
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
      new Set([HILDA, LAB]),
      new Set([HILDA]),
    );

    expect(snapshot.devices.map((device) => device.lFDI)).toEqual([HILDA, LAB]);
    expect(assignments(snapshot, HILDA)).toEqual(['alpha']);
    expect(assignments(snapshot, LAB)).toEqual([]);
  });
});
