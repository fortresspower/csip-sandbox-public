import {
  Uom,
} from '@fortress-csip/protocol';
import { CsipError } from './types.js';
import { isCanonicalLfdi } from './identity.js';
import { CsipDiscoveryError, ResourceClient } from './resource-client.js';
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

export const MIN_TELEMETRY_INTERVAL_SECONDS = 300;

type TelemetryJob =
  | { id: string; lFDI: string; timestamp: number; kind: 'mup'; href: string; payload: CsipMirrorUsagePoint }
  | { id: string; lFDI: string; timestamp: number; kind: 'status'; href: string; payload: CsipDerStatus }
  | { id: string; lFDI: string; timestamp: number; kind: 'capability'; href: string; payload: CsipDerCapability };

interface TelemetryLanes {
  standard: boolean;
  extensions: boolean;
}

export interface TelemetryPublisherOptions {
  resources: ResourceClient;
  source: TelemetrySource;
  now?: () => number;
  maxQueue?: number;
}

export class TelemetryPublisher {
  readonly #resources: ResourceClient;
  readonly #source: TelemetrySource;
  readonly #now: () => number;
  readonly #maxQueue: number;
  readonly #pending = new Map<string, TelemetryJob>();
  readonly #completed = new Set<string>();
  readonly #quarantine: TelemetryQuarantineEntry[] = [];
  readonly #lastRun = new Map<string, number>();

