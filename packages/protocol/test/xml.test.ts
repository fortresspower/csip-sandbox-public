import { describe, it, expect } from 'vitest';
import {
  parseDERControlList,
  serializeDERProgram,
  serializeDERProgramList,
  serializeDeviceCapability,
  serializeEndDevice,
  serializeEndDeviceList,
  serializeFunctionSetAssignments,
  serializeFunctionSetAssignmentsList,
  serializeMirrorMeterReading,
} from '../src/xml.js';
import { Uom } from '../src/uom.js';

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
  <DERControl><mRID>EE01</mRID><creationTime>10</creationTime>
    <EventStatus><currentStatus>1</currentStatus></EventStatus>
    <interval><start>20</start><duration>600</duration></interval>
    <DERControlBase><opModMaxLimW>5000</opModMaxLimW></DERControlBase>
  </DERControl>
</DERControlList>`;
    const list = parseDERControlList(xml);
    expect(list.items).toHaveLength(1);
    expect(list.items[0].DERControlBase.opModMaxLimW).toBe(5000);
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

  it('serializes DeviceCapability and EndDevice discovery links', () => {
    const dcap = serializeDeviceCapability({
      href: '/dcap',
      pollRate: 30,
      EndDeviceListLink: { href: '/edev', all: 1 },
      MirrorUsagePointListLink: { href: '/mup' },
      TimeLink: { href: '/tm' },
    });
    const endDevice = serializeEndDevice({
      href: '/edev/0',
      lFDI: '00112233445566778899AABBCCDDEEFF00112233',
      sFDI: '111111111111',
      changedTime: 1514836800,
      enabled: true,
      FunctionSetAssignmentsListLink: { href: '/edev/0/fsa', all: 1 },
    });

    expect(dcap).toContain('<EndDeviceListLink href="/edev" all="1"/>');
    expect(endDevice).toContain('<lFDI>00112233445566778899AABBCCDDEEFF00112233</lFDI>');
    expect(endDevice).toContain('<FunctionSetAssignmentsListLink href="/edev/0/fsa" all="1"/>');
    expect(dcap.indexOf('<TimeLink')).toBeLessThan(dcap.indexOf('<EndDeviceListLink'));
    expect(dcap.indexOf('<EndDeviceListLink')).toBeLessThan(dcap.indexOf('<MirrorUsagePointListLink'));
    expect(endDevice.indexOf('<sFDI>')).toBeLessThan(endDevice.indexOf('<changedTime>'));
    expect(endDevice.indexOf('<changedTime>')).toBeLessThan(endDevice.indexOf('<enabled>'));
  });

  it('serializes paged EndDevice, FSA, and DERProgram lists', () => {
    const endDevices = serializeEndDeviceList({
      href: '/edev',
      all: 2,
      results: 1,
      pollRate: 30,
      nextHref: '/edev?s=1&l=1',
      items: [{
        href: '/edev/0',
        lFDI: '00112233445566778899AABBCCDDEEFF00112233',
        sFDI: '111111111111',
        changedTime: 1514836800,
        enabled: true,
        FunctionSetAssignmentsListLink: { href: '/edev/0/fsa', all: 1 },
      }],
    });
    const fsa = {
      href: '/edev/0/fsa/0',
      mRID: '00112233445566778899AABBCCDDEEFF',
      DERProgramListLink: { href: '/edev/0/fsa/0/derp', all: 1 },
      TimeLink: { href: '/tm' },
    };
    const assignments = serializeFunctionSetAssignmentsList({
      href: '/edev/0/fsa',
      all: 1,
      results: 1,
      pollRate: 30,
      items: [fsa],
    });
    const program = {
      href: '/derp/0',
      mRID: 'AABBCCDDEEFF00112233445566778899',
      primacy: 0,
      DERControlListLink: { href: '/derp/0/derc' },
    };
    const programs = serializeDERProgramList({
      href: '/edev/0/fsa/0/derp',
      all: 1,
      results: 1,
      pollRate: 30,
      items: [program],
    });

    expect(endDevices).toContain('all="2" results="1" pollRate="30"');
    expect(endDevices).toContain('<Link rel="next" href="/edev?s=1&amp;l=1"/>');
    expect(assignments).toContain('<FunctionSetAssignments href="/edev/0/fsa/0">');
    expect(programs).toContain('<DERProgram href="/derp/0">');
    const fsaXml = serializeFunctionSetAssignments(fsa);
    const programXml = serializeDERProgram(program);
    expect(fsaXml).toContain('<DERProgramListLink');
    expect(fsaXml.indexOf('<DERProgramListLink')).toBeLessThan(fsaXml.indexOf('<TimeLink'));
    expect(fsaXml.indexOf('<TimeLink')).toBeLessThan(fsaXml.indexOf('<mRID>'));
    expect(programXml).toContain('<primacy>0</primacy>');
    expect(programXml.indexOf('<DERControlListLink')).toBeLessThan(programXml.indexOf('<primacy>'));
  });
});
