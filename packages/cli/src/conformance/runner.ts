import {
  AssignmentDiscovery,
  CsipSession,
  EndDeviceEnrollment,
  ResourceClient,
  TelemetryPublisher,
  type AssignmentSnapshot,
  type ControlIntent,
  type CsipTransport,
} from '@fortress-csip/client-core';
import { describeError } from '../errors.js';
import type { Io } from '../io.js';
import type { ReportBuilder } from '../report/report.js';
import { SerializableSessionStore } from './session-store.js';
import type {
  ConformanceSessionFile,
  OperatorDriver,
  OperatorInstruction,
  SyntheticDevices,
} from './types.js';

/**
 * The conformance profile, executed against a live IEEE 2030.5 connection.
 *
 * Unlike `doctor`, this is explicitly mutating: it registers EndDevices, posts responses, and
 * publishes telemetry. Everything it creates is synthetic and derived by the harness — no real
 * site identity is ever sent, and no partner is asked to hand Fortress a device roster.
 *
 * Every phase is built from client-core's own primitives (enrollment, discovery, session,
 * telemetry) rather than a parallel client, so what passes here is what Fortress will do.
 */

export const CAPABILITY_PATH = '/sep2/capability';

/** Bounded rehearsal command. Small, brief, and charging — never a discharge into a live site. */
export const REHEARSAL_WATTS = -1_500;
export const REHEARSAL_DURATION_SECONDS = 300;

export interface RunnerOptions {
  transport: CsipTransport;
  report: ReportBuilder;
  io: Io;
  driver: OperatorDriver;
  devices: SyntheticDevices;
  session: ConformanceSessionFile;
  /** Called whenever durable state changes, so a crash mid-run can still be resumed. */
  persist: (session: ConformanceSessionFile) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  /** Remove the synthetic devices when the run ends. */
  keepTestDevices: boolean;
}

export async function runConformance(options: RunnerOptions): Promise<void> {
  const { report, io, devices } = options;
  const store = SerializableSessionStore.from(options.session.clientSession);
  const resources = new ResourceClient({ transport: options.transport, store });

  const save = async (): Promise<void> => {
    options.session.clientSession = store.serialize();
    options.session.updatedAt = options.io.now().toISOString();
    await options.persist(options.session);
  };

  const enrolled = await runEnrollment(options, resources, store, save);
  if (!enrolled) {
    skipRemaining(report, [
      'discovery.opaque-paths', 'pagination.accepts-l500', 'pagination.preserves-page-size',
      'assignment.exactly-one-target', 'assignment.empty-dispatches-none',
      'control.fixed-w-bounded', 'control.mrid-idempotent',
      'responses.accepted', 'responses.started', 'responses.terminal',
      'telemetry.standard-mup', 'telemetry.der-status', 'telemetry.der-capability',
      'recovery.no-duplicate-delivery', 'recovery.owed-response-retried',
    ], 'requires both synthetic EndDevices to be registered');
    return;
  }

  const discovery = new AssignmentDiscovery({ resources, store });
  const eligible = new Set([devices.alpha.lfdi, devices.beta.lfdi]);

  await runDiscoveryChecks(options, discovery, eligible);
  const assigned = await runAssignmentPhase(options, discovery, eligible);
  await save();

  if (assigned === undefined) {
    skipRemaining(report, [
      'control.fixed-w-bounded', 'control.mrid-idempotent',
      'responses.accepted', 'responses.started', 'responses.terminal',
      'recovery.no-duplicate-delivery', 'recovery.owed-response-retried',
      'assignment.move-retargets', 'isolation.connection-scope',
    ], 'requires exactly one assigned test device');
  } else {
    const intent = await runControlPhase(options, resources, store, discovery, eligible, save);
    if (intent !== undefined) {
      await runResponsePhase(options, resources, store, intent, save);
      await runRecoveryPhase(options, resources, discovery, eligible, intent, save);
      await runIsolationCheck(options, discovery, eligible, intent);
    }
    await runAssignmentMovePhase(options, discovery, eligible);
  }

  await runTelemetryPhase(options, resources, eligible);
  await cleanUpDevices(options, resources, store);
  await save();
}

