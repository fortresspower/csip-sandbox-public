/** Client-core-owned CSIP wire shapes. The release declarations never depend on the protocol workspace. */
export type CsipUomCode = 0 | 5 | 29 | 33 | 38 | 61 | 63 | 65 | 72;

export interface CsipDeviceCapability {
  pollRate: number;
  EndDeviceListLink?: string;
  MirrorUsagePointListLink?: string;
  TimeLink?: string;
}

export interface CsipEndDevice {
  href?: string;
  lFDI: string;
  FunctionSetAssignmentsListLink?: string;
  DERListLink?: string;
}

export interface CsipFunctionSetAssignments {
  href?: string;
  mRID: string;
  DERProgramListLink?: string;
}

export interface CsipDerProgram {
  href?: string;
  mRID: string;
  primacy: number;
  DERControlListLink?: string;
}

export interface CsipDerControlBase {
  opModConnect?: boolean;
  opModMaxLimW?: number;
  opModFixedW?: number;
}

export interface CsipEventStatus {
  currentStatus: number;
  dateTime?: number;
  potentiallySuperseded?: boolean;
  potentiallySupersededTime?: number;
}

export interface CsipDateTimeInterval {
  start: number;
  duration: number;
}

export interface CsipDerControl {
  href?: string;
  replyTo?: string;
  responseRequired: string;
  mRID: string;
  creationTime: number;
  EventStatus: CsipEventStatus;
  interval: CsipDateTimeInterval;
  DERControlBase: CsipDerControlBase;
}

export type CsipResponseStatus =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14
  | 252 | 253 | 254;

export interface CsipDerControlResponse {
  createdDateTime: number;
  endDeviceLFDI: string;
  status: CsipResponseStatus;
  subject: string;
}

export interface CsipDerStatus {
  readingTime: number;
  operationalModeStatus?: { value: number };
  genConnectStatus?: { value: number };
  alarmStatus?: { value: number };
  stateOfChargeStatus?: { value: number };
  storConnectStatus?: { value: number };
}

export interface CsipDerCapability {
  rtgMaxW?: number;
  rtgMaxWh?: number;
  rtgMaxAh?: number;
  rtgMaxChargeRateW?: number;
  rtgMaxDischargeRateW?: number;
}

export interface CsipDer {
  href?: string;
  DERStatusLink?: string;
  DERCapabilityLink?: string;
}

export interface CsipReadingType {
  uom: CsipUomCode;
  kind?: number;
  dataQualifier?: number;
  flowDirection?: number;
  powerOfTenMultiplier?: number;
  mRID?: string;
}

export interface CsipReading {
  timePeriod: CsipDateTimeInterval;
  value: number;
}

export interface CsipMirrorMeterReading {
  mRID: string;
  description?: string;
  ReadingType: CsipReadingType;
  Reading: CsipReading;
}

export interface CsipMirrorUsagePoint {
  href?: string;
  mRID: string;
  description?: string;
  postRate?: number;
  deviceLFDI: string;
  MirrorMeterReadings: CsipMirrorMeterReading[];
}
