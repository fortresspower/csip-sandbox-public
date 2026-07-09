import { describe, it, expect } from 'vitest';
import { serializeMirrorMeterReading, parseDERControlList } from '../src/xml.js';
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
});
