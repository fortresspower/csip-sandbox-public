import {
  Uom,
} from '@fortress-csip/protocol';
import { CsipError } from './types.js';
import { isCanonicalLfdi } from './identity.js';
import { CsipDiscoveryError, ResourceClient, type EndDeviceFleetSnapshot } from './resource-client.js';
import type {
  TelemetryProfile,
  TelemetryPublishResult,
  TelemetryQuarantineEntry,
  TelemetrySample,
  TelemetrySource,
} from './telemetry-types.js';
import type {
  CsipDerCapability,
  CsipDerStatus,
  CsipMirrorMeterReading,
  CsipMirrorUsagePoint,
} from './wire-types.js';
import {
  mapConcurrent,
  throwIfAborted,
  type CsipWorkOptions,
} from './concurrency.js';

export const MIN_TELEMETRY_INTERVAL_SECONDS = 300;
export const DEFAULT_MAX_TELEMETRY_PROFILES = 100_000;
export const DEFAULT_TELEMETRY_WORK_BATCH_SIZE = 500;
export const DEFAULT_MAX_TELEMETRY_QUEUE = 2_000;
export const DEFAULT_TELEMETRY_CONCURRENCY = 32;
export const MAX_TELEMETRY_CONCURRENCY = 32;
const MAX_JOBS_PER_PROFILE = 4;

type TelemetryJob =
  | { id: string; lFDI: string; timestamp: number; kind: 'mup'; href: string; payload: CsipMirrorUsagePoint }
  | { id: string; lFDI: string; timestamp: number; kind: 'status'; href: string; payload: CsipDerStatus }
  | { id: string; lFDI: string; timestamp: number; kind: 'capability'; href: string; payload: CsipDerCapability };

interface TelemetryLanes {
  standard: boolean;
  extensions: boolean;
}

interface TelemetryDrainOutcome {
  result: TelemetryPublishResult;
  attempted: Set<string>;
}

export interface TelemetryPublisherOptions {
  resources: ResourceClient;
  source: TelemetrySource;
  now?: () => number;
  maxQueue?: number;
  maxProfiles?: number;
  /** Maximum simultaneous source reads, DER discovery reads, or sends. Hard-capped at 32. */
  concurrency?: number;
  /** Profiles materialized between queue drains. Hard-capped at 500. */
  workBatchSize?: number;
  /** Disable only for compatibility tests; production runDue calls stagger startup work. */
  staggerInitialRun?: boolean;
}

export interface TelemetryDiscoveryOptions extends CsipWorkOptions {
  snapshot?: EndDeviceFleetSnapshot;
}

export class TelemetryPublisher {
  readonly #resources: ResourceClient;
  readonly #source: TelemetrySource;
  readonly #now: () => number;
  readonly #maxQueue: number;
  readonly #maxProfiles: number;
  readonly #concurrency: number;
  readonly #workBatchSize: number;
  readonly #staggerInitialRun: boolean;
  readonly #startedAt: number;
  readonly #pending = new Map<string, TelemetryJob>();
  readonly #completed = new Set<string>();
  readonly #quarantine: TelemetryQuarantineEntry[] = [];
  readonly #lastRun = new Map<string, number>();
  #drainPromise?: Promise<TelemetryDrainOutcome>;

