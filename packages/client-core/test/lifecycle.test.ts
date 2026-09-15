import { parseDERControlResponse } from '@fortress-csip/protocol';
import { describe, expect, it } from 'vitest';
import {
  ControlPoller,
  LifecycleResponder,
  MemorySessionStore,
  queueControlResponse,
  ResourceClient,
  type AssignmentSnapshot,
  type ControlIntent,
  type StoredResponseEffect,
} from '../src/index.js';
import { controlXml, MemoryTransport } from './control-helpers.js';

const DEVICE_ALPHA = '1111111111111111111111111111111111111111';
const DEVICE_BETA = '2222222222222222222222222222222222222222';

describe('control lifecycle responses', () => {
  it('uses one batch read and write for a fleet response', async () => {
    const lFDIs = Array.from({ length: 10_000 }, (_, index) => index.toString(16).padStart(40, '0'));
    class BatchStore extends MemorySessionStore {
      reads = 0;
      writes = 0;
      override async loadResponseEffect(): Promise<StoredResponseEffect | undefined> {
        throw new Error('fleet response used the per-device read path');
      }
      override async saveResponseEffect(): Promise<void> {
        throw new Error('fleet response used the per-device write path');
      }
      override async loadResponseEffects(ids: readonly string[]) {
        this.reads += 1;
        return ids.map(() => undefined);
      }
      override async saveResponseEffects(effects: readonly StoredResponseEffect[]) {
        this.writes += 1;
        return super.saveResponseEffects(effects);
      }
    }
    const store = new BatchStore();
    const intent: ControlIntent = {
      family: 'csip', connectionId: 'connection-a', internalEventId: 'internal-a',
      wireMrid: 'wire-a', programMrid: 'program-a', programPrimacy: 1,
      assignedLFDIs: lFDIs, responseRequired: '02', replyTo: '/responses',
      creationTime: 1, eventStatus: 0, interval: { start: 1, duration: 60 },
      control: { opModFixedW: -500 },
    };

    expect(await queueControlResponse(store, intent, 252, 2)).toBe(lFDIs.length);
    expect({ reads: store.reads, writes: store.writes }).toEqual({ reads: 1, writes: 1 });
    expect(await store.listPendingResponses()).toHaveLength(lFDIs.length);
  });

  it('posts only requested outcomes to replyTo and retries a transient partner outage', async () => {
    const transport = new MemoryTransport();
    transport.getBodies.set('/random/control-feed', () => controlXml({
      mRID: 'event-7', fixedW: -900, responseRequired: '02', replyTo: '/random/response-destination',
    }));
    const snapshot: AssignmentSnapshot = {
      valid: true,
      devices: [
        { lFDI: DEVICE_ALPHA, programs: [{ mRID: 'program', primacy: 3, controlListHref: '/random/control-feed' }] },
        { lFDI: DEVICE_BETA, programs: [{ mRID: 'program', primacy: 3, controlListHref: '/random/control-feed' }] },
      ],
    };
    const store = new MemorySessionStore();
    const resources = new ResourceClient({ transport, store });
    const [intent] = (await new ControlPoller({
      connectionId: 'partner-a', resources, store, now: () => 400,
    }).poll(snapshot)).intents;
    expect(await store.listPendingResponses()).toEqual([]);
    const control = await store.loadControl(intent.internalEventId);
    expect(control).toBeDefined();
    await store.saveControl({ ...control!, admissionState: 'accepted' });

    const lifecycle = new LifecycleResponder({ resources, store, now: () => 500 });
    expect(await lifecycle.recordOutcome(intent.internalEventId, 'started')).toBe(2);
    expect(await lifecycle.recordOutcome(intent.internalEventId, 'started')).toBe(0);

    transport.failNextPost = true;
    expect(await lifecycle.flushResponses()).toEqual({ sent: 1, failed: 1 });
    expect(await lifecycle.flushResponses()).toEqual({ sent: 1, failed: 0 });

    const posts = transport.requests.filter((request) => request.method === 'POST');
    expect(posts.every((request) => request.href === '/random/response-destination')).toBe(true);
    const responses = posts.map((request) => parseDERControlResponse(request.body!));
    expect(new Set(responses.map((response) => response.endDeviceLFDI))).toEqual(new Set([DEVICE_ALPHA, DEVICE_BETA]));
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
      devices: [{ lFDI: DEVICE_ALPHA, programs: [{ mRID: 'p', primacy: 1, controlListHref: '/controls' }] }],
    };
    class CountingStore extends MemorySessionStore {
      responseWrites = 0;
      override async saveResponseEffects(effects: readonly StoredResponseEffect[]) {
        this.responseWrites += 1;
        await super.saveResponseEffects(effects);
      }
    }
    const store = new CountingStore();
    const resources = new ResourceClient({ transport, store });
    const [intent] = (await new ControlPoller({ connectionId: 'partner-a', resources, store }).poll(snapshot)).intents;
    const lifecycle = new LifecycleResponder({ resources, store });
    expect(await lifecycle.recordOutcome(intent.internalEventId, 'started')).toBe(0);
    expect(store.responseWrites, 'an empty response set must not write durable state').toBe(0);
    expect(await store.listPendingResponses()).toEqual([]);
  });

  it('can queue a site outcome for only the named assigned EndDevice', async () => {
    const transport = new MemoryTransport();
    transport.getBodies.set('/controls', () => controlXml({
      mRID: 'per-site', fixedW: -500, responseRequired: '02', replyTo: '/responses',
    }));
    const snapshot: AssignmentSnapshot = {
      valid: true,
      devices: [
        { lFDI: DEVICE_ALPHA, programs: [{ mRID: 'p', primacy: 1, controlListHref: '/controls' }] },
        { lFDI: DEVICE_BETA, programs: [{ mRID: 'p', primacy: 1, controlListHref: '/controls' }] },
      ],
    };
    const store = new MemorySessionStore();
    const resources = new ResourceClient({ transport, store });
    const [intent] = (await new ControlPoller({ connectionId: 'partner-a', resources, store }).poll(snapshot)).intents;
    const lifecycle = new LifecycleResponder({ resources, store });

    expect(await lifecycle.recordOutcome(intent.internalEventId, 'completed', DEVICE_ALPHA)).toBe(1);
    expect((await store.listPendingResponses()).map((effect) => effect.response.endDeviceLFDI)).toEqual([DEVICE_ALPHA]);
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
      devices: [{ lFDI: DEVICE_ALPHA, programs: [{ mRID: 'p', primacy: 1, controlListHref: '/controls' }] }],
    };
    const store = new MemorySessionStore();
    const resources = new ResourceClient({ transport, store });
    const [intent] = (await new ControlPoller({ connectionId: 'partner-a', resources, store }).poll(snapshot)).intents;
    const lifecycle = new LifecycleResponder({ resources, store });

    expect(await lifecycle.recordOutcome(intent.internalEventId, 'declined', DEVICE_ALPHA)).toBe(1);
    expect((await store.listPendingResponses()).map((effect) => effect.response.status)).toEqual([4]);
  });
});
