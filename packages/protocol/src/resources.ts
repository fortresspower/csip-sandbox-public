import type { UomCode } from './uom.js';

export interface Sep2List<T> { all: number; results: number; items: T[]; }

export interface DeviceCapability {
  pollRate: number;
  EndDeviceListLink?: string;
  MirrorUsagePointListLink?: string;
  TimeLink?: string;
}

export interface FunctionSetAssignments {
  mRID: string;
  DERProgramListLink?: string;
}

export interface DERProgram { mRID: string; primacy: number; DERControlListLink?: string; }

/** v1 control modes only — connect/disconnect, max active power limit, fixed W setpoint. */
export interface DERControlBase {
  opModConnect?: boolean;   // BASIC-009
  opModMaxLimW?: number;    // BASIC-010, watts ceiling
  opModFixedW?: number;     // BASIC-013/014, signed watts setpoint (+ charge / - discharge)
}

export interface EventStatus { currentStatus: number; }
export interface DateTimeInterval { start: number; duration: number; }

export interface DERControl {
  mRID: string;
  creationTime: number;
  EventStatus: EventStatus;
  interval: DateTimeInterval;
  DERControlBase: DERControlBase;
}

export type ResponseStatus = 1 | 2 | 4 | 5 | 6;  // received/started/completed/declined/superseded (Table 27)
export interface DERControlResponse { createdDateTime: number; endDeviceLFDI: string; status: ResponseStatus; subject: string; }

export interface PercentType { value: number; }   // hundredths of a percent in spec; sandbox uses whole %
export interface DERStatus {
  readingTime: number;
  operationalModeStatus?: { value: number };
  genConnectStatus?: { value: number };
  alarmStatus?: { value: number };
  stateOfChargeStatus?: PercentType;   // storage only
  storConnectStatus?: { value: number };
}
export function isStorageDERStatus(s: DERStatus): boolean {
  return s.stateOfChargeStatus !== undefined;
}

export interface DERCapability {
  rtgMaxW?: number; rtgMaxWh?: number; rtgMaxAh?: number;
  rtgMaxChargeRateW?: number; rtgMaxDischargeRateW?: number;
}

export interface ReadingType {
  uom: UomCode;
  kind?: number;
  dataQualifier?: number;     // 0 none, 2 average, 8 max, 9 min, 12 instantaneous
  flowDirection?: number;     // 1 forward, 19 reverse
  powerOfTenMultiplier?: number;
  mRID?: string;              // carries fortress:* convention for extension points
}

export interface Reading { timePeriod: { start: number; duration: number }; value: number; }
export interface MirrorMeterReading { mRID: string; description?: string; ReadingType: ReadingType; Reading: Reading; }
export interface MirrorUsagePoint { mRID: string; description?: string; postRate?: number; deviceLFDI: string; MirrorMeterReadings: MirrorMeterReading[]; }

export interface ParsedReading { mRID: string; description?: string; uom: number; value: number; start: number; convention?: string; }
export interface MirrorMeterReadingListPage { items: MirrorMeterReading[]; all: number; results: number; nextHref?: string; }
export interface ParsedReadingPage { readings: ParsedReading[]; all: number; results: number; nextHref?: string; }