  constructor(options: TelemetryPublisherOptions) {
    this.#resources = options.resources;
    this.#source = options.source;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.#maxQueue = options.maxQueue ?? DEFAULT_MAX_TELEMETRY_QUEUE;
    this.#maxProfiles = options.maxProfiles ?? DEFAULT_MAX_TELEMETRY_PROFILES;
    this.#workBatchSize = options.workBatchSize ?? DEFAULT_TELEMETRY_WORK_BATCH_SIZE;
    this.#staggerInitialRun = options.staggerInitialRun ?? true;
    this.#startedAt = this.#now();
    if (!Number.isSafeInteger(this.#maxQueue) || this.#maxQueue < MAX_JOBS_PER_PROFILE) {
      throw new CsipDiscoveryError(`maxQueue must be a safe integer of at least ${MAX_JOBS_PER_PROFILE}`);
    }
    if (!Number.isSafeInteger(this.#maxProfiles) || this.#maxProfiles <= 0) {
      throw new CsipDiscoveryError('maxProfiles must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.#workBatchSize) || this.#workBatchSize <= 0 || this.#workBatchSize > 500) {
      throw new CsipDiscoveryError('workBatchSize must be a positive safe integer no greater than 500');
    }
    this.#concurrency = options.concurrency ?? DEFAULT_TELEMETRY_CONCURRENCY;
    if (!Number.isSafeInteger(this.#concurrency) || this.#concurrency <= 0 || this.#concurrency > MAX_TELEMETRY_CONCURRENCY) {
      throw new CsipDiscoveryError(`concurrency must be a positive safe integer no greater than ${MAX_TELEMETRY_CONCURRENCY}`);
    }
  }

  async discover(
    deviceCapabilityHref: string,
    eligibleLFDIs: ReadonlySet<string>,
    options: TelemetryDiscoveryOptions = {},
  ): Promise<TelemetryProfile[]> {
    throwIfAborted(options.signal);
    if (eligibleLFDIs.size > this.#maxProfiles) {
      throw new CsipDiscoveryError(`telemetry discovery exceeded the ${this.#maxProfiles}-profile limit`);
    }
    const fleet = options.snapshot
      ? this.#resources.requireEndDeviceFleet(deviceCapabilityHref, options.snapshot)
      : await this.#resources.endDeviceFleet(deviceCapabilityHref);
    const capability = fleet.capability;
    if (!capability.EndDeviceListLink || !capability.MirrorUsagePointListLink) {
      throw new CsipDiscoveryError('telemetry discovery requires EndDeviceListLink and MirrorUsagePointListLink');
    }
    const endDevices = fleet.endDevices;
    const usagePoints = await this.#resources.mirrorUsagePoints(capability.MirrorUsagePointListLink);
    const devicesByLfdi = new Map<string, (typeof endDevices)[number] | null>();
    for (const device of endDevices) {
      devicesByLfdi.set(device.lFDI, devicesByLfdi.has(device.lFDI) ? null : device);
    }
    interface UsagePointRoute {
      href?: string;
      mRID: string;
      postRate?: number;
    }
    interface UsagePointRoutes {
      standard?: UsagePointRoute;
      extension?: UsagePointRoute;
      standardAmbiguous?: true;
      extensionAmbiguous?: true;
    }
    const usagePointsByLfdi = new Map<string, UsagePointRoutes>();
    for (const usagePoint of usagePoints) {
      const routes = usagePointsByLfdi.get(usagePoint.deviceLFDI) ?? {};
      const route: UsagePointRoute = {
        ...(usagePoint.href ? { href: usagePoint.href } : {}),
        mRID: usagePoint.mRID,
        ...(usagePoint.postRate !== undefined ? { postRate: usagePoint.postRate } : {}),
      };
      if (usagePoint.mRID.startsWith('fortress:')) {
        if (routes.extension) routes.extensionAmbiguous = true;
        else routes.extension = route;
      } else if (routes.standard) routes.standardAmbiguous = true;
      else routes.standard = route;
      usagePointsByLfdi.set(usagePoint.deviceLFDI, routes);
    }
    usagePoints.length = 0;
    const derReads = new Map<string, Promise<Awaited<ReturnType<ResourceClient['ders']>>>>();
    const readDers = (href: string): Promise<Awaited<ReturnType<ResourceClient['ders']>>> => {
      const canonical = this.#resources.canonicalHref(href);
      let pending = derReads.get(canonical);
      if (!pending) {
        pending = this.#resources.ders(href);
        derReads.set(canonical, pending);
      }
      return pending;
    };
    return mapConcurrent([...eligibleLFDIs], this.#concurrency, async (lFDI): Promise<TelemetryProfile> => {
      throwIfAborted(options.signal);
      if (!isCanonicalLfdi(lFDI)) throw new CsipDiscoveryError(`eligible telemetry LFDI is invalid: ${lFDI}`);
      const device = devicesByLfdi.get(lFDI);
      if (!device) throw new CsipDiscoveryError(`telemetry requires one EndDevice for LFDI ${lFDI}`);
      const routes = usagePointsByLfdi.get(lFDI);
      const standard = routes?.standard;
      const extension = routes?.extension;
      if (!standard || routes?.standardAmbiguous || routes?.extensionAmbiguous) {
        throw new CsipDiscoveryError(`telemetry MUP routes are missing or ambiguous for LFDI ${lFDI}`);
      }
      if (!standard.href) throw new CsipDiscoveryError(`standard MUP has no href for LFDI ${lFDI}`);
      if (extension && !extension.href) {
        throw new CsipDiscoveryError(`extension MUP has no href for LFDI ${lFDI}`);
      }
      this.#resources.canonicalHref(standard.href);
      if (extension?.href) this.#resources.canonicalHref(extension.href);
      const advertisedRate = standard.postRate ?? MIN_TELEMETRY_INTERVAL_SECONDS;
      if (!Number.isSafeInteger(advertisedRate) || advertisedRate <= 0) {
        throw new CsipDiscoveryError(`standard MUP has invalid postRate for LFDI ${lFDI}`);
      }
      const extensionAdvertisedRate = extension?.postRate ?? MIN_TELEMETRY_INTERVAL_SECONDS;
      if (!Number.isSafeInteger(extensionAdvertisedRate) || extensionAdvertisedRate <= 0) {
        throw new CsipDiscoveryError(`extension MUP has invalid postRate for LFDI ${lFDI}`);
      }

      let derStatusHref: string | undefined;
      let derCapabilityHref: string | undefined;
      if (device.DERListLink) {
        const ders = await readDers(device.DERListLink);
        const statusLinks = [...new Set(ders.flatMap((der) => der.DERStatusLink ? [der.DERStatusLink] : []))];
        const capabilityLinks = [...new Set(ders.flatMap((der) => der.DERCapabilityLink ? [der.DERCapabilityLink] : []))];
        if (statusLinks.length > 1 || capabilityLinks.length > 1) {
          throw new CsipDiscoveryError(`DER telemetry routes are ambiguous for LFDI ${lFDI}`);
        }
        derStatusHref = statusLinks[0];
        derCapabilityHref = capabilityLinks[0];
        if (derStatusHref) this.#resources.canonicalHref(derStatusHref);
        if (derCapabilityHref) this.#resources.canonicalHref(derCapabilityHref);
      }
      return {
        lFDI,
        intervalSeconds: Math.max(MIN_TELEMETRY_INTERVAL_SECONDS, advertisedRate),
        rateClamped: advertisedRate < MIN_TELEMETRY_INTERVAL_SECONDS,
        standardMupHref: standard.href,
        standardMupMrid: standard.mRID,
        ...(extension?.href ? {
          extensionMupHref: extension.href,
          extensionMupMrid: extension.mRID,
          extensionIntervalSeconds: Math.max(MIN_TELEMETRY_INTERVAL_SECONDS, extensionAdvertisedRate),
        } : {}),
        ...(derStatusHref ? { derStatusHref } : {}),
        ...(derCapabilityHref ? { derCapabilityHref } : {}),
      };
    }, options.signal);
  }

  async runDue(
    profiles: readonly TelemetryProfile[],
    options: CsipWorkOptions = {},
  ): Promise<TelemetryPublishResult> {
    if (profiles.length > this.#maxProfiles) {
      throw new CsipDiscoveryError(`telemetry publication exceeded the ${this.#maxProfiles}-profile limit`);
    }
    const total = emptyResult();
    const attempted = new Set<string>();
    addResult(total, await this.#retryPending(attempted, options));
    const batchSize = Math.min(this.#workBatchSize, Math.max(1, Math.floor(this.#maxQueue / MAX_JOBS_PER_PROFILE)));
    for (let offset = 0; offset < profiles.length; offset += batchSize) {
      throwIfAborted(options.signal);
      const batch = profiles.slice(offset, offset + batchSize);
      const due = batch.flatMap((profile) => {
        const now = this.#now();
        const standardKey = `${profile.lFDI}:standard`;
        const extensionKey = `${profile.lFDI}:extensions`;
        const standardDue = this.#isRunDue(standardKey, now, profile.intervalSeconds);
        const extensionsDue = profile.extensionMupHref !== undefined
          && this.#isRunDue(extensionKey, now, profile.extensionIntervalSeconds ?? MIN_TELEMETRY_INTERVAL_SECONDS);
        return standardDue || extensionsDue
          ? [{ profile, now, standardKey, extensionKey, lanes: { standard: standardDue, extensions: extensionsDue } }]
          : [];
      });
      let samples: ReadonlyMap<string, TelemetrySample | Error> | undefined;
      if (due.length > 0 && this.#source.readMany) {
        try {
          samples = await this.#source.readMany(due.map(({ profile }) => profile.lFDI));
        } catch (error) {
          for (const { profile } of due) {
            this.#quarantineEntry({ lFDI: profile.lFDI, reason: errorMessage(error) });
          }
          total.quarantined += due.length;
          addResult(total, await this.#retryPending(attempted, options));
          continue;
        }
      }
      const queued = await mapConcurrent(due, this.#concurrency, async ({
        profile, now, standardKey, extensionKey, lanes,
      }) => {
        const batchSample = samples?.get(profile.lFDI);
        const result = samples
          ? batchSample instanceof Error
            ? this.#quarantineSample(profile.lFDI, batchSample)
            : batchSample === undefined
              ? this.#quarantineSample(profile.lFDI, new Error('batch telemetry source omitted the requested LFDI'))
              : await this.#queue(profile, lanes, batchSample)
          : await this.#queue(profile, lanes);
        if (result.backpressured === 0) {
          if (lanes.standard) this.#lastRun.set(standardKey, now);
          if (lanes.extensions) this.#lastRun.set(extensionKey, now);
        }
        return result;
      }, options.signal);
      for (const result of queued) addResult(total, result);
      addResult(total, await this.#retryPending(attempted, options));
    }
    return total;
  }

  async publish(profile: TelemetryProfile, options: CsipWorkOptions = {}): Promise<TelemetryPublishResult> {
    const queued = await this.#queue(profile, { standard: true, extensions: true });
    const flushed = await this.#retryPending(new Set<string>(), options);
    addResult(queued, flushed);
    return queued;
  }

  async #queue(
    profile: TelemetryProfile,
    lanes: TelemetryLanes,
    batchSample?: TelemetrySample,
  ): Promise<TelemetryPublishResult> {
    let jobs: TelemetryJob[];
    try {
      const sample = batchSample ?? await this.#source.read(profile.lFDI);
      jobs = buildJobs(profile, validateSample(sample), lanes);
    } catch (error) {
      this.#quarantineEntry({ lFDI: profile.lFDI, reason: errorMessage(error) });
      return { ...emptyResult(), quarantined: 1 };
    }
    const fresh = jobs.filter((job) => !this.#pending.has(job.id) && !this.#completed.has(job.id));
    if (this.#pending.size + fresh.length > this.#maxQueue) {
      return { ...emptyResult(), backpressured: fresh.length };
    }
    for (const job of fresh) {
      this.#pending.set(job.id, job);
    }
    return { ...emptyResult(), queued: fresh.length };
  }

  #quarantineSample(lFDI: string, error: Error): TelemetryPublishResult {
    this.#quarantineEntry({ lFDI, reason: errorMessage(error) });
    return { ...emptyResult(), quarantined: 1 };
  }

  retryPending(options: CsipWorkOptions = {}): Promise<TelemetryPublishResult> {
    return this.#retryPending(new Set<string>(), options);
  }

  async #retryPending(attempted: Set<string>, options: CsipWorkOptions): Promise<TelemetryPublishResult> {
    if (this.#drainPromise) {
      const joined = await this.#drainPromise;
      for (const id of joined.attempted) attempted.add(id);
      const followup = await this.#retryPending(attempted, options);
      const result = { ...joined.result };
      addResult(result, followup);
      return result;
    }
    const drain = this.#performDrain(attempted, options);
    const locked = drain.finally(() => {
      if (this.#drainPromise === locked) this.#drainPromise = undefined;
    });
    this.#drainPromise = locked;
    return (await locked).result;
  }

  async #performDrain(attempted: Set<string>, options: CsipWorkOptions): Promise<TelemetryDrainOutcome> {
    const result = emptyResult();
    while (true) {
      throwIfAborted(options.signal);
      const jobs = [...this.#pending.values()].filter((job) => !attempted.has(job.id));
      if (jobs.length === 0) return { result, attempted };
      for (const job of jobs) attempted.add(job.id);
      const outcomes = await mapConcurrent(jobs, this.#concurrency, async (job) => {
        try {
          await this.#send(job);
          this.#pending.delete(job.id);
          this.#rememberCompleted(job.id);
          return 'sent' as const;
        } catch (error) {
          if (error instanceof CsipError && error.retryable) {
            return 'retryable' as const;
          }
          this.#pending.delete(job.id);
          this.#quarantineEntry({
            lFDI: job.lFDI,
            timestamp: job.timestamp,
            jobId: job.id,
            reason: errorMessage(error),
          });
          return 'quarantined' as const;
        }
      }, options.signal);
      for (const outcome of outcomes) {
        if (outcome === 'sent') result.sent += 1;
        else if (outcome === 'retryable') result.retryableFailures += 1;
        else result.quarantined += 1;
      }
    }
  }

  diagnostics(): { pending: number; quarantine: TelemetryQuarantineEntry[] } {
    return { pending: this.#pending.size, quarantine: structuredClone(this.#quarantine) };
  }

  async #send(job: TelemetryJob): Promise<void> {
    if (job.kind === 'mup') await this.#resources.postMirrorUsagePoint(job.href, job.payload);
    else if (job.kind === 'status') await this.#resources.putDerStatus(job.href, job.payload);
    else await this.#resources.putDerCapability(job.href, job.payload);
  }

  #isRunDue(key: string, now: number, intervalSeconds: number): boolean {
    const lastRun = this.#lastRun.get(key);
    if (lastRun !== undefined) return now - lastRun >= intervalSeconds;
    if (!this.#staggerInitialRun) return true;
    const initialOffset = 1 + stableOffset(key, intervalSeconds);
    return now >= this.#startedAt + initialOffset;
  }

  #quarantineEntry(entry: TelemetryQuarantineEntry): void {
    if (this.#quarantine.length >= this.#maxQueue) this.#quarantine.shift();
    this.#quarantine.push(entry);
  }

  #rememberCompleted(jobId: string): void {
    if (this.#completed.size >= this.#maxQueue) {
      const oldest = this.#completed.values().next().value as string | undefined;
      if (oldest !== undefined) this.#completed.delete(oldest);
    }
    this.#completed.add(jobId);
  }
}

