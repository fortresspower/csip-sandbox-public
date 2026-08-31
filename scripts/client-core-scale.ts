import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import {
  AssignmentDiscovery,
  DEFAULT_MAX_LIST_ITEMS,
  DEFAULT_MAX_LIST_PAGES,
  DEFAULT_MAX_PAGE_ITEMS,
  EndDeviceEnrollment,
  MemorySessionStore,
  ResourceClient,
  TelemetryPublisher,
  type AssignmentSnapshot,
  type StoredEndDevice,
  type CsipRequestOptions,
  type CsipResponse,
  type CsipTransport,
} from '../packages/client-core/src/index.js';

const SITE_COUNT = 100_000;
const PAGE_ITEMS = 500;
const CONTROL_CONCURRENCY = 8;
const TELEMETRY_CONCURRENCY = 32;
const TELEMETRY_LATENCY_MS = 20;
const CONTROL_WALL_BUDGET_MS = 30_000;
const TELEMETRY_BOOTSTRAP_BUDGET_MS = 60_000;
const TELEMETRY_STEADY_BUDGET_MS = 20_000;
const HEAP_BUDGET_BYTES = 256 * 1024 * 1024;
const ABORT_BUDGET_MS = 250;

const lfdi = (index: number): string => index.toString(16).padStart(40, '0');
const link = (name: string, href: string): string => `<${name} href="${href}"/>`;
const xml = (root: string, content: string, attributes = ''): string =>
  `<?xml version="1.0"?><${root} xmlns="urn:ieee:std:2030.5:ns"${attributes}>${content}</${root}>`;

interface ScaleCounters {
  getRequests: number;
  postRequests: number;
  maxPageItems: number;
  maxActiveEffects: number;
}

class ScaleTransport implements CsipTransport {
  readonly origin = 'https://partner.example';
  readonly counters: ScaleCounters = { getRequests: 0, postRequests: 0, maxPageItems: 0, maxActiveEffects: 0 };
  #activeEffects = 0;

  constructor(readonly effectLatencyMs: number) {}

  async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    href: string,
    _options: CsipRequestOptions = {},
  ): Promise<CsipResponse> {
    const target = new URL(href, this.origin);
    if (method === 'GET') {
      this.counters.getRequests += 1;
      return { status: 200, headers: {}, body: this.#get(target) };
    }
    this.counters.postRequests += 1;
    this.#activeEffects += 1;
    this.counters.maxActiveEffects = Math.max(this.counters.maxActiveEffects, this.#activeEffects);
    if (this.effectLatencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.effectLatencyMs));
    else await Promise.resolve();
    this.#activeEffects -= 1;
    return { status: method === 'POST' ? 201 : 204, headers: {}, body: '' };
  }

  get(href: string): Promise<CsipResponse> { return this.request('GET', href); }
  post(href: string, body: string): Promise<CsipResponse> { return this.request('POST', href, { body }); }
  put(href: string, body: string): Promise<CsipResponse> { return this.request('PUT', href, { body }); }
  close(): void {}

  #get(target: URL): string {
    if (target.pathname === '/fleet/capability') {
      return xml(
        'DeviceCapability',
        `${link('EndDeviceListLink', '/fleet/devices?page=0')}${link('MirrorUsagePointListLink', '/telemetry/mups?page=0')}`,
        ' pollRate="60"',
      );
    }
    if (target.pathname === '/fleet/devices') {
      return this.#page(target, SITE_COUNT, 'EndDeviceList', (index) =>
        `<EndDevice href="/fleet/device/${index}"><lFDI>${lfdi(index)}</lFDI>${link('FunctionSetAssignmentsListLink', '/assignment/shared')}</EndDevice>`,
      );
    }
    if (target.pathname === '/assignment/shared') {
      return xml(
        'FunctionSetAssignmentsList',
        `<FunctionSetAssignments href="/assignment/fsa/shared"><mRID>shared-fsa</mRID>${link('DERProgramListLink', '/assignment/programs/shared')}</FunctionSetAssignments>`,
        ' all="1" results="1"',
      );
    }
    if (target.pathname === '/assignment/programs/shared') {
      return xml(
        'DERProgramList',
        `<DERProgram href="/assignment/program/shared"><mRID>shared-program</mRID><primacy>1</primacy>${link('DERControlListLink', '/assignment/controls/shared')}</DERProgram>`,
        ' all="1" results="1"',
      );
    }
    if (target.pathname === '/telemetry/mups') {
      return this.#page(target, SITE_COUNT * 2, 'MirrorUsagePointList', (routeIndex) => {
        const index = Math.floor(routeIndex / 2);
        const deviceLfdi = lfdi(index);
        return routeIndex % 2 === 0
          ? `<MirrorUsagePoint href="/telemetry/post/${index}/standard"><mRID>standard-${index}</mRID><postRate>300</postRate><deviceLFDI>${deviceLfdi}</deviceLFDI></MirrorUsagePoint>`
          : `<MirrorUsagePoint href="/telemetry/post/${index}/extension"><mRID>fortress:extension-${index}</mRID><postRate>600</postRate><deviceLFDI>${deviceLfdi}</deviceLFDI></MirrorUsagePoint>`;
      });
    }
    throw new Error(`unexpected scale GET ${target.pathname}${target.search}`);
  }

  #page(target: URL, total: number, root: string, item: (index: number) => string): string {
    const page = Number(target.searchParams.get('page') ?? '0');
    const start = page * PAGE_ITEMS;
    const count = Math.max(0, Math.min(PAGE_ITEMS, total - start));
    this.counters.maxPageItems = Math.max(this.counters.maxPageItems, count);
    const items = Array.from({ length: count }, (_, offset) => item(start + offset)).join('');
    const next = start + count < total ? `<Link rel="next" href="${target.pathname}?page=${page + 1}"/>` : '';
    return xml(root, `${items}${next}`, ` all="${total}" results="${count}"`);
  }
}