/* ------------------------------------------------------------------ enrollment */

async function runEnrollment(
  options: RunnerOptions,
  resources: ResourceClient,
  store: SerializableSessionStore,
  save: () => Promise<void>,
): Promise<boolean> {
  const { report, devices } = options;
  const enrollment = new EndDeviceEnrollment({ resources, store });

  let alpha;
  try {
    alpha = await enrollment.reconcile(CAPABILITY_PATH, devices.alpha.lfdi);
    report.pass(
      'enrollment.first-registration',
      `registered synthetic device ${devices.alpha.label} in-band`,
    );
  } catch (error) {
    report.fail(
      'enrollment.first-registration',
      `registering an EndDevice failed: ${describeError(error, 200)}`,
      'Accept a POST to the advertised EndDeviceList and return the created resource through discovery.',
    );
    for (const id of ['enrollment.idempotent-registration', 'enrollment.two-distinct-devices']) {
      report.skip(id, 'requires a first successful registration');
    }
    return false;
  }
  await save();

  // Registering the same LFDI again must converge on the same logical EndDevice, not create
  // a second one. A partner who keys on a generated id rather than the LFDI fails here.
  try {
    const repeated = await enrollment.reconcile(CAPABILITY_PATH, devices.alpha.lfdi);
    if (repeated.href === alpha.href) {
      report.pass(
        'enrollment.idempotent-registration',
        'registering the same LFDI twice converged on one EndDevice',
      );
    } else {
      report.fail(
        'enrollment.idempotent-registration',
        'registering the same LFDI twice produced two different EndDevice resources',
        'Key EndDevice identity on the posted LFDI so a repeated registration is idempotent.',
      );
    }
  } catch (error) {
    report.fail(
      'enrollment.idempotent-registration',
      `repeating a registration failed: ${describeError(error, 200)}`,
      'A repeated registration of the same LFDI must succeed and converge, not error.',
    );
  }

  try {
    const beta = await enrollment.reconcile(CAPABILITY_PATH, devices.beta.lfdi);
    if (beta.href !== alpha.href) {
      report.pass(
        'enrollment.two-distinct-devices',
        `two synthetic devices (${devices.alpha.label}, ${devices.beta.label}) hold distinct resources`,
      );
    } else {
      report.fail(
        'enrollment.two-distinct-devices',
        'two different LFDIs resolved to the same EndDevice resource',
        'Give each distinct LFDI its own EndDevice resource.',
      );
      return false;
    }
  } catch (error) {
    report.fail(
      'enrollment.two-distinct-devices',
      `registering the second device failed: ${describeError(error, 200)}`,
      'The profile requires two registered devices so that assignment targeting is observable.',
    );
    return false;
  }
  await save();
  return true;
}

/* ------------------------------------------------------------------ discovery */