function validateSample(sample: TelemetrySample): TelemetrySample {
  if (!Number.isSafeInteger(sample.timestamp) || sample.timestamp < 0) throw new Error('timestamp must be a non-negative safe integer');
  for (const field of ['activePowerW', 'reactivePowerVar', 'frequencyHz', 'voltageV'] as const) {
    const value = sample[field];
    if (value !== undefined && !Number.isFinite(value)) throw new Error(`${field} must be finite`);
  }
  if (sample.status) {
    for (const [field, value] of Object.entries(sample.status)) {
      if (value !== undefined && !Number.isFinite(value)) throw new Error(`status.${field} must be finite`);
    }
    const soc = sample.status.stateOfChargePercent;
    if (soc !== undefined && (soc < 0 || soc > 100)) throw new Error('status.stateOfChargePercent must be between 0 and 100');
  }
  if (sample.capability) {
    for (const [field, value] of Object.entries(sample.capability)) {
      if (value !== undefined && !Number.isFinite(value)) throw new Error(`capability.${field} must be finite`);
    }
  }
  for (const extension of sample.extensions ?? []) {
    if (!extension.mRID.startsWith('fortress:') || extension.mRID.length === 'fortress:'.length) {
      throw new Error('extension mRID must use the fortress: namespace');
    }
    if (!Number.isFinite(extension.value)) throw new Error(`extension ${extension.mRID} value must be finite`);
  }
  return sample;
}