/** Models a durable adapter without making the benchmark retain a second in-memory fleet copy. */
class ScaleSessionStore extends MemorySessionStore {
  savedEndDevices = 0;
  savedAssignmentDevices = 0;

  override async saveEndDevice(_device: StoredEndDevice): Promise<void> {
    this.savedEndDevices += 1;
  }

  override async saveAssignmentSnapshot(snapshot: AssignmentSnapshot): Promise<void> {
    this.savedAssignmentDevices = snapshot.devices.length;
  }
}

class AbortEnrollmentTransport implements CsipTransport {
  readonly origin = 'https://partner.example';
  posts = 0;
  active = 0;
  maxActive = 0;

  async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', href: string): Promise<CsipResponse> {
    const path = new URL(href, this.origin).pathname;
    if (method === 'GET' && path === '/abort/capability') {
      return { status: 200, headers: {}, body: xml('DeviceCapability', link('EndDeviceListLink', '/abort/devices'), ' pollRate="60"') };
    }
    if (method === 'GET' && path === '/abort/devices') {
      return { status: 200, headers: {}, body: xml('EndDeviceList', '', ' all="0" results="0"') };
    }
    if (method === 'POST' && path === '/abort/devices') {
      this.posts += 1;
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      this.active -= 1;
      return { status: 201, headers: { location: `/abort/device/${this.posts}` }, body: '' };
    }
    throw new Error(`unexpected abort request ${method} ${path}`);
  }

  get(href: string): Promise<CsipResponse> { return this.request('GET', href); }
  post(href: string): Promise<CsipResponse> { return this.request('POST', href); }
  put(href: string): Promise<CsipResponse> { return this.request('PUT', href); }
  close(): void {}
}

