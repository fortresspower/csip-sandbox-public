import { parseDERControlResponse } from '@fortress-csip/protocol';
import { describe, expect, it } from 'vitest';
import {
  ControlPoller,
  LifecycleResponder,
  MemorySessionStore,
  ResourceClient,
  type AssignmentSnapshot,
} from '../src/index.js';
import { controlXml, MemoryTransport } from './control-helpers.js';

const HILDA = '1111111111111111111111111111111111111111';
const LAB = '2222222222222222222222222222222222222222';

describe('control lifecycle responses', () => {
  it('posts only requested outcomes to replyTo and retries a transient partner outage', async () => {
    const transport = new MemoryTransport();
    transport.getBodies.set('/random/control-feed', () => controlXml({
      mRID: 'event-7', fixedW: -900, responseRequired: '02', replyTo: '/random/response-destination',
    }));
    const snapshot: AssignmentSnapshot = {
      valid: true,
      devices: [
        { lFDI: HILDA, programs: [{ mRID: 'program', primacy: 3, controlListHref: '/random/control-feed' }] },
        { lFDI: LAB, programs: [{ mRID: 'program', primacy: 3, controlListHref: '/random/control-feed' }] },
      ],
    };
    const store = new MemorySessionStore();
    const resources = new ResourceClient({ transport, store });
    const [intent] = (await new ControlPoller({
      connectionId: 'partner-a', resources, store, now: () => 400,
    }).poll(snapshot)).intents;
    expect(await store.listPendingResponses()).toEqual([]);

    const lifecycle = new LifecycleResponder({ resources, store, now: () => 500 });
    expect(await lifecycle.recordOutcome(intent.internalEventId, 'started')).toBe(2);
    expect(await lifecycle.recordOutcome(intent.internalEventId, 'started')).toBe(0);

    transport.failNextPost = true;
    expect(await lifecycle.flushResponses()).toEqual({ sent: 1, failed: 1 });
    expect(await lifecycle.flushResponses()).toEqual({ sent: 1, failed: 0 });

    const posts = transport.requests.filter((request) => request.method === 'POST');
    expect(posts.every((request) => request.href === '/random/response-destination')).toBe(true);
    const responses = posts.map((request) => parseDERControlResponse(request.body!));
    expect(new Set(responses.map((response) => response.endDeviceLFDI))).toEqual(new Set([HILDA, LAB]));
    expect(responses.every((response) => response.subject === 'event-7' && response.status === 2)).toBe(true);
    expect(await store.listPendingResponses()).toEqual([]);
  });

  it('does not post specific outcomes when only receipt was requested', async () => {
    const transport = new MemoryTransport();
    transport.getBodies.set('/controls', () => controlXml({
      mRID: 'receipt-only', fixedW: 10, responseRequired: '01', replyTo: '/responses',
    }));
    const snapshot: AssignmentSnapshot = {
      valid: true,
      devices: [{ lFDI: HILDA, programs: [{ mRID: 'p', primacy: 1, controlListHref: '/controls' }] }],
    };
    const store = new MemorySessionStore();
    const resources = new ResourceClient({ transport, store });
    const [intent] = (await new ControlPoller({ connectionId: 'partner-a', resources, store }).poll(snapshot)).intents;
    const lifecycle = new LifecycleResponder({ resources, store });
    expect(await lifecycle.recordOutcome(intent.internalEventId, 'started')).toBe(0);
    expect((await store.listPendingResponses()).map((effect) => effect.response.status)).toEqual([1]);
  });

  it('can queue a site outcome for only the named assigned EndDevice', async () => {
    const transport = new MemoryTransport();
    transport.getBodies.set('/controls', () => controlXml({
      mRID: 'per-site', fixedW: -500, responseRequired: '02', replyTo: '/responses',
    }));
    const snapshot: AssignmentSnapshot = {
      valid: true,
      devices: [
        { lFDI: HILDA, programs: [{ mRID: 'p', primacy: 1, controlListHref: '/controls' }] },
        { lFDI: LAB, programs: [{ mRID: 'p', primacy: 1, controlListHref: '/controls' }] },
      ],
    };
    const store = new MemorySessionStore();
    const resources = new ResourceClient({ transport, store });
    const [intent] = (await new ControlPoller({ connectionId: 'partner-a', resources, store }).poll(snapshot)).intents;
    const lifecycle = new LifecycleResponder({ resources, store });

    expect(await lifecycle.recordOutcome(intent.internalEventId, 'completed', HILDA)).toBe(1);
    expect((await store.listPendingResponses()).map((effect) => effect.response.endDeviceLFDI)).toEqual([HILDA]);
    await expect(lifecycle.recordOutcome(intent.internalEventId, 'completed', '3'.repeat(40)))
      .rejects.toThrow(/not assigned/);
  });

  it('preserves an IEEE 2030.5 declined outcome as status 4', async () => {
    const transport = new MemoryTransport();
    transport.getBodies.set('/controls', () => controlXml({
      mRID: 'declined', fixedW: -500, responseRequired: '02', replyTo: '/responses',
    }));
    const snapshot: AssignmentSnapshot = {
      valid: true,
      devices: [{ lFDI: HILDA, programs: [{ mRID: 'p', primacy: 1, controlListHref: '/controls' }] }],
    };
    const store = new MemorySessionStore();
    const resources = new ResourceClient({ transport, store });
    const [intent] = (await new ControlPoller({ connectionId: 'partner-a', resources, store }).poll(snapshot)).intents;
    const lifecycle = new LifecycleResponder({ resources, store });

    expect(await lifecycle.recordOutcome(intent.internalEventId, 'declined', HILDA)).toBe(1);
    expect((await store.listPendingResponses()).map((effect) => effect.response.status)).toEqual([4]);
  });
});
