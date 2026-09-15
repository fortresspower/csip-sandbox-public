import { describe, expect, it } from 'vitest';
import {
  CsipSession,
  MemorySessionStore,
  ResourceClient,
  type AssignmentSnapshot,
  type ControlIntent,
  type StoredControl,
  type StoredLifecycleEffect,
  type StoredResponseEffect,
} from '../src/index.js';
import { controlXml, MemoryTransport } from './control-helpers.js';

const DEVICE_ALPHA = '1111111111111111111111111111111111111111';
const snapshot: AssignmentSnapshot = {
  valid: true,
  devices: [{ lFDI: DEVICE_ALPHA, programs: [{ mRID: 'p', primacy: 1, controlListHref: '/controls' }] }],
};

describe('CSIP session recovery', () => {
  it('retries one durable intent with the same identity after a sink failure and does not redeliver after ack', async () => {
    const transport = new MemoryTransport();
    transport.getBodies.set('/controls', () => controlXml({
      mRID: 'event-1', fixedW: -500, responseRequired: '03', replyTo: '/responses',
    }));
    const store = new MemorySessionStore();
    const resources = new ResourceClient({ transport, store });
    const attempted: string[] = [];
    let fail = true;
    const sink = {
      async dispatch(intent: ControlIntent) {
        attempted.push(intent.internalEventId);
        expect(await store.listPendingResponses(), 'polling must not acknowledge before admission').toEqual([]);
        if (fail) throw new Error('device plane unavailable');
        return { status: 'accepted' as const };
      },
      async updateLifecycle(): Promise<void> {},
    };

    const first = new CsipSession({ connectionId: 'partner-a', resources, store, sink });
    expect(await first.runOnce(snapshot)).toMatchObject({
      delivered: [], failedDeliveries: 1, responses: { sent: 0, failed: 0 },
    });
    expect(transport.requests.filter((request) => request.method === 'POST')).toEqual([]);
    fail = false;
    const restarted = new CsipSession({ connectionId: 'partner-a', resources, store, sink });
    const recovered = await restarted.runOnce(snapshot);
    expect(recovered.delivered).toHaveLength(1);
    expect(recovered.failedDeliveries).toBe(0);
    expect(recovered.responses).toEqual({ sent: 1, failed: 0 });
    expect(attempted[0]).toBe(attempted[1]);

    const admissionResponses = transport.requests.filter((request) => request.method === 'POST');
    expect(admissionResponses).toHaveLength(1);

    await restarted.runOnce(snapshot);
    expect(attempted).toHaveLength(2);
    expect(transport.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('retries the accepted admission boundary atomically after a store failure without losing or duplicating status 1', async () => {
    class FailOnceAdmissionStore extends MemorySessionStore {
      attempts = 0;

      override async completeControlAdmission(
        control: StoredControl,
        effects: readonly StoredResponseEffect[],
      ): Promise<void> {
        this.attempts += 1;
        if (this.attempts === 1) throw new Error('crash before atomic admission commit');
        await super.completeControlAdmission(control, effects);
      }
    }

    const transport = new MemoryTransport();
    transport.getBodies.set('/controls', () => controlXml({
      mRID: 'event-atomic', fixedW: -500, responseRequired: '03', replyTo: '/responses',
    }));
    const store = new FailOnceAdmissionStore();
    const dispatched: string[] = [];
    const session = new CsipSession({
      connectionId: 'partner-a',
      resources: new ResourceClient({ transport, store }),
      store,
      sink: {
        async dispatch(intent) {
          dispatched.push(intent.internalEventId);
          return { status: 'accepted' as const };
        },
        async updateLifecycle() {},
      },
    });

    expect(await session.runOnce(snapshot)).toMatchObject({
      delivered: [], failedDeliveries: 1, responses: { sent: 0, failed: 0 },
    });
    expect(await store.listPendingResponses()).toEqual([]);
    expect((await store.listPendingControls())).toHaveLength(1);

    expect(await session.runOnce(snapshot)).toMatchObject({
      delivered: [expect.objectContaining({ wireMrid: 'event-atomic' })],
      failedDeliveries: 0,
      responses: { sent: 1, failed: 0 },
    });
    expect(dispatched).toHaveLength(2);
    expect(store.attempts).toBe(2);
    expect(transport.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it.each([
    ['partner cancellation', () => snapshot] as const,
    ['assignment removal', () => ({ valid: true, devices: [] })] as const,
  ])('reconciles uncertain acceptance before %s settles the control', async (label, nextSnapshot) => {
    class FailOnceAdmissionStore extends MemorySessionStore {
      attempts = 0;

      override async completeControlAdmission(
        control: StoredControl,
        effects: readonly StoredResponseEffect[],
        lifecycleEffects: readonly StoredLifecycleEffect[] = [],
      ): Promise<void> {
        this.attempts += 1;
        if (this.attempts === 1) throw new Error('crash after downstream acceptance');
        await super.completeControlAdmission(control, effects, lifecycleEffects);
      }
    }

    let status = 0;
    const transport = new MemoryTransport();
    transport.getBodies.set('/controls', () => controlXml({
      mRID: `event-${label}`,
      fixedW: -500,
      currentStatus: status,
      responseRequired: '03',
      replyTo: '/responses',
    }));
    const store = new FailOnceAdmissionStore();
    const sinkCalls: string[] = [];
    const actuated = new Set<string>();
    const lifecycle: string[] = [];
    const session = new CsipSession({
      connectionId: 'partner-a',
      resources: new ResourceClient({ transport, store }),
      store,
      now: () => 250,
      sink: {
        async dispatch(intent) {
          sinkCalls.push(intent.internalEventId);
          actuated.add(intent.internalEventId);
          return { status: 'accepted' as const };
        },
        async updateLifecycle(update) { lifecycle.push(update.kind); },
      },
    });

    expect(await session.runOnce(snapshot)).toMatchObject({
      delivered: [], failedDeliveries: 1, responses: { sent: 0, failed: 0 },
    });
    expect((await store.listPendingControls())[0]).toMatchObject({ admissionState: 'uncertain' });

    status = 2;
    const recovered = await session.runOnce(nextSnapshot());
    expect(recovered).toMatchObject({
      delivered: [expect.objectContaining({ wireMrid: `event-${label}` })],
      failedDeliveries: 0,
      lifecycleUpdates: [expect.objectContaining({ kind: 'cancelled' })],
      responses: { sent: 2, failed: 0 },
    });
    expect(sinkCalls).toHaveLength(2);
    expect(actuated.size, 'the stable internalEventId makes sink reconciliation idempotent').toBe(1);
    expect(lifecycle).toEqual(['cancelled']);
    expect(transport.requests.filter((request) => request.method === 'POST').map((request) =>
      Number(request.body.match(/<status>(\d+)<\/status>/)?.[1])),
    ).toEqual([1, 6]);
  });

  it('preserves cancellation across a failed reconciliation and later reassignment', async () => {
    class FailOnceAdmissionStore extends MemorySessionStore {
      attempts = 0;

      override async completeControlAdmission(
        control: StoredControl,
        effects: readonly StoredResponseEffect[],
        lifecycleEffects: readonly StoredLifecycleEffect[] = [],
      ): Promise<void> {
        this.attempts += 1;
        if (this.attempts === 1) throw new Error('crash after downstream acceptance');
        await super.completeControlAdmission(control, effects, lifecycleEffects);
      }
    }

    const transport = new MemoryTransport();
    transport.getBodies.set('/controls', () => controlXml({
      mRID: 'event-reassigned',
      fixedW: -500,
      currentStatus: 0,
      responseRequired: '03',
      replyTo: '/responses',
    }));
    const store = new FailOnceAdmissionStore();
    const sinkCalls: string[] = [];
    const actuated = new Set<string>();
    const lifecycle: string[] = [];
    let reconciliationUnavailable = false;
    const session = new CsipSession({
      connectionId: 'partner-a',
      resources: new ResourceClient({ transport, store }),
      store,
      now: () => 250,
      sink: {
        async dispatch(intent) {
          sinkCalls.push(intent.internalEventId);
          if (reconciliationUnavailable) throw new Error('admission lookup unavailable');
          actuated.add(intent.internalEventId);
          return { status: 'accepted' as const };
        },
        async updateLifecycle(update) { lifecycle.push(update.kind); },
      },
    });

    expect(await session.runOnce(snapshot)).toMatchObject({ failedDeliveries: 1 });
    reconciliationUnavailable = true;
    expect(await session.runOnce({ valid: true, devices: [] })).toMatchObject({
      failedDeliveries: 1,
      responses: { sent: 0, failed: 0 },
    });
    expect((await store.listPendingControls())[0]).toMatchObject({
      admissionState: 'uncertain',
      lastStatus: 2,
    });

    reconciliationUnavailable = false;
    expect(await session.runOnce(snapshot)).toMatchObject({
      delivered: [expect.objectContaining({ wireMrid: 'event-reassigned' })],
      failedDeliveries: 0,
      lifecycleUpdates: [expect.objectContaining({ kind: 'cancelled' })],
      responses: { sent: 2, failed: 0 },
    });
    expect(sinkCalls).toHaveLength(3);
    expect(actuated.size).toBe(1);
    expect(lifecycle).toEqual(['cancelled']);
    expect(transport.requests.filter((request) => request.method === 'POST').map((request) =>
      Number(request.body.match(/<status>(\d+)<\/status>/)?.[1])),
    ).toEqual([1, 6]);
  });

  it('does not queue a contradictory status 1 after a sink durably rejects admission', async () => {
    const transport = new MemoryTransport();
    transport.getBodies.set('/controls', () => controlXml({
      mRID: 'event-rejected', fixedW: -500, responseRequired: '03', replyTo: '/responses',
    }));
    const store = new MemorySessionStore();
    let dispatches = 0;
    const session = new CsipSession({
      connectionId: 'partner-a',
      resources: new ResourceClient({ transport, store }),
      store,
      sink: {
        async dispatch() {
          dispatches += 1;
          return { status: 'terminal-rejected' as const };
        },
        async updateLifecycle() {},
      },
    });

    expect(await session.runOnce(snapshot)).toMatchObject({
      delivered: [], failedDeliveries: 0, responses: { sent: 1, failed: 0 },
    });
    expect(await session.runOnce(snapshot)).toMatchObject({
      delivered: [], failedDeliveries: 0, responses: { sent: 0, failed: 0 },
    });
    expect(dispatches).toBe(1);
    const posts = transport.requests.filter((request) => request.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain('<status>252</status>');
    expect(posts[0].body).not.toContain('<status>1</status>');
  });

  it('recovers polling after a transient server outage without creating a second intent', async () => {
    const transport = new MemoryTransport();
    transport.getBodies.set('/controls', () => controlXml({ mRID: 'event-2', fixedW: -600 }));
    transport.failNextGet = true;
    const store = new MemorySessionStore();
    const delivered: string[] = [];
    const session = new CsipSession({
      connectionId: 'partner-a',
      resources: new ResourceClient({ transport, store }),
      store,
      sink: {
        async dispatch(intent) {
          delivered.push(intent.internalEventId);
          return { status: 'accepted' as const };
        },
        async updateLifecycle() {},
      },
    });

    await expect(session.runOnce(snapshot)).rejects.toBeDefined();
    await session.runOnce(snapshot);
    await session.runOnce(snapshot);
    expect(delivered).toHaveLength(1);
  });

  it('retries a durable cancellation update after restart', async () => {
    const transport = new MemoryTransport();
    let status = 0;
    transport.getBodies.set('/controls', () => controlXml({ mRID: 'event-3', fixedW: -700, currentStatus: status }));
    const store = new MemorySessionStore();
    const resources = new ResourceClient({ transport, store });
    const lifecycleAttempts: string[] = [];
    let failLifecycle = true;
    const sink = {
      async dispatch() { return { status: 'accepted' as const }; },
      async updateLifecycle(update: { internalEventId: string }): Promise<void> {
        lifecycleAttempts.push(update.internalEventId);
        if (failLifecycle) throw new Error('state machine unavailable');
      },
    };
    const session = new CsipSession({ connectionId: 'partner-a', resources, store, sink });
    await session.runOnce(snapshot);
    status = 2;
    expect(await session.runOnce(snapshot)).toMatchObject({ failedLifecycleUpdates: 1 });

    failLifecycle = false;
    const restarted = new CsipSession({ connectionId: 'partner-a', resources, store, sink });
    expect(await restarted.runOnce(snapshot)).toMatchObject({
      failedLifecycleUpdates: 0,
      lifecycleUpdates: [expect.objectContaining({ kind: 'cancelled' })],
    });
    await restarted.runOnce(snapshot);
    expect(lifecycleAttempts).toHaveLength(2);
    expect(lifecycleAttempts[0]).toBe(lifecycleAttempts[1]);
  });
});
