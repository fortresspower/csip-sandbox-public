import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  parseDERCapability,
  parseDERControlList,
  parseDERControlResponse,
  parseDERProgramList,
  parseDERStatus,
  parseDeviceCapability,
  parseEndDeviceList,
  parseFunctionSetAssignmentsList,
  parseMirrorUsagePoint,
  serializeDERCapability,
  serializeDERControlResponse,
  serializeDERStatus,
  serializeMirrorMeterReading,
  serializeMirrorUsagePoint,
} from '../src/xml.js';
import { Uom } from '../src/uom.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

describe('xml', () => {
  it('serializes a MirrorMeterReading with the 2030.5 namespace and ReadingType', () => {
    const xml = serializeMirrorMeterReading({
      mRID: 'AABB', description: 'Real Power(W)',
      ReadingType: { uom: Uom.W, flowDirection: 1, powerOfTenMultiplier: 0 },
      Reading: { timePeriod: { start: 1000, duration: 0 }, value: 4200 },
    });
    expect(xml).toContain('xmlns="urn:ieee:std:2030.5:ns"');
    expect(xml).toContain('<uom>38</uom>');
    expect(xml).toContain('<value>4200</value>');
  });

  it('parses a DERControlList into typed DERControls', () => {
    const xml = `<?xml version="1.0"?>
<DERControlList xmlns="urn:ieee:std:2030.5:ns" all="1" results="1">
  <DERControl replyTo="/responses/random" responseRequired="03"><mRID>EE01</mRID><creationTime>10</creationTime>
    <EventStatus><currentStatus>1</currentStatus><dateTime>11</dateTime><potentiallySuperseded>false</potentiallySuperseded></EventStatus>
    <interval><start>20</start><duration>600</duration></interval>
    <DERControlBase><opModMaxLimW>5000</opModMaxLimW></DERControlBase>
  </DERControl>
</DERControlList>`;
    const list = parseDERControlList(xml);
    expect(list.items).toHaveLength(1);
    expect(list.items[0].DERControlBase.opModMaxLimW).toBe(5000);
    expect(list.items[0]).toMatchObject({
      replyTo: '/responses/random',
      responseRequired: '03',
      EventStatus: { currentStatus: 1, dateTime: 11, potentiallySuperseded: false },
    });
  });

  it('preserves a numeric-looking mRID exactly (no lossy number coercion)', () => {
    const xml = `<?xml version="1.0"?>
<DERControlList xmlns="urn:ieee:std:2030.5:ns" all="1" results="1">
  <DERControl><mRID>1000000000000001</mRID><creationTime>10</creationTime>
    <EventStatus><currentStatus>1</currentStatus></EventStatus>
    <interval><start>20</start><duration>600</duration></interval>
    <DERControlBase><opModMaxLimW>5000</opModMaxLimW></DERControlBase>
  </DERControl>
</DERControlList>`;
    const list = parseDERControlList(xml);
    expect(list.items[0].mRID).toBe('1000000000000001');
  });

  it('parses a path-randomized discovery graph and list metadata', () => {
    const capability = parseDeviceCapability(fixture('device-capability.xml'));
    expect(capability).toEqual({
      pollRate: 30,
      EndDeviceListLink: '/partner/end-devices-v2',
      MirrorUsagePointListLink: '/metering/mirrors-green',
      TimeLink: '/clock/current',
    });

    const endDevices = parseEndDeviceList(fixture('end-device-list.xml'));
    expect(endDevices).toMatchObject({
      all: 2,
      results: 1,
      pollRate: 45,
      nextHref: '/partner/end-devices-v2?s=1',
    });
    expect(endDevices.items[0]).toEqual({
      href: '/partner/end-devices-v2/hilda-alpha',
      lFDI: '0123456789abcdef0123456789abcdef01234567',
      FunctionSetAssignmentsListLink: '/assignments/summer-a',
      DERListLink: '/devices/hilda-alpha/ders',
    });

    const assignments = parseFunctionSetAssignmentsList(fixture('fsa-list.xml'));
    expect(assignments.items[0]).toEqual({
      href: '/assignments/summer-a/primary',
      mRID: 'FSA-HILDA-A',
      DERProgramListLink: '/programs/blue-fleet',
    });

    const programs = parseDERProgramList(fixture('der-program-list.xml'));
    expect(programs.items[0]).toEqual({
      href: '/programs/blue-fleet/dispatch',
      mRID: 'PROGRAM-BLUE',
      primacy: 2,
      DERControlListLink: '/controls/program-blue',
    });

    const controls = parseDERControlList(fixture('der-control-list.xml'));
    expect(controls).toMatchObject({ all: 3, results: 1, pollRate: 15, nextHref: '/controls/program-blue?s=1' });
    expect(controls.items[0]).toMatchObject({ href: '/controls/program-blue/control-A', mRID: 'CONTROL-A' });
  });

  it('round-trips lifecycle and standard telemetry resources', () => {
    const response = {
      createdDateTime: 1_725_000_000,
      endDeviceLFDI: '0123456789abcdef0123456789abcdef01234567',
      status: 3 as const,
      subject: 'CONTROL-A',
    };
    expect(parseDERControlResponse(serializeDERControlResponse(response))).toEqual(response);

    const usagePoint = {
      mRID: 'MUP-HILDA-A',
      description: 'HILDA standard lane',
      postRate: 300,
      deviceLFDI: response.endDeviceLFDI,
      MirrorMeterReadings: [{
        mRID: 'REAL-POWER',
        ReadingType: { uom: Uom.W, dataQualifier: 12, powerOfTenMultiplier: 0 },
        Reading: { timePeriod: { start: 1_725_000_000, duration: 60 }, value: -3000 },
      }],
    };
    expect(parseMirrorUsagePoint(serializeMirrorUsagePoint(usagePoint))).toEqual(usagePoint);

    const status = {
      readingTime: 1_725_000_001,
      operationalModeStatus: { value: 2 },
      genConnectStatus: { value: 1 },
      alarmStatus: { value: 0 },
      stateOfChargeStatus: { value: 5500 },
      storConnectStatus: { value: 1 },
    };
    expect(parseDERStatus(serializeDERStatus(status))).toEqual(status);

    const capability = {
      rtgMaxW: 12_000,
      rtgMaxWh: 20_000,
      rtgMaxChargeRateW: 8_000,
      rtgMaxDischargeRateW: 10_000,
    };
    expect(parseDERCapability(serializeDERCapability(capability))).toEqual(capability);
  });

  it('rejects hostile, ambiguous, malformed, and oversized XML', () => {
    expect(() => parseDeviceCapability('<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><DeviceCapability/>'))
      .toThrow(/DTD|entity/i);

    expect(() => parseDERControlList(`<DERControlList xmlns="urn:ieee:std:2030.5:ns">
      <DERControl><mRID>A</mRID><creationTime>not-a-number</creationTime>
        <EventStatus><currentStatus>1</currentStatus></EventStatus>
        <interval><start>20</start><duration>60</duration></interval><DERControlBase/>
      </DERControl></DERControlList>`)).toThrow(/creationTime/i);

    expect(() => parseDERControlList(`<DERControlList xmlns="urn:ieee:std:2030.5:ns">
      <DERControl><mRID>A</mRID><mRID>B</mRID><creationTime>1</creationTime>
        <EventStatus><currentStatus>1</currentStatus></EventStatus>
        <interval><start>20</start><duration>60</duration></interval><DERControlBase/>
      </DERControl></DERControlList>`)).toThrow(/mRID.*singleton/i);

    expect(() => parseDeviceCapability(
      '<DeviceCapability><pollRate>30</pollRate></DeviceCapability>',
      { maxBytes: 16 },
    )).toThrow(/size limit/i);

    expect(() => parseDeviceCapability(
      '<DeviceCapability xmlns="urn:not-ieee"><pollRate>30</pollRate></DeviceCapability>',
    )).toThrow(/2030\.5 XML namespace/i);
  });
});