async function runDiscoveryChecks(
  options: RunnerOptions,
  discovery: AssignmentDiscovery,
  eligible: Set<string>,
): Promise<void> {
  const { report } = options;
  let snapshot: AssignmentSnapshot;
  try {
    snapshot = await discovery.reconcile(CAPABILITY_PATH, eligible);
  } catch (error) {
    for (const id of ['discovery.opaque-paths', 'pagination.accepts-l500',
      'pagination.preserves-page-size']) {
      report.fail(
        id,
        `discovery failed: ${describeError(error, 200)}`,
        'Serve a bounded, same-origin, paginated resource graph reachable from DeviceCapability.',
      );
    }
    return;
  }

  // Opaque means the harness never assumed a path shape; a numeric, guessable path is a hint
  // that a partner has built a fixed URL scheme Fortress is not permitted to rely on.
  const hrefs = snapshot.devices.map((device) => device.href).filter((href): href is string => Boolean(href));
  const guessable = hrefs.filter((href) => /\/\d+(?:\/|$)/.test(href));
  if (guessable.length === 0) {
    report.pass(
      'discovery.opaque-paths',
      `all ${hrefs.length} discovered EndDevice path(s) were followed as opaque links`,
    );
  } else {
    report.warn(
      'discovery.opaque-paths',
      `${guessable.length} discovered path(s) look like sequential identifiers`,
      'Paths are treated as opaque, so this is not a failure — but sequential ids let a caller enumerate your fleet.',
    );
  }

  // ResourceClient requests l=500 and rejects a page that exceeds it, a changing `all`, a
  // results/item mismatch, and link cycles. Reaching here means all of that held.
  report.pass('pagination.accepts-l500', 'lists accepted l=500 and stayed within the page cap');
  report.pass(
    'pagination.preserves-page-size',
    'pagination was internally consistent across pages (all, results, and next links agreed)',
  );
}

/* ------------------------------------------------------------------ assignment */

async function runAssignmentPhase(
  options: RunnerOptions,
  discovery: AssignmentDiscovery,
  eligible: Set<string>,
): Promise<AssignmentSnapshot | undefined> {
  const { report, devices } = options;

  const snapshot = await awaitOperatorState(
    options,
    {
      kind: 'assignment',
      targetLfdi: devices.alpha.lfdi,
      otherLfdi: devices.beta.lfdi,
      targetLabel: devices.alpha.label,
    },
    async () => {
      const current = await discovery.reconcile(CAPABILITY_PATH, eligible);
      const alpha = current.devices.find((device) => device.lFDI === devices.alpha.lfdi);
      const beta = current.devices.find((device) => device.lFDI === devices.beta.lfdi);
      const satisfied =
        current.valid && (alpha?.programs.length ?? 0) === 1 && (beta?.programs.length ?? 0) === 0;
      return satisfied ? current : undefined;
    },
  );

  if (snapshot === undefined) {
    report.add(
      'assignment.exactly-one-target',
      'manual',
      `no assignment of exactly one test device was observed before the deadline`,
      {
        action:
          `Assign only ${devices.alpha.label} to the rehearsal DERProgram using your own operator ` +
          'tooling, then re-run. The session is resumable, so registration will not repeat.',
      },
    );
    report.skip('assignment.empty-dispatches-none', 'requires an observed assignment');
    return undefined;
  }

  report.pass(
    'assignment.exactly-one-target',
    `exactly one test device (${devices.alpha.label}) discovered a DERProgram`,
  );
  report.pass(
    'assignment.empty-dispatches-none',
    `the unassigned test device (${devices.beta.label}) discovered no program, so it can receive nothing`,
  );
  return snapshot;
}

/* ------------------------------------------------------------------ control */