function forceGc(): void {
  (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
}

async function main(): Promise<void> {
  assert.equal(DEFAULT_MAX_LIST_PAGES, 2_048);
  assert.equal(DEFAULT_MAX_LIST_ITEMS, 200_000);
  assert.equal(DEFAULT_MAX_PAGE_ITEMS, 500);
  assert.ok(Math.ceil((SITE_COUNT * 2) / 100) <= DEFAULT_MAX_LIST_PAGES, 'default page budget must allow 200k routes at 100 items/page');
  const lFDIs = Array.from({ length: SITE_COUNT }, (_, index) => lfdi(index));
  const known = new Set(lFDIs);
  let clock = 0;
  const transport = new ScaleTransport(TELEMETRY_LATENCY_MS);
  const store = new ScaleSessionStore();
  const resources = new ResourceClient({ transport, store });
  const phaseMs: Record<string, number> = {};
  forceGc();
  const baselineHeap = process.memoryUsage().heapUsed;
  let peakHeap = baselineHeap;
  const sampleHeap = (): void => { peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); };
  const heapSampler = setInterval(sampleHeap, 10);
  heapSampler.unref();
  const totalStarted = performance.now();

  let started = performance.now();
  const fleet = await resources.endDeviceFleet('/fleet/capability');
  phaseMs.fleetSnapshot = performance.now() - started;
  assert.equal(fleet.endDevices.length, SITE_COUNT);
  sampleHeap();

  started = performance.now();
  let enrollmentResult: unknown = await new EndDeviceEnrollment({ resources, store, concurrency: CONTROL_CONCURRENCY })
    .reconcileFleet('/fleet/capability', lFDIs, { snapshot: fleet });
  phaseMs.enrollment = performance.now() - started;
  assert.equal((enrollmentResult as { devices: unknown[] }).devices.length, SITE_COUNT);
  assert.equal((enrollmentResult as { snapshot: unknown }).snapshot, fleet);
  assert.equal((enrollmentResult as { inventoryChanged: boolean }).inventoryChanged, false);
  assert.equal(store.savedEndDevices, SITE_COUNT);
  enrollmentResult = undefined;
  sampleHeap();
  forceGc();

  started = performance.now();
  let snapshot: unknown = await new AssignmentDiscovery({ resources, store, concurrency: CONTROL_CONCURRENCY })
    .reconcile('/fleet/capability', known, known, { snapshot: fleet });
  phaseMs.assignment = performance.now() - started;
  assert.equal((snapshot as { devices: unknown[] }).devices.length, SITE_COUNT);
  assert.equal(store.savedAssignmentDevices, SITE_COUNT);
  snapshot = undefined;
  sampleHeap();
  forceGc();
  const controlWallMs = phaseMs.fleetSnapshot + phaseMs.enrollment + phaseMs.assignment;

  const publisher = new TelemetryPublisher({
    resources,
    source: { async read() { return { timestamp: clock, activePowerW: 1 }; } },
    now: () => clock,
    concurrency: TELEMETRY_CONCURRENCY,
    workBatchSize: 500,
  });
  started = performance.now();
  const profiles = await publisher.discover('/fleet/capability', known, { snapshot: fleet });
  phaseMs.telemetryDiscovery = performance.now() - started;
  assert.equal(profiles.length, SITE_COUNT);
  assert.ok(profiles.every((profile) => profile.extensionMupHref !== undefined));
  sampleHeap();
  forceGc();

  clock = 60;
  started = performance.now();
  const publish = await publisher.runDue(profiles);
  phaseMs.telemetryPublish = performance.now() - started;
  assert.equal(publish.queued, publish.sent);
  assert.equal(publish.retryableFailures, 0);
  assert.equal(publish.quarantined, 0);
  assert.equal(publish.backpressured, 0);
  assert.ok(publish.sent >= 19_000 && publish.sent <= 21_000, `steady pass sent ${publish.sent}, expected about 20,000`);
  sampleHeap();

  const abortTransport = new AbortEnrollmentTransport();
  const abortStore = new MemorySessionStore();
  const abortEnrollment = new EndDeviceEnrollment({
    resources: new ResourceClient({ transport: abortTransport, store: abortStore }),
    store: abortStore,
    concurrency: CONTROL_CONCURRENCY,
  });
  const controller = new AbortController();
  const abortStarted = performance.now();
  const aborted = abortEnrollment.reconcileMany('/abort/capability', lFDIs.slice(0, 1_000), { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('scale stop')), 1);
  await assert.rejects(aborted, /scale stop/);
  const abortMs = performance.now() - abortStarted;

  const totalWallMs = performance.now() - totalStarted;
  clearInterval(heapSampler);
  sampleHeap();
  const heapDeltaBytes = peakHeap - baselineHeap;
  if (controlWallMs > CONTROL_WALL_BUDGET_MS
    || phaseMs.telemetryDiscovery > TELEMETRY_BOOTSTRAP_BUDGET_MS
    || phaseMs.telemetryPublish > TELEMETRY_STEADY_BUDGET_MS
    || heapDeltaBytes > HEAP_BUDGET_BYTES
    || abortMs > ABORT_BUDGET_MS) {
    process.stderr.write(`${JSON.stringify({
      totalWallMs: Number(totalWallMs.toFixed(1)),
      controlWallMs: Number(controlWallMs.toFixed(1)),
      sampledPeakHeapDeltaMiB: Number((heapDeltaBytes / 1024 / 1024).toFixed(1)),
      phaseMs: Object.fromEntries(Object.entries(phaseMs).map(([key, value]) => [key, Number(value.toFixed(1))])),
      abortMs: Number(abortMs.toFixed(1)),
    }, null, 2)}\n`);
  }
  assert.ok(controlWallMs <= CONTROL_WALL_BUDGET_MS, `control round ${controlWallMs.toFixed(1)}ms exceeded ${CONTROL_WALL_BUDGET_MS}ms`);
  assert.ok(phaseMs.telemetryDiscovery <= TELEMETRY_BOOTSTRAP_BUDGET_MS, `telemetry bootstrap ${phaseMs.telemetryDiscovery.toFixed(1)}ms exceeded ${TELEMETRY_BOOTSTRAP_BUDGET_MS}ms`);
  assert.ok(phaseMs.telemetryPublish <= TELEMETRY_STEADY_BUDGET_MS, `telemetry steady pass ${phaseMs.telemetryPublish.toFixed(1)}ms exceeded ${TELEMETRY_STEADY_BUDGET_MS}ms`);
  assert.ok(heapDeltaBytes <= HEAP_BUDGET_BYTES, `scale heap delta ${(heapDeltaBytes / 1024 / 1024).toFixed(1)}MiB exceeded 256MiB`);
  assert.ok(transport.counters.maxPageItems <= DEFAULT_MAX_PAGE_ITEMS);
  assert.ok(transport.counters.maxActiveEffects <= TELEMETRY_CONCURRENCY);
  assert.ok(abortTransport.maxActive <= CONTROL_CONCURRENCY);
  assert.ok(abortMs <= ABORT_BUDGET_MS, `abort took ${abortMs.toFixed(1)}ms`);
  assert.ok(abortTransport.posts <= CONTROL_CONCURRENCY, `abort launched ${abortTransport.posts} registrations`);
  const requiredTelemetryConcurrency = Math.ceil((20_000 * TELEMETRY_LATENCY_MS) / TELEMETRY_STEADY_BUDGET_MS);
  assert.ok(TELEMETRY_CONCURRENCY >= requiredTelemetryConcurrency);

  const report = {
    schema: 'fortress-csip-client-core-scale/v1',
    scenario: {
      sites: SITE_COUNT,
      mirrorUsagePoints: SITE_COUNT * 2,
      pageItems: PAGE_ITEMS,
      assignmentShape: 'one shared FSA and DERProgram resolved for every site',
      telemetryShape: 'asynchronous standard/extension route bootstrap, then one staggered 60-second steady window',
      telemetrySteadyWindowSeconds: 60,
      injectedTelemetryLatencyMs: TELEMETRY_LATENCY_MS,
    },
    budgets: {
      controlRoundMs: CONTROL_WALL_BUDGET_MS,
      telemetryBootstrapMs: TELEMETRY_BOOTSTRAP_BUDGET_MS,
      telemetrySteadyMs: TELEMETRY_STEADY_BUDGET_MS,
      heapDeltaMiB: HEAP_BUDGET_BYTES / 1024 / 1024,
      maxPageItems: DEFAULT_MAX_PAGE_ITEMS,
      maxPages: DEFAULT_MAX_LIST_PAGES,
      maxListItems: DEFAULT_MAX_LIST_ITEMS,
      maxControlConcurrency: CONTROL_CONCURRENCY,
      maxTelemetryConcurrency: TELEMETRY_CONCURRENCY,
      derivedMinimumTelemetryConcurrency: requiredTelemetryConcurrency,
      abortMs: ABORT_BUDGET_MS,
    },
    actuals: {
      totalWallMs: Number(totalWallMs.toFixed(1)),
      controlRoundMs: Number(controlWallMs.toFixed(1)),
      sampledPeakHeapDeltaMiB: Number((heapDeltaBytes / 1024 / 1024).toFixed(1)),
      phaseMs: Object.fromEntries(Object.entries(phaseMs).map(([key, value]) => [key, Number(value.toFixed(1))])),
      getRequests: transport.counters.getRequests,
      postRequests: transport.counters.postRequests,
      maxPageItems: transport.counters.maxPageItems,
      maxActiveEffects: transport.counters.maxActiveEffects,
      steadyPublishes: publish.sent,
      steadyPublishesPerSecond: Number((publish.sent / (phaseMs.telemetryPublish / 1_000)).toFixed(1)),
      abortMs: Number(abortMs.toFixed(1)),
      abortRegistrationsStarted: abortTransport.posts,
      abortMaxActive: abortTransport.maxActive,
    },
    command: 'npm run test:client-core-scale -- --report docs/partner/client-core-scale-report.json',
  };
  const reportIndex = process.argv.indexOf('--report');
  if (reportIndex >= 0) {
    const reportPath = process.argv[reportIndex + 1];
    assert.ok(reportPath, '--report requires a path');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