function buildJobs(profile: TelemetryProfile, sample: TelemetrySample, lanes: TelemetryLanes): TelemetryJob[] {
  const jobs: TelemetryJob[] = [];
  const standardReadings = standardMeterReadings(sample);
  if (lanes.standard && standardReadings.length > 0) {
    jobs.push({
      id: `${profile.lFDI}:${sample.timestamp}:standard`,
      lFDI: profile.lFDI,
      timestamp: sample.timestamp,
      kind: 'mup',
      href: profile.standardMupHref,
      payload: {
        mRID: profile.standardMupMrid,
        deviceLFDI: profile.lFDI,
        MirrorMeterReadings: standardReadings,
      },
    });
  }
  if (lanes.standard && sample.status && profile.derStatusHref) {
    jobs.push({
      id: `${profile.lFDI}:${sample.timestamp}:status`,
      lFDI: profile.lFDI,
      timestamp: sample.timestamp,
      kind: 'status',
      href: profile.derStatusHref,
      payload: statusPayload(sample),
    });
  }
  if (lanes.standard && sample.capability && profile.derCapabilityHref) {
    jobs.push({
      id: `${profile.lFDI}:${sample.timestamp}:capability`,
      lFDI: profile.lFDI,
      timestamp: sample.timestamp,
      kind: 'capability',
      href: profile.derCapabilityHref,
      payload: capabilityPayload(sample),
    });
  }
  if (lanes.extensions && (sample.extensions?.length ?? 0) > 0) {
    if (!profile.extensionMupHref || !profile.extensionMupMrid) throw new Error('extension telemetry has no discovered extension MUP');
    jobs.push({
      id: `${profile.lFDI}:${sample.timestamp}:extensions`,
      lFDI: profile.lFDI,
      timestamp: sample.timestamp,
      kind: 'mup',
      href: profile.extensionMupHref,
      payload: {
        mRID: profile.extensionMupMrid,
        deviceLFDI: profile.lFDI,
        MirrorMeterReadings: sample.extensions!.map((extension) => ({
          mRID: extension.mRID.replace(/\W/g, ''),
          description: extension.mRID,
          ReadingType: {
            uom: extension.uom,
            mRID: extension.mRID,
            dataQualifier: 12,
            ...(extension.powerOfTenMultiplier !== undefined
              ? { powerOfTenMultiplier: extension.powerOfTenMultiplier }
              : {}),
          },
          Reading: { timePeriod: { start: sample.timestamp, duration: 0 }, value: extension.value },
        })),
      },
    });
  }
  return jobs;
}