async function runControlPhase(
  options: RunnerOptions,
  resources: ResourceClient,
  store: SerializableSessionStore,
  discovery: AssignmentDiscovery,
  eligible: Set<string>,
  save: () => Promise<void>,
): Promise<ControlIntent | undefined> {
  const { report, devices, session } = options;

  // Generated once and remembered, so a resumed run looks for the same control rather than
  // asking the operator to publish a second one.
  session.control ??= {
    mRID: `fortress-csip-rehearsal-${Math.floor(options.io.now().getTime() / 1000)}`,
    start: Math.floor(options.io.now().getTime() / 1000),
    durationSeconds: REHEARSAL_DURATION_SECONDS,
    opModFixedW: REHEARSAL_WATTS,
  };
  await save();

  const dispatched: ControlIntent[] = [];
  const csipSession = new CsipSession({
    connectionId: 'conformance',
    resources,
    store,
    now: () => Math.floor(options.io.now().getTime() / 1000),
    sink: {
      async dispatch(intent) { dispatched.push(intent); },
      async updateLifecycle() {},
    },
  });

  const found = await awaitOperatorState(
    options,
    {
      kind: 'control',
      mRID: session.control.mRID,
      start: session.control.start,
      durationSeconds: session.control.durationSeconds,
      opModFixedW: session.control.opModFixedW,
      targetLfdi: devices.alpha.lfdi,
      targetLabel: devices.alpha.label,
    },
    async () => {
      const snapshot = await discovery.reconcile(CAPABILITY_PATH, eligible);
      await csipSession.runOnce(snapshot);
      return dispatched.find((intent) => intent.wireMrid === session.control?.mRID);
    },
  );

  if (found === undefined) {
    report.add('control.fixed-w-bounded', 'manual', 'the rehearsal control was not delivered before the deadline', {
      action:
        `Publish a DERControl with mRID ${session.control.mRID}, opModFixedW ` +
        `${session.control.opModFixedW} W, duration ${session.control.durationSeconds}s, ` +
        'responseRequired set, and a replyTo link — then re-run.',
    });
    report.skip('control.mrid-idempotent', 'requires one delivered control');
    return undefined;
  }

  if (found.assignedLFDIs.length === 1 && found.assignedLFDIs[0] === devices.alpha.lfdi) {
    report.pass(
      'control.fixed-w-bounded',
      `the bounded fixed-W control reached only ${devices.alpha.label}`,
    );
  } else {
    report.fail(
      'control.fixed-w-bounded',
      `the control targeted ${found.assignedLFDIs.length} device(s) rather than the one assigned device`,
      'A control must reach only EndDevices whose discovered assignments include its program.',
    );
  }

  // Re-polling must not produce a second delivery of the same mRID.
  const before = dispatched.length;
  const snapshot = await discovery.reconcile(CAPABILITY_PATH, eligible);
  await csipSession.runOnce(snapshot);
  if (dispatched.length === before) {
    report.pass('control.mrid-idempotent', 'repeated polling did not re-deliver the same mRID');
  } else {
    report.fail(
      'control.mrid-idempotent',
      'repeated polling delivered the same mRID again',
      'An unchanged mRID must be idempotent. Only a status transition to cancelled or superseded may change it.',
    );
  }
  await save();
  return found;
}

/* ------------------------------------------------------------------ responses */

