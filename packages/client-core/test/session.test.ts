import { describe, expect, it } from 'vitest';
import {
  CsipSession,
  MemorySessionStore,
  ResourceClient,
  type AssignmentSnapshot,
  type ControlIntent,
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
    transport.getBodies.set('/controls', () => controlXml({ mRID: 'event-1', fixedW: -500 }));
    const store = new MemorySessionStore();
    const resources = new ResourceClient({ transport, store });
    const attempted: string[] = [];
    let fail = true;
    const sink = {
      async dispatch(intent: ControlIntent): Promise<void> {
        attempted.push(intent.internalEventId);
        if (fail) throw new Error('device plane unavailable');
      },
      async updateLifecycle(): Promise<void> {},
    };

    const first = new CsipSession({ connectionId: 'partner-a', resources, store, sink });
    expect(await first.runOnce(snapshot)).toMatchObject({ delivered: [], failedDeliveries: 1 });
    fail = false;
    const restarted = new CsipSession({ connectionId: 'partner-a', resources, store, sink });
    const recovered = await restarted.runOnce(snapshot);
    expect(recovered.delivered).toHaveLength(1);
    expect(recovered.failedDeliveries).toBe(0);
    expect(attempted[0]).toBe(attempted[1]);

    await restarted.runOnce(snapshot);
    expect(attempted).toHaveLength(2);
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
        async dispatch(intent) { delivered.push(intent.internalEventId); },
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
      async dispatch(): Promise<void> {},
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
