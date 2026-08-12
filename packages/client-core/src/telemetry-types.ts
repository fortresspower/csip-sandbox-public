import type { CsipUomCode } from './wire-types.js';

export interface TelemetryStatusSample {
  operationalMode?: number;
  connectionStatus?: number;
  alarms?: number;
  stateOfChargePercent?: number;
  storageConnectionStatus?: number;
}

export interface TelemetryCapabilitySample {
  maxPowerW?: number;
  maxEnergyWh?: number;
  maxAmpHours?: number;
  maxChargeW?: number;
  maxDischargeW?: number;
}

export interface ExtensionTelemetryPoint {
  mRID: `fortress:${string}`;
  value: number;
  uom: CsipUomCode;
  powerOfTenMultiplier?: number;
}

export interface TelemetrySample {
  timestamp: number;
  activePowerW?: number;
  reactivePowerVar?: number;
  frequencyHz?: number;
  voltageV?: number;
  status?: TelemetryStatusSample;
  capability?: TelemetryCapabilitySample;
  extensions?: ExtensionTelemetryPoint[];
}

export interface TelemetrySource {
  read(lFDI: string): Promise<TelemetrySample>;
}

export interface TelemetryProfile {
  lFDI: string;
  intervalSeconds: number;
  rateClamped: boolean;
  standardMupHref: string;
  standardMupMrid: string;
  extensionMupHref?: string;
  extensionMupMrid?: string;
  extensionIntervalSeconds?: number;
  derStatusHref?: string;
  derCapabilityHref?: string;
}

export interface TelemetryPublishResult {
  queued: number;
  sent: number;
  retryableFailures: number;
  quarantined: number;
}

export interface TelemetryQuarantineEntry {
  lFDI: string;
  timestamp?: number;
  jobId?: string;
  reason: string;
}