  constructor(options: TelemetryPublisherOptions) {
    this.#resources = options.resources;
    this.#source = options.source;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000));
    this.#maxQueue = options.maxQueue ?? 256;
    if (!Number.isSafeInteger(this.#maxQueue) || this.#maxQueue <= 0) {
      throw new CsipDiscoveryError('maxQueue must be a positive safe integer');
    }
  }

  async discover(deviceCapabilityHref: string, eligibleLFDIs: ReadonlySet<string>): Promise<TelemetryProfile[]> {
    const capability = await this.#resources.deviceCapability(deviceCapabilityHref);
    if (!capability.EndDeviceListLink || !capability.MirrorUsagePointListLink) {
      throw new CsipDiscoveryError('telemetry discovery requires EndDeviceListLink and MirrorUsagePointListLink');
    }
    const [endDevices, usagePoints] = await Promise.all([
      this.#resources.endDevices(capability.EndDeviceListLink),
      this.#resources.mirrorUsagePoints(capability.MirrorUsagePointListLink),
    ]);
    const profiles: TelemetryProfile[] = [];
    for (const lFDI of eligibleLFDIs) {
      if (!isCanonicalLfdi(lFDI)) throw new CsipDiscoveryError(`eligible telemetry LFDI is invalid: ${lFDI}`);
      const devices = endDevices.filter((device) => device.lFDI === lFDI);
      if (devices.length !== 1) throw new CsipDiscoveryError(`telemetry requires one EndDevice for LFDI ${lFDI}`);
      const matching = usagePoints.filter((usagePoint) => usagePoint.deviceLFDI === lFDI);
      const standard = matching.filter((usagePoint) => !usagePoint.mRID.startsWith('fortress:'));
      const extensions = matching.filter((usagePoint) => usagePoint.mRID.startsWith('fortress:'));
      if (standard.length !== 1 || extensions.length > 1) {
        throw new CsipDiscoveryError(`telemetry MUP routes are missing or ambiguous for LFDI ${lFDI}`);
      }
      if (!standard[0].href) throw new CsipDiscoveryError(`standard MUP has no href for LFDI ${lFDI}`);
      if (extensions[0] && !extensions[0].href) {
        throw new CsipDiscoveryError(`extension MUP has no href for LFDI ${lFDI}`);
      }
      this.#resources.canonicalHref(standard[0].href);
      if (extensions[0]?.href) this.#resources.canonicalHref(extensions[0].href);
      const advertisedRate = standard[0].postRate ?? MIN_TELEMETRY_INTERVAL_SECONDS;
      if (!Number.isSafeInteger(advertisedRate) || advertisedRate <= 0) {
        throw new CsipDiscoveryError(`standard MUP has invalid postRate for LFDI ${lFDI}`);
      }
      const extensionAdvertisedRate = extensions[0]?.postRate ?? MIN_TELEMETRY_INTERVAL_SECONDS;
      if (!Number.isSafeInteger(extensionAdvertisedRate) || extensionAdvertisedRate <= 0) {
        throw new CsipDiscoveryError(`extension MUP has invalid postRate for LFDI ${lFDI}`);
      }

      let derStatusHref: string | undefined;
      let derCapabilityHref: string | undefined;
      if (devices[0].DERListLink) {
        const ders = await this.#resources.ders(devices[0].DERListLink);
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
      profiles.push({
        lFDI,
        intervalSeconds: Math.max(MIN_TELEMETRY_INTERVAL_SECONDS, advertisedRate),
        rateClamped: advertisedRate < MIN_TELEMETRY_INTERVAL_SECONDS,
        standardMupHref: standard[0].href,
        standardMupMrid: standard[0].mRID,
        ...(extensions[0]?.href ? {
          extensionMupHref: extensions[0].href,
          extensionMupMrid: extensions[0].mRID,
          extensionIntervalSeconds: Math.max(MIN_TELEMETRY_INTERVAL_SECONDS, extensionAdvertisedRate),
        } : {}),
        ...(derStatusHref ? { derStatusHref } : {}),
        ...(derCapabilityHref ? { derCapabilityHref } : {}),
      });
    }
    return profiles;
  }

  async runDue(profiles: readonly TelemetryProfile[]): Promise<TelemetryPublishResult> {
    const total = emptyResult();
    for (const profile of profiles) {
      const now = this.#now();
      const standardKey = `${profile.lFDI}:standard`;
      const extensionKey = `${profile.lFDI}:extensions`;
      const standardDue = isDue(this.#lastRun.get(standardKey), now, profile.intervalSeconds);
      const extensionsDue = profile.extensionMupHref !== undefined
        && isDue(this.#lastRun.get(extensionKey), now, profile.extensionIntervalSeconds ?? MIN_TELEMETRY_INTERVAL_SECONDS);
      if (!standardDue && !extensionsDue) continue;
      if (standardDue) this.#lastRun.set(standardKey, now);
      if (extensionsDue) this.#lastRun.set(extensionKey, now);
      addResult(total, await this.#publish(profile, { standard: standardDue, extensions: extensionsDue }));
    }
    return total;
  }

  async publish(profile: TelemetryProfile): Promise<TelemetryPublishResult> {
    return this.#publish(profile, { standard: true, extensions: true });
  }

  async #publish(profile: TelemetryProfile, lanes: TelemetryLanes): Promise<TelemetryPublishResult> {
    let jobs: TelemetryJob[];
    try {
      const sample = await this.#source.read(profile.lFDI);
      jobs = buildJobs(profile, validateSample(sample), lanes);
    } catch (error) {
      this.#quarantineEntry({ lFDI: profile.lFDI, reason: errorMessage(error) });
      return { ...emptyResult(), quarantined: 1 };
    }
    let queued = 0;
    let quarantined = 0;
    for (const job of jobs) {
      if (this.#pending.has(job.id) || this.#completed.has(job.id)) continue;
      if (this.#pending.size >= this.#maxQueue) {
        this.#quarantineEntry({ lFDI: job.lFDI, timestamp: job.timestamp, jobId: job.id, reason: 'telemetry queue is full' });
        quarantined += 1;
        continue;
      }
      this.#pending.set(job.id, job);
      queued += 1;
    }
    const flushed = await this.retryPending();
    return { queued, sent: flushed.sent, retryableFailures: flushed.retryableFailures, quarantined: quarantined + flushed.quarantined };
  }

  async retryPending(): Promise<TelemetryPublishResult> {
    const result = emptyResult();
    for (const job of [...this.#pending.values()]) {
      try {
        await this.#send(job);
        this.#pending.delete(job.id);
        this.#rememberCompleted(job.id);
        result.sent += 1;
      } catch (error) {
        if (error instanceof CsipError && error.retryable) {
          result.retryableFailures += 1;
          continue;
        }
        this.#pending.delete(job.id);
        this.#quarantineEntry({
          lFDI: job.lFDI,
          timestamp: job.timestamp,
          jobId: job.id,
          reason: errorMessage(error),
        });
        result.quarantined += 1;
      }
    }
    return result;
  }

  diagnostics(): { pending: number; quarantine: TelemetryQuarantineEntry[] } {
    return { pending: this.#pending.size, quarantine: structuredClone(this.#quarantine) };
  }

  async #send(job: TelemetryJob): Promise<void> {
    if (job.kind === 'mup') await this.#resources.postMirrorUsagePoint(job.href, job.payload);
    else if (job.kind === 'status') await this.#resources.putDerStatus(job.href, job.payload);
    else await this.#resources.putDerCapability(job.href, job.payload);
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

function isDue(lastRun: number | undefined, now: number, intervalSeconds: number): boolean {
  return lastRun === undefined || now - lastRun >= intervalSeconds;
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
  return { queued: 0, sent: 0, retryableFailures: 0, quarantined: 0 };
}

function addResult(target: TelemetryPublishResult, source: TelemetryPublishResult): void {
  target.queued += source.queued;
  target.sent += source.sent;
  target.retryableFailures += source.retryableFailures;
  target.quarantined += source.quarantined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