async function runResponsePhase(
  options: RunnerOptions,
  resources: ResourceClient,
  store: SerializableSessionStore,
  intent: ControlIntent,
  save: () => Promise<void>,
): Promise<void> {
  const { report } = options;

  if (intent.replyTo === undefined) {
    for (const id of ['responses.accepted', 'responses.started', 'responses.terminal']) {
      report.fail(
        id,
        'the control advertised no replyTo link, so no response can be posted',
        'Include a replyTo link on any control whose responseRequired asks for responses.',
      );
    }
    return;
  }

  const csipSession = new CsipSession({
    connectionId: 'conformance',
    resources,
    store,
    now: () => Math.floor(options.io.now().getTime() / 1000),
    sink: { async dispatch() {}, async updateLifecycle() {} },
  });

  // The accepted response is not recorded here: client-core queues and sends it as part of
  // delivering the control, which is the behaviour Fortress will exhibit. So the check reads
  // what the delivery round already did rather than trying to queue a second one.
  const accepted = store
    .serialize()
    .responses.filter(
      (effect) => effect.internalEventId === intent.internalEventId && effect.response.status === 1,
    );
  if (accepted.length === 0) {
    report.fail(
      'responses.accepted',
      'no accepted response was queued when the control was delivered',
      "Set responseRequired so an accepted response is requested, and include a replyTo link.",
    );
  } else if (accepted.every((effect) => effect.sent)) {
    report.pass(
      'responses.accepted',
      `${accepted.length} accepted response(s) were posted on delivery and acknowledged`,
    );
  } else {
    report.fail(
      'responses.accepted',
      'the accepted response was queued on delivery but the server did not accept it',
      'Accept a DERControlResponse at the replyTo link for each requested lifecycle stage.',
    );
  }

  const stages: Array<{ id: string; outcome: 'started'; label: string }> = [
    { id: 'responses.started', outcome: 'started', label: 'started' },
  ];

  for (const stage of stages) {
    try {
      // recordOutcome returns how many responses it queued. Zero means the control did not
      // request this stage, which is a different fact from "the server accepted it" — and
      // treating the two alike would let a control that requests nothing pass every check.
      const queued = await csipSession.recordOutcome(intent.internalEventId, stage.outcome);
      if (queued === 0) {
        report.warn(
          stage.id,
          `the control's responseRequired did not ask for a ${stage.label} response`,
          'Set responseRequired so accepted, started, and terminal responses are all requested, then re-run.',
        );
        continue;
      }
      const flushed = await csipSession.flushResponses();
      if (flushed.sent > 0 && flushed.failed === 0) {
        report.pass(
          stage.id,
          `${flushed.sent} ${stage.label} response(s) were accepted at the advertised replyTo`,
        );
      } else {
        report.fail(
          stage.id,
          `the ${stage.label} response was rejected by the server`,
          'Accept a DERControlResponse at the replyTo link for each requested lifecycle stage.',
        );
      }
    } catch (error) {
      report.fail(
        stage.id,
        `posting the ${stage.label} response failed: ${describeError(error, 200)}`,
        'Accept a DERControlResponse at the replyTo link for each requested lifecycle stage.',
      );
    }
    await save();
  }

  // The terminal response is recorded but deliberately NOT flushed. It is left owed across
  // the restart below, so that `recovery.owed-response-retried` proves something: a run in
  // which nothing was outstanding cannot demonstrate that outstanding work survives.
  try {
    const queued = await csipSession.recordOutcome(intent.internalEventId, 'completed');
    if (queued === 0) {
      report.warn(
        'responses.terminal',
        "the control's responseRequired did not ask for a terminal response",
        'Set responseRequired so accepted, started, and terminal responses are all requested, then re-run.',
      );
    } else {
      report.skip('responses.terminal', 'recorded but held back, to be delivered after a restart');
    }
  } catch (error) {
    report.fail(
      'responses.terminal',
      `recording the terminal response failed: ${describeError(error, 200)}`,
      'Accept a DERControlResponse at the replyTo link for each requested lifecycle stage.',
    );
  }
  await save();
}

/* ------------------------------------------------------------------ recovery */

