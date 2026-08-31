import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EndDeviceEnrollment,
  MemorySessionStore,
  ResourceClient,
} from '../src/index.js';
import { parseEndDevice } from '@fortress-csip/protocol';
import { link, readBody, startFixture, xml, type RunningFixture } from './fixture-server.js';

const LFDI = 'abcdef0123456789abcdef0123456789abcdef01';
const pathOf = (request: IncomingMessage): string => new URL(request.url ?? '/', 'http://fixture').pathname;

describe('in-band EndDevice enrollment', () => {
  const fixtures: RunningFixture[] = [];
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.close())));

  it('coalesces concurrent reconciliation, persists Location, and later matches the list', async () => {
    let fixture!: RunningFixture;
    let registered = false;
    let postCount = 0;
    let deleteCount = 0;
    fixture = await startFixture(async (request: IncomingMessage, response: ServerResponse) => {
      if (pathOf(request) === `${fixture.prefix}/capability`) {
        response.end(xml('DeviceCapability', link('EndDeviceListLink', `${fixture.prefix}/devices`), ' pollRate="30"'));
        return;
      }
      if (pathOf(request) === `${fixture.prefix}/devices` && request.method === 'GET') {
        const item = registered ? `<EndDevice href="${fixture.prefix}/devices/generated"><lFDI>${LFDI}</lFDI></EndDevice>` : '';
        response.end(xml('EndDeviceList', item, ` all="${registered ? 1 : 0}" results="${registered ? 1 : 0}"`));
        return;
      }
      if (pathOf(request) === `${fixture.prefix}/devices` && request.method === 'POST') {
        postCount += 1;
        expect(parseEndDevice(await readBody(request))).toEqual({ lFDI: LFDI });
        registered = true;
        response.writeHead(201, { location: `${fixture.prefix}/devices/generated` }).end();
        return;
      }
      if (pathOf(request) === `${fixture.prefix}/devices/generated` && request.method === 'DELETE') {
        deleteCount += 1;
        registered = false;
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    });
    fixtures.push(fixture);
    const store = new MemorySessionStore();
    const enrollment = new EndDeviceEnrollment({
      resources: new ResourceClient({ transport: fixture.transport, store }),
      store,
    });

    const [first, concurrent] = await Promise.all([
      enrollment.reconcile(`${fixture.prefix}/capability`, LFDI),
      enrollment.reconcile(`${fixture.prefix}/capability`, LFDI),
    ]);
    expect(first).toEqual(concurrent);
    expect(first).toMatchObject({ lFDI: LFDI, href: `${fixture.prefix}/devices/generated`, eligible: true });
    expect(postCount).toBe(1);
    expect(await store.loadEndDevice(LFDI)).toEqual(first);

    expect(await enrollment.reconcile(`${fixture.prefix}/capability`, LFDI)).toEqual(first);
    expect(postCount).toBe(1);

    await enrollment.remove(LFDI);
    expect(deleteCount).toBe(1);
    expect(await store.loadEndDevice(LFDI)).toBeUndefined();
  });

  it('recovers from a stale saved href and a concurrent server conflict', async () => {
    let fixture!: RunningFixture;
    let registered = false;
    let postCount = 0;
    fixture = await startFixture(async (request, response) => {
      if (pathOf(request) === `${fixture.prefix}/capability`) {
        response.end(xml('DeviceCapability', link('EndDeviceListLink', `${fixture.prefix}/devices`), ' pollRate="30"'));
        return;
      }
      if (pathOf(request) === `${fixture.prefix}/devices` && request.method === 'GET') {
        const item = registered ? `<EndDevice href="${fixture.prefix}/devices/winner"><lFDI>${LFDI}</lFDI></EndDevice>` : '';
        response.end(xml('EndDeviceList', item, ` all="${registered ? 1 : 0}" results="${registered ? 1 : 0}"`));
        return;
      }
      if (pathOf(request) === `${fixture.prefix}/devices` && request.method === 'POST') {
        postCount += 1;
        registered = true;
        response.writeHead(409).end();
        return;
      }
      response.writeHead(404).end();
    });
    fixtures.push(fixture);
    const store = new MemorySessionStore();
    await store.saveEndDevice({ lFDI: LFDI, href: `${fixture.prefix}/devices/stale`, eligible: true });
    const enrollment = new EndDeviceEnrollment({
      resources: new ResourceClient({ transport: fixture.transport, store }),
      store,
    });

    await expect(enrollment.reconcile(`${fixture.prefix}/capability`, LFDI))
      .resolves.toMatchObject({ href: `${fixture.prefix}/devices/winner`, eligible: true });
    expect(postCount).toBe(1);
  });

  it('refreshes a changed fleet snapshot, reuses an unchanged one, and rejects invalid bindings', async () => {
    const lFDIs = Array.from({ length: 12 }, (_, index) => index.toString(16).padStart(40, '0'));
    const registered = new Set<string>();
    let fixture!: RunningFixture;
    let listReads = 0;
    let requestedStart: string | null = null;
    let requestedLimit: string | null = null;
    let activePosts = 0;
    let maxActivePosts = 0;
    fixture = await startFixture(async (request, response) => {
      if (pathOf(request) === `${fixture.prefix}/capability`) {
        response.end(xml('DeviceCapability', link('EndDeviceListLink', `${fixture.prefix}/devices?s=0`), ' pollRate="30"'));
        return;
      }
      if (pathOf(request) === `${fixture.prefix}/devices` && request.method === 'GET') {
        listReads += 1;
        const target = new URL(request.url ?? '/', 'http://fixture');
        requestedStart = target.searchParams.get('s');
        requestedLimit = target.searchParams.get('l');
        const items = [...registered]
          .map((lFDI) => `<EndDevice href="${fixture.prefix}/devices/${lFDI}"><lFDI>${lFDI}</lFDI></EndDevice>`)
          .join('');
        response.end(xml('EndDeviceList', items, ` all="${registered.size}" results="${registered.size}"`));
        return;
      }
      if (pathOf(request) === `${fixture.prefix}/devices` && request.method === 'POST') {
        activePosts += 1;
        maxActivePosts = Math.max(maxActivePosts, activePosts);
        const { lFDI } = parseEndDevice(await readBody(request));
        await new Promise((resolve) => setTimeout(resolve, 3));
        registered.add(lFDI);
        activePosts -= 1;
        response.writeHead(201, { location: `${fixture.prefix}/devices/${lFDI}` }).end();
        return;
      }
      response.writeHead(404).end();
    });
    fixtures.push(fixture);
    const store = new MemorySessionStore();
    const resources = new ResourceClient({ transport: fixture.transport, store });
    const enrollment = new EndDeviceEnrollment({
      resources,
      store,
      concurrency: 3,
    });

    const emptySnapshot = await resources.endDeviceFleet(`${fixture.prefix}/capability`);
    const changed = await enrollment.reconcileFleet(`${fixture.prefix}/capability`, lFDIs, { snapshot: emptySnapshot });
    expect(changed.devices).toHaveLength(lFDIs.length);
    expect(changed.inventoryChanged).toBe(true);
    expect(changed.snapshot).not.toBe(emptySnapshot);
    expect(changed.snapshot.endDevices).toHaveLength(lFDIs.length);
    expect(listReads).toBe(2);
    expect(requestedStart).toBe('0');
    expect(requestedLimit).toBe('500');
    expect(maxActivePosts).toBeGreaterThan(1);
    expect(maxActivePosts).toBeLessThanOrEqual(3);
    expect(registered.size).toBe(lFDIs.length);

    const unchanged = await enrollment.reconcileFleet(`${fixture.prefix}/capability`, lFDIs, { snapshot: changed.snapshot });
    expect(unchanged.inventoryChanged).toBe(false);
    expect(unchanged.snapshot).toBe(changed.snapshot);
    expect(listReads).toBe(2);

    await expect(enrollment.reconcileFleet(`${fixture.prefix}/other-capability`, lFDIs, { snapshot: changed.snapshot }))
      .rejects.toThrow(/different DeviceCapability/i);
    const otherStore = new MemorySessionStore();
    const otherEnrollment = new EndDeviceEnrollment({
      resources: new ResourceClient({ transport: fixture.transport, store: otherStore }),
      store: otherStore,
    });
    await expect(otherEnrollment.reconcileFleet(`${fixture.prefix}/capability`, lFDIs, { snapshot: changed.snapshot }))
      .rejects.toThrow(/different ResourceClient/i);
  });
});
