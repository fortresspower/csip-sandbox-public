import {
  CsipSession,
  CsipProtocolError,
  CsipRetryableServerError,
  MemorySessionStore,
  ResourceClient,
  type AssignmentSnapshot,
  type ControlIntent,
  type CsipRequestOptions,
  type CsipResponse,
  type CsipTransport,
} from '@fortress-csip/client-core';
import { serializeMirrorMeterReadingList, findPoint, type DERControl, type MirrorMeterReading } from '@fortress-csip/protocol';
import type { SyntheticGenerator, Snapshot } from './generator.js';
import { applyControl } from './control.js';

export interface Transport {
  origin?: string;
  get(path: string): Promise<string>;
  post(path: string, xml: string): Promise<{ status: number; location?: string }>;
  put(path: string, xml: string): Promise<{ status: number }>;
}

export interface CsipClientOpts {
  generator: SyntheticGenerator;
  transport: Transport;
  subscription: string[];
  mupHref: string;
  controlListHref?: string;
  connectionId?: string;
  programMrid?: string;
  programPrimacy?: number;
  onControlApplied?: (label: string) => void; // surfaces the last applied control (e.g. to /status)
  now?: () => number;          // seconds
}

// Each entry returns the integer wire value plus the powerOfTenMultiplier that declares its
// scale, so a server recovers the real quantity as value * 10^multiplier.
const snapshotValue = (s: Snapshot, point: string): { value: number; multiplier: number } | undefined => {
  switch (point) {
    case 'model101.W': return { value: s.realPowerW, multiplier: 0 };
    case 'model101.VAr': return { value: s.reactivePowerVar, multiplier: 0 };
    case 'model101.Hz': return { value: Math.round(s.frequencyHz * 100), multiplier: -2 };
    case 'model101.PhVphA': return { value: Math.round(s.voltageV * 10), multiplier: -1 };
    case 'model802.SoC': return { value: s.soc, multiplier: 0 };  // posted via DERStatus in full impl; numeric here
    // --- Fortress extension lane: synthetic sources so subscribing one actually posts a
    //     MirrorMeterReading carrying its fortress:* mRID on the wire (vendor lane). ---
    case 'model40101.sohBat': return { value: 98, multiplier: 0 };                          // SoH %
    case 'model40101.pBkupTot': return { value: 0, multiplier: 0 };                          // backup-port W
    default: return undefined;
  }
};

export class CsipClient {
  readonly #session: CsipSession;
  readonly #assignments: AssignmentSnapshot;

  constructor(private readonly o: CsipClientOpts) {
    const store = new MemorySessionStore();
    const resources = new ResourceClient({ transport: coreTransport(o.transport), store });
    const admittedControls = new Set<string>();
    this.#assignments = {
      valid: true,
      devices: [{
        lFDI: o.generator.snapshot().lFDI,
        programs: o.controlListHref ? [{
          mRID: o.programMrid ?? 'sandbox-program',
          primacy: o.programPrimacy ?? 0,
          controlListHref: o.controlListHref,
        }] : [],
      }],
    };
    this.#session = new CsipSession({
      connectionId: o.connectionId ?? 'sandbox-partner',
      resources,
      store,
      now: () => this.now(),
      sink: {
        dispatch: async (intent) => {
          if (!admittedControls.has(intent.internalEventId)) {
            const label = applyControl(o.generator, intentControl(intent));
            o.onControlApplied?.(label);
            admittedControls.add(intent.internalEventId);
          }
          return { status: 'accepted' as const };
        },
        reconcile: async (intent) => ({
          status: admittedControls.has(intent.internalEventId) ? 'accepted' as const : 'not-admitted' as const,
        }),
        updateLifecycle: async (update) => {
          o.generator.setChargeSetpoint(0);
          o.onControlApplied?.(`${update.wireMrid}: ${update.kind}`);
        },
      },
    });
  }
  private now() { return this.o.now ? this.o.now() : Math.floor(Date.now() / 1000); }

  async pollAndApplyControl(): Promise<void> {
    if (!this.o.controlListHref) throw new Error('controlListHref is required to poll controls');
    const result = await this.#session.runOnce(this.#assignments);
    for (const intent of result.delivered) {
      await this.#session.recordOutcome(intent.internalEventId, 'started');
      await this.#session.recordOutcome(intent.internalEventId, 'completed');
    }
    await this.#session.flushResponses();
  }

  async postTelemetry(): Promise<void> {
    const s = this.o.generator.snapshot();
    // Build all of this interval's readings, then POST them as one MirrorMeterReadingList to
    // the MUP — the canonical batch form (IEEE 2030.5 §10.11.3(d)), not one POST per point.
    const readings: MirrorMeterReading[] = [];
    for (const point of this.o.subscription) {
      const entry = findPoint(point);
      if (!entry || entry.mapping.kind === 'off-protocol' || entry.mapping.kind === 'der-status-field' || entry.mapping.kind === 'der-capability-field') continue;
      const reading = snapshotValue(s, point);
      if (reading === undefined) {
        // Subscribed point passed the kind filter but has no synthetic source wired (e.g. a
        // spec-optional reading-type). Surface it instead of silently posting nothing.
        console.warn(`[telemetry] no synthetic source for subscribed point ${point}; skipping`);
        continue;
      }
      const uom = entry.mapping.kind === 'reading-type' || entry.mapping.kind === 'extension' ? entry.mapping.uom : 0;
      readings.push({
        mRID: point.replace(/\W/g, ''),
        description: point,
        ReadingType: { uom: uom as any, powerOfTenMultiplier: reading.multiplier, ...(entry.mapping.kind === 'extension' ? { mRID: entry.mapping.conventionMrid } : {}) },
        Reading: { timePeriod: { start: this.now(), duration: 0 }, value: reading.value },
      });
    }
    if (readings.length === 0) return;
    await this.o.transport.post(this.o.mupHref, serializeMirrorMeterReadingList(readings));
  }
}

function intentControl(intent: ControlIntent): DERControl {
  return {
    mRID: intent.wireMrid,
    creationTime: intent.creationTime,
    responseRequired: intent.responseRequired,
    ...(intent.replyTo ? { replyTo: intent.replyTo } : {}),
    EventStatus: { currentStatus: intent.eventStatus },
    interval: { ...intent.interval },
    DERControlBase: { ...intent.control },
  };
}

function coreTransport(transport: Transport): CsipTransport {
  const request = async (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    href: string,
    options: CsipRequestOptions = {},
  ): Promise<CsipResponse> => {
    if (method === 'GET') return { status: 200, headers: {}, body: await transport.get(href) };
    if (method === 'POST') {
      const response = await transport.post(href, options.body ?? '');
      assertSuccessfulResponse(method, href, response.status);
      return {
        status: response.status,
        headers: response.location ? { location: response.location } : {},
        body: '',
      };
    }
    if (method === 'PUT') {
      const response = await transport.put(href, options.body ?? '');
      assertSuccessfulResponse(method, href, response.status);
      return { status: response.status, headers: {}, body: '' };
    }
    throw new Error('the synthetic demo transport does not support DELETE');
  };
  return {
    origin: transport.origin ?? 'http://sandbox.invalid',
    request,
    get: (href) => request('GET', href),
    post: (href, body) => request('POST', href, { body }),
    put: (href, body) => request('PUT', href, { body }),
    close: () => {},
  };
}

function assertSuccessfulResponse(method: string, href: string, status: number): void {
  if (status === 429 || status >= 500) {
    throw new CsipRetryableServerError(method, href, status, '');
  }
  if (status >= 400) throw new CsipProtocolError(`${method} ${href} failed with status ${status}`, status, '');
}