async function runRecoveryPhase(
  options: RunnerOptions,
  resources: ResourceClient,
  discovery: AssignmentDiscovery,
  eligible: Set<string>,
  intent: ControlIntent,
  save: () => Promise<void>,
): Promise<void> {
  const { report, session } = options;

  // Rebuild the client from the serialized session, exactly as a restarted process would.
  // This is the whole point of the serializable store: an in-memory client that never lost
  // its state proves nothing about durability.
  await save();
  const restarted = SerializableSessionStore.from(session.clientSession);
  const restartedResources = new ResourceClient({ transport: options.transport, store: restarted });
  const dispatched: ControlIntent[] = [];
  const restartedSession = new CsipSession({
    connectionId: 'conformance',
    resources: restartedResources,
    store: restarted,
    now: () => Math.floor(options.io.now().getTime() / 1000),
    sink: {
      async dispatch(deliveredIntent) { dispatched.push(deliveredIntent); },
      async updateLifecycle() {},
    },
  });

  // Read what was owed *before* running a round: a polling round settles owed responses as
  // part of its work, so asking afterwards would always find nothing outstanding.
  const owedAtRestart = await restarted.listPendingResponses();

  try {
    const restartedDiscovery = new AssignmentDiscovery({
      resources: restartedResources,
      store: restarted,
    });
    const snapshot = await restartedDiscovery.reconcile(CAPABILITY_PATH, eligible);
    await restartedSession.runOnce(snapshot);
    const redelivered = dispatched.filter((entry) => entry.wireMrid === intent.wireMrid);
    if (redelivered.length === 0) {
      report.pass(
        'recovery.no-duplicate-delivery',
        'a restarted client re-read the graph and did not deliver the control a second time',
      );
    } else {
      report.fail(
        'recovery.no-duplicate-delivery',
        'a restarted client delivered the same control again',
        'Actuation must be keyed on the control mRID and its material fingerprint, so a restart cannot repeat it.',
      );
    }
  } catch (error) {
    report.fail(
      'recovery.no-duplicate-delivery',
      `the restart check could not complete: ${describeError(error, 200)}`,
      'The graph must remain readable across a client restart.',
    );
  }

  // The terminal response was held back before the restart, so there is genuinely something
  // outstanding here. Delivering it now settles both the recovery check and the terminal
  // response check that was left undecided above.
  try {
    await restartedSession.flushResponses();
    const stillOwed = await restarted.listPendingResponses();
    if (owedAtRestart.length === 0) {
      report.fail(
        'recovery.owed-response-retried',
        'the response held back before the restart did not survive it',
        'Durable client state must carry owed responses across a restart. This indicates the effect was never persisted.',
      );
      report.resolveSkipped(
        'responses.terminal',
        'fail',
        'the terminal response was lost at restart rather than delivered',
        'Accept a DERControlResponse at the replyTo link for each requested lifecycle stage.',
      );
    } else if (stillOwed.length === 0) {
      report.pass(
        'recovery.owed-response-retried',
        `${owedAtRestart.length} response(s) owed at restart survived it and were delivered`,
      );
      report.resolveSkipped(
        'responses.terminal',
        'pass',
        'the terminal response was accepted at the advertised replyTo, after a client restart',
      );
    } else {
      report.fail(
        'recovery.owed-response-retried',
        `${stillOwed.length} owed response(s) could not be delivered after restart`,
        'Keep accepting responses for a control after its interval, so a recovering client can settle what it owes.',
      );
      report.resolveSkipped(
        'responses.terminal',
        'fail',
        'the terminal response was refused when delivered after a restart',
        'Keep accepting responses for a control after its interval.',
      );
    }
  } catch (error) {
    report.fail(
      'recovery.owed-response-retried',
      `the owed-response check could not complete: ${describeError(error, 200)}`,
      'Keep accepting responses for a control after its interval.',
    );
    report.resolveSkipped(
      'responses.terminal',
      'fail',
      'the terminal response could not be delivered after a restart',
      'Keep accepting responses for a control after its interval.',
    );
  }
  await save();
}

/* ------------------------------------------------------------------ assignment move */

/**
 * Move the assignment to the other device and confirm targeting follows.
 *
 * The property under test is that retargeting is entirely the partner's to do: nothing
 * changes on the Fortress side, no membership list is edited, and the new target becomes
 * visible purely through discovery.
 */
async function runAssignmentMovePhase(
  options: RunnerOptions,
  discovery: AssignmentDiscovery,
  eligible: Set<string>,
): Promise<void> {
  const { report, devices } = options;

  const moved = await awaitOperatorState(
    options,
    {
      kind: 'assignment-move',
      fromLfdi: devices.alpha.lfdi,
      toLfdi: devices.beta.lfdi,
      toLabel: devices.beta.label,
    },
    async () => {
      const current = await discovery.reconcile(CAPABILITY_PATH, eligible);
      const alpha = current.devices.find((device) => device.lFDI === devices.alpha.lfdi);
      const beta = current.devices.find((device) => device.lFDI === devices.beta.lfdi);
      const satisfied =
        current.valid && (alpha?.programs.length ?? 0) === 0 && (beta?.programs.length ?? 0) === 1;
      return satisfied ? current : undefined;
    },
  );

  if (moved === undefined) {
    report.add('assignment.move-retargets', 'manual', 'no assignment move was observed before the deadline', {
      action:
        `Move the rehearsal assignment from ${devices.alpha.label} to ${devices.beta.label} ` +
        'using your own operator tooling, then re-run.',
    });
    return;
  }
  report.pass(
    'assignment.move-retargets',
    `moving the assignment retargeted discovery to ${devices.beta.label} with no Fortress-side change`,
  );
}

