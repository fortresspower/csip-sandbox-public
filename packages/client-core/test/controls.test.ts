import { describe, expect, it } from 'vitest';
import {
  ControlPoller,
  ControlRevisionError,
  MemorySessionStore,
  ResourceClient,
  type AssignmentSnapshot,
} from '../src/index.js';
import { controlXml, MemoryTransport } from './control-helpers.js';

const HILDA = '1111111111111111111111111111111111111111';
const LAB = '2222222222222222222222222222222222222222';

const snapshot: AssignmentSnapshot = {
  valid: true,
  devices: [
    {
      lFDI: HILDA,
      programs: [
        { mRID: 'alpha', primacy: 1, controlListHref: '/feeds/alpha' },
        { mRID: 'beta', primacy: 7, controlListHref: '/feeds/beta' },
      ],
    },
    {
      lFDI: LAB,
      programs: [{ mRID: 'beta', primacy: 7, controlListHref: '/feeds/beta' }],
    },
  ],
};

describe('control polling', () => {
  it('preserves route, primacy, assignments, response flags, and discovered poll rates', async () => {
    const transport = new MemoryTransport();
    transport.getBodies.set('/feeds/alpha', () => controlXml({
      mRID: 'event-alpha', fixedW: -1200, responseRequired: '03', replyTo: '/responses/alpha', pollRate: 19,
    }));
    transport.getBodies.set('/feeds/beta', () => controlXml({
      mRID: 'event-beta', fixedW: -800, responseRequired: '00', pollRate: 41,
    }));
    const store = new MemorySessionStore();
    const resources = new ResourceClient({ transport, store });
    const poller = new ControlPoller({ connectionId: 'partner-a', resources, store, now: () => 1_000 });

    const result = await poller.poll(snapshot);
    expect(result.pollRates).toEqual([
      { controlListHref: '/feeds/alpha', seconds: 19 },
      { controlListHref: '/feeds/beta', seconds: 41 },
    ]);
    expect(result.intents).toHaveLength(2);
    expect(result.intents[0]).toMatchObject({
      connectionId: 'partner-a', wireMrid: 'event-alpha', programMrid: 'alpha', programPrimacy: 1,
      assignedLFDIs: [HILDA], replyTo: '/responses/alpha', responseRequired: '03',
      interval: { start: 200, duration: 300 }, control: { opModFixedW: -1200 },
    });
    expect(result.intents[1]).toMatchObject({
      wireMrid: 'event-beta', programMrid: 'beta', programPrimacy: 7, assignedLFDIs: [HILDA, LAB],
    });
    expect(result.intents[0].internalEventId).not.toBe(result.intents[1].internalEventId);
    expect((await store.listPendingResponses()).map((effect) => effect.response.status)).toEqual([1]);

    expect((await poller.poll(snapshot)).intents).toEqual([]);
    const restarted = new ControlPoller({ connectionId: 'partner-a', resources, store, now: () => 1_001 });
    expect((await restarted.poll(snapshot)).intents).toEqual([]);
  });

  it('emits status-only lifecycle updates and rejects an in-place material revision', async () => {
    const transport = new MemoryTransport();
    let status = 0;
    let fixedW = -1200;
    transport.getBodies.set('/feeds/alpha', () => controlXml({
      mRID: 'event-alpha', fixedW, currentStatus: status, responseRequired: '03', replyTo: '/responses/alpha',
    }));
    transport.getBodies.set('/feeds/beta', () => '<DERControlList xmlns="urn:ieee:std:2030.5:ns" all="0" results="0"/>');
    const store = new MemorySessionStore();
    const poller = new ControlPoller({
      connectionId: 'partner-a',
      resources: new ResourceClient({ transport, store }),
      store,
      now: () => 1_000,
    });

    await poller.poll(snapshot);
    status = 2;
    const cancelled = await poller.poll(snapshot);
    expect(cancelled.intents).toEqual([]);
    expect(cancelled.lifecycleUpdates).toEqual([
      expect.objectContaining({ wireMrid: 'event-alpha', kind: 'cancelled', assignedLFDIs: [HILDA] }),
    ]);
    expect((await store.listPendingResponses()).map((effect) => effect.response.status).sort()).toEqual([1, 6]);

    fixedW = -1300;
    await expect(poller.poll(snapshot)).rejects.toBeInstanceOf(ControlRevisionError);
    expect(await store.loadControl(cancelled.lifecycleUpdates[0].internalEventId))
      .toMatchObject({ materialFingerprint: expect.any(String), lastStatus: 2 });
  });

  it('scopes identical wire mRIDs to their partner connection', async () => {
    const transport = new MemoryTransport();
    transport.getBodies.set('/feeds/alpha', () => controlXml({ mRID: 'shared', fixedW: 1 }));
    transport.getBodies.set('/feeds/beta', () => '<DERControlList xmlns="urn:ieee:std:2030.5:ns" all="0" results="0"/>');
    const storeA = new MemorySessionStore();
    const storeB = new MemorySessionStore();
    const [a] = (await new ControlPoller({
      connectionId: 'partner-a', resources: new ResourceClient({ transport, store: storeA }), store: storeA,
    }).poll(snapshot)).intents;
    const [b] = (await new ControlPoller({
      connectionId: 'partner-b', resources: new ResourceClient({ transport, store: storeB }), store: storeB,
    }).poll(snapshot)).intents;
    expect(a.internalEventId).not.toBe(b.internalEventId);
  });

  it('stands down an active control when its assignment is removed and never retargets the same mRID', async () => {
    const transport = new MemoryTransport();
    transport.getBodies.set('/feeds/alpha', () => controlXml({
      mRID: 'moving-control', fixedW: -1200, responseRequired: '03', replyTo: '/responses/alpha',
    }));
    transport.getBodies.set('/feeds/beta', () => '<DERControlList xmlns="urn:ieee:std:2030.5:ns" all="0" results="0"/>');
    const store = new MemorySessionStore();
    const poller = new ControlPoller({
      connectionId: 'partner-a',
      resources: new ResourceClient({ transport, store }),
      store,
      now: () => 250,
    });
    const first = await poller.poll(snapshot);
    expect(first.intents[0].assignedLFDIs).toEqual([HILDA]);

    const moved: AssignmentSnapshot = {
      valid: true,
      devices: [{
        lFDI: LAB,
        programs: [{ mRID: 'alpha', primacy: 1, controlListHref: '/feeds/alpha' }],
      }],
    };
    const removed = await poller.poll(moved);
    expect(removed.intents).toEqual([]);
    expect(removed.lifecycleUpdates).toEqual([
      expect.objectContaining({
        wireMrid: 'moving-control',
        kind: 'cancelled',
        assignedLFDIs: [HILDA],
      }),
    ]);
    expect((await store.listPendingResponses()).map((effect) => effect.response.status).sort()).toEqual([1, 6]);
  });

  it('rejects reserved response flags and invalid event status before dispatch', async () => {
    const transport = new MemoryTransport();
    transport.getBodies.set('/feeds/alpha', () => controlXml({
      mRID: 'bad-flags', fixedW: 1, responseRequired: '80', replyTo: '/responses',
    }));
    transport.getBodies.set('/feeds/beta', () => '<DERControlList xmlns="urn:ieee:std:2030.5:ns" all="0" results="0"/>');
    const store = new MemorySessionStore();
    const poller = new ControlPoller({
      connectionId: 'partner-a', resources: new ResourceClient({ transport, store }), store,
    });
    await expect(poller.poll(snapshot)).rejects.toThrow(/reserved responseRequired/i);

    transport.getBodies.set('/feeds/alpha', () => controlXml({ mRID: 'bad-status', fixedW: 1, currentStatus: 9 }));
    await expect(poller.poll(snapshot)).rejects.toThrow(/currentStatus/i);
    expect(await store.listPendingControls()).toEqual([]);
  });
});
