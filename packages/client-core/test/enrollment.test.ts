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

describe('in-band EndDevice enrollment', () => {
  const fixtures: RunningFixture[] = [];
  afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.close())));

  it('coalesces concurrent reconciliation, persists Location, and later matches the list', async () => {
    let fixture!: RunningFixture;
    let registered = false;
    let postCount = 0;
    let deleteCount = 0;
    fixture = await startFixture(async (request: IncomingMessage, response: ServerResponse) => {
      if (request.url === `${fixture.prefix}/capability`) {
        response.end(xml('DeviceCapability', link('EndDeviceListLink', `${fixture.prefix}/devices`), ' pollRate="30"'));
        return;
      }
      if (request.url === `${fixture.prefix}/devices` && request.method === 'GET') {
        const item = registered ? `<EndDevice href="${fixture.prefix}/devices/generated"><lFDI>${LFDI}</lFDI></EndDevice>` : '';
        response.end(xml('EndDeviceList', item, ` all="${registered ? 1 : 0}" results="${registered ? 1 : 0}"`));
        return;
      }
      if (request.url === `${fixture.prefix}/devices` && request.method === 'POST') {
        postCount += 1;
        expect(parseEndDevice(await readBody(request))).toEqual({ lFDI: LFDI });
        registered = true;
        response.writeHead(201, { location: `${fixture.prefix}/devices/generated` }).end();
        return;
      }
      if (request.url === `${fixture.prefix}/devices/generated` && request.method === 'DELETE') {
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
      if (request.url === `${fixture.prefix}/capability`) {
        response.end(xml('DeviceCapability', link('EndDeviceListLink', `${fixture.prefix}/devices`), ' pollRate="30"'));
        return;
      }
      if (request.url === `${fixture.prefix}/devices` && request.method === 'GET') {
        const item = registered ? `<EndDevice href="${fixture.prefix}/devices/winner"><lFDI>${LFDI}</lFDI></EndDevice>` : '';
        response.end(xml('EndDeviceList', item, ` all="${registered ? 1 : 0}" results="${registered ? 1 : 0}"`));
        return;
      }
      if (request.url === `${fixture.prefix}/devices` && request.method === 'POST') {
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
});