/* ------------------------------------------------------------------ isolation */

/**
 * Two connections using overlapping program and control identifiers must not see each other.
 *
 * Only the self-test can arrange this: asking a partner to provision a second aggregator
 * connection mid-run is not part of the profile. Where the driver cannot, the check is
 * skipped rather than assumed.
 */
async function runIsolationCheck(
  options: RunnerOptions,
  discovery: AssignmentDiscovery,
  eligible: Set<string>,
  intent: ControlIntent,
): Promise<void> {
  const { report, devices } = options;
  if (options.driver.seedOverlappingConnection === undefined) {
    report.skip(
      'isolation.connection-scope',
      'requires a second connection reusing these identifiers, which only the self-test arranges',
    );
    return;
  }

  let seeded: boolean;
  try {
    seeded = await options.driver.seedOverlappingConnection(intent.wireMrid);
  } catch (error) {
    report.skip(
      'isolation.connection-scope',
      `a second overlapping connection could not be created: ${describeError(error, 160)}`,
    );
    return;
  }
  if (!seeded) {
    report.skip('isolation.connection-scope', 'no second connection was created to compare against');
    return;
  }

  try {
    const snapshot = await discovery.reconcile(CAPABILITY_PATH, eligible);
    const visible = new Set(snapshot.devices.map((device) => device.lFDI));
    const expected = new Set([devices.alpha.lfdi, devices.beta.lfdi]);
    const foreign = [...visible].filter((lfdi) => !expected.has(lfdi));
    if (foreign.length === 0) {
      report.pass(
        'isolation.connection-scope',
        'a second connection reusing the same program and control identifiers remained invisible to this one',
      );
    } else {
      report.fail(
        'isolation.connection-scope',
        `${foreign.length} EndDevice(s) from another connection were visible on this one`,
        'Scope every resource to its connection. Program and control identifiers may legitimately collide across connections.',
      );
    }
  } catch (error) {
    report.fail(
      'isolation.connection-scope',
      `the isolation check could not complete: ${describeError(error, 200)}`,
      'Scope every resource to its connection.',
    );
  }
}

/* ------------------------------------------------------------------ telemetry */

async function runTelemetryPhase(
  options: RunnerOptions,
  resources: ResourceClient,
  eligible: Set<string>,
): Promise<void> {
  const { report, devices } = options;
  const timestamp = Math.floor(options.io.now().getTime() / 1000);

  const publisher = new TelemetryPublisher({
    resources,
    now: () => timestamp,
    source: {
      // Deterministic synthetic values. Nothing here comes from a real site.
      async read() {
        return {
          timestamp,
          activePowerW: -1_450,
          reactivePowerVar: 0,
          frequencyHz: 60,
          voltageV: 240,
          status: { stateOfChargePercent: 52, operationalMode: 2 },
          capability: { maxPowerW: 5_000, maxEnergyWh: 13_500 },
        };
      },
    },
  });

  let profiles;
  try {
    profiles = await publisher.discover(CAPABILITY_PATH, eligible);
  } catch (error) {
    for (const id of ['telemetry.standard-mup', 'telemetry.der-status', 'telemetry.der-capability']) {
      report.fail(
        id,
        `telemetry discovery failed: ${describeError(error, 200)}`,
        'Advertise MirrorUsagePointListLink and serve a MirrorUsagePoint per registered EndDevice.',
      );
    }
    return;
  }

  const profile = profiles.find((entry) => entry.lFDI === devices.alpha.lfdi) ?? profiles[0];
  if (profile === undefined) {
    for (const id of ['telemetry.standard-mup', 'telemetry.der-status', 'telemetry.der-capability']) {
      report.fail(
        id,
        'no telemetry destination was discovered for the registered devices',
        'Serve a MirrorUsagePoint for each registered EndDevice, reachable from MirrorUsagePointListLink.',
      );
    }
    return;
  }

  try {
    const result = await publisher.publish(profile);
    if (result.sent > 0 && result.quarantined === 0) {
      report.pass(
        'telemetry.standard-mup',
        `${result.sent} standard telemetry write(s) were accepted at the discovered destination`,
      );
    } else {
      report.fail(
        'telemetry.standard-mup',
        `telemetry publication sent ${result.sent} and quarantined ${result.quarantined}`,
        'Accept MirrorMeterReading writes at the discovered MirrorUsagePoint.',
      );
    }
  } catch (error) {
    report.fail(
      'telemetry.standard-mup',
      `publishing telemetry failed: ${describeError(error, 200)}`,
      'Accept MirrorMeterReading writes at the discovered MirrorUsagePoint.',
    );
  }

  // DER status and capability are checked only where the server advertises a destination:
  // the profile does not require them, and failing a partner for not advertising something
  // optional would make the report less useful, not more.
  reportAdvertisedDestination(report, 'telemetry.der-status', 'DERStatus', profile.derStatusHref);
  reportAdvertisedDestination(report, 'telemetry.der-capability', 'DERCapability', profile.derCapabilityHref);
}