function stableOffset(value: string, modulo: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % modulo;
}

function standardMeterReadings(sample: TelemetrySample): CsipMirrorMeterReading[] {
  const readings: CsipMirrorMeterReading[] = [];
  const add = (mRID: string, description: string, uom: CsipMirrorMeterReading['ReadingType']['uom'], value: number | undefined, multiplier = 0): void => {
    if (value === undefined) return;
    readings.push({
      mRID,
      description,
      ReadingType: { uom, dataQualifier: 12, powerOfTenMultiplier: multiplier },
      Reading: { timePeriod: { start: sample.timestamp, duration: 0 }, value },
    });
  };
  add('csip-active-power', 'Active power', Uom.W, sample.activePowerW);
  add('csip-reactive-power', 'Reactive power', Uom.var, sample.reactivePowerVar);
  add('csip-frequency', 'Frequency', Uom.Hz, sample.frequencyHz === undefined ? undefined : Math.round(sample.frequencyHz * 100), -2);
  add('csip-voltage', 'Phase voltage', Uom.Voltage, sample.voltageV === undefined ? undefined : Math.round(sample.voltageV * 10), -1);
  return readings;
}

function statusPayload(sample: TelemetrySample): CsipDerStatus {
  const status = sample.status!;
  return {
    readingTime: sample.timestamp,
    ...(status.operationalMode !== undefined ? { operationalModeStatus: { value: status.operationalMode } } : {}),
    ...(status.connectionStatus !== undefined ? { genConnectStatus: { value: status.connectionStatus } } : {}),
    ...(status.alarms !== undefined ? { alarmStatus: { value: status.alarms } } : {}),
    ...(status.stateOfChargePercent !== undefined ? { stateOfChargeStatus: { value: status.stateOfChargePercent } } : {}),
    ...(status.storageConnectionStatus !== undefined ? { storConnectStatus: { value: status.storageConnectionStatus } } : {}),
  };
}

function capabilityPayload(sample: TelemetrySample): CsipDerCapability {
  const capability = sample.capability!;
  return {
    ...(capability.maxPowerW !== undefined ? { rtgMaxW: capability.maxPowerW } : {}),
    ...(capability.maxEnergyWh !== undefined ? { rtgMaxWh: capability.maxEnergyWh } : {}),
    ...(capability.maxAmpHours !== undefined ? { rtgMaxAh: capability.maxAmpHours } : {}),
    ...(capability.maxChargeW !== undefined ? { rtgMaxChargeRateW: capability.maxChargeW } : {}),
    ...(capability.maxDischargeW !== undefined ? { rtgMaxDischargeRateW: capability.maxDischargeW } : {}),
  };
}

function emptyResult(): TelemetryPublishResult {
  return { queued: 0, sent: 0, retryableFailures: 0, quarantined: 0, backpressured: 0 };
}

function addResult(target: TelemetryPublishResult, source: TelemetryPublishResult): void {
  target.queued += source.queued;
  target.sent += source.sent;
  target.retryableFailures += source.retryableFailures;
  target.quarantined += source.quarantined;
  target.backpressured += source.backpressured;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