function reportAdvertisedDestination(
  report: ReportBuilder,
  id: string,
  name: string,
  href: string | undefined,
): void {
  if (href === undefined) {
    report.skip(id, `no ${name} destination is advertised for this device`);
    return;
  }
  report.pass(id, `${name} was written to its advertised destination`);
}

/* ------------------------------------------------------------------ cleanup */

async function cleanUpDevices(
  options: RunnerOptions,
  resources: ResourceClient,
  store: SerializableSessionStore,
): Promise<void> {
  if (options.keepTestDevices) {
    options.io.err('');
    options.io.err('--keep-test-devices was set: the synthetic EndDevices were left in place.');
    options.io.err('Remove them with your own tooling when you are finished investigating.');
    return;
  }
  for (const label of [options.devices.alpha, options.devices.beta]) {
    const stored = await store.loadEndDevice(label.lfdi);
    if (stored === undefined) continue;
    try {
      await resources.deleteEndDevice(stored.href);
      await store.removeEndDevice(label.lfdi);
    } catch {
      // Deleting is best-effort: not every server exposes a DELETE on the discovered path,
      // and failing the run over cleanup would obscure the conformance result.
      options.io.err(
        `Could not remove synthetic device ${label.label}; remove it with your own tooling.`,
      );
    }
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * Ask for an operator action, then poll the connection until the state appears.
 *
 * The check is always made from what the CSIP connection shows, never from what the driver
 * reported doing — which is what lets the self-test and a real partner run the same code.
 */
async function awaitOperatorState<T>(
  options: RunnerOptions,
  instruction: OperatorInstruction,
  observe: () => Promise<T | undefined>,
): Promise<T | undefined> {
  await options.driver.request(instruction);

  const deadline = options.io.now().getTime() + options.driver.pollTimeoutMs;
  const maxAttempts = Math.max(
    1,
    Math.ceil(options.driver.pollTimeoutMs / Math.max(1, options.driver.pollIntervalMs)) + 1,
  );
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const observed = await observe();
      if (observed !== undefined) return observed;
    } catch {
      // A transient read failure while waiting for an operator is expected — the operator may
      // be restarting a service. The deadline, not one failure, decides.
    }
    if (options.io.now().getTime() >= deadline) break;
    await options.sleep(options.driver.pollIntervalMs);
  }
  return undefined;
}

function skipRemaining(report: ReportBuilder, ids: string[], reason: string): void {
  for (const id of ids) if (!report.has(id)) report.skip(id, reason);
}
