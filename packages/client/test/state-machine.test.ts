import { describe, it, expect, vi } from 'vitest';
import { SyntheticGenerator } from '../src/generator.js';
import { CsipClient, type Transport } from '../src/state-machine.js';

function fakeTransport(controlXml: string): Transport & { posted: { path: string; xml: string }[] } {
  const posted: { path: string; xml: string }[] = [];
  return {
    posted,
    async get(path) { return path.includes('derc') ? controlXml : '<x/>'; },
    async post(path, xml) { posted.push({ path, xml }); return { status: 201, location: '/mup/0/mr/0' }; },
    async put(path, xml) { posted.push({ path, xml }); return { status: 204 }; },
  };
}

describe('CsipClient', () => {
  it('posts subscribed telemetry points and applies a polled control', async () => {
    const g = new SyntheticGenerator({ lFDI: 'S', nameplateW: 5000, capacityWh: 13500, initialSoC: 50 });
    const control = `<?xml version="1.0"?><DERControlList xmlns="urn:ieee:std:2030.5:ns" all="1" results="1">
      <DERControl><mRID>E1</mRID><creationTime>1</creationTime><EventStatus><currentStatus>1</currentStatus></EventStatus>
      <interval><start>1</start><duration>600</duration></interval><DERControlBase><opModFixedW>-3000</opModFixedW></DERControlBase></DERControl></DERControlList>`;
    const t = fakeTransport(control);
    const client = new CsipClient({ generator: g, transport: t, subscription: ['model101.W'], mupHref: '/mup/0' });

    await client.pollAndApplyControl();
    expect(g.snapshot().realPowerW).toBeLessThan(0);          // discharge applied
    expect(t.posted.some((p) => p.path.includes('rsps') || p.xml.includes('DERControlResponse'))).toBe(true);

    await client.postTelemetry();
    const mmrPosts = t.posted.filter((p) => p.xml.includes('MirrorMeterReading'));
    expect(mmrPosts.length).toBeGreaterThanOrEqual(1);
  });

  it('declares a powerOfTenMultiplier so a scaled reading decodes to the real quantity', async () => {
    const g = new SyntheticGenerator({ lFDI: 'S', nameplateW: 5000, capacityWh: 13500, initialSoC: 50 });
    const t = fakeTransport('<x/>');
    const client = new CsipClient({ generator: g, transport: t, subscription: ['model101.Hz'], mupHref: '/mup/0' });

    await client.postTelemetry();
    const hz = t.posted.find((p) => p.xml.includes('MirrorMeterReading'))!;
    const value = Number(hz.xml.match(/<value>(-?\d+)<\/value>/)![1]);
    const multiplier = Number(hz.xml.match(/<powerOfTenMultiplier>(-?\d+)<\/powerOfTenMultiplier>/)![1]);
    expect(multiplier).toBe(-2);
    expect(value * 10 ** multiplier).toBeCloseTo(g.snapshot().frequencyHz, 1);
  });

  it('batches all subscribed readings into a single MirrorMeterReadingList POST to the MUP', async () => {
    const g = new SyntheticGenerator({ lFDI: 'S', nameplateW: 5000, capacityWh: 13500, initialSoC: 50 });
    const t = fakeTransport('<x/>');
    const client = new CsipClient({ generator: g, transport: t, subscription: ['model101.W', 'model101.VAr', 'model101.Hz'], mupHref: '/mup/0' });

    await client.postTelemetry();
    expect(t.posted).toHaveLength(1);                       // one POST, not three
    const post = t.posted[0];
    expect(post.path).toBe('/mup/0');                       // to the MUP resource, not /mup/0/mr
    expect(post.xml).toContain('<MirrorMeterReadingList');
    expect(post.xml).toContain('results="3"');
    expect((post.xml.match(/<MirrorMeterReading>/g) || []).length).toBe(3);
  });

  it('posts a subscribed Fortress extension point carrying its fortress:* mRID on the wire', async () => {
    const g = new SyntheticGenerator({ lFDI: 'S', nameplateW: 5000, capacityWh: 13500, initialSoC: 50 });
    const t = fakeTransport('<x/>');
    const client = new CsipClient({ generator: g, transport: t, subscription: ['model40101.sohBat'], mupHref: '/mup/0' });

    await client.postTelemetry();
    const soh = t.posted.find((p) => p.xml.includes('MirrorMeterReading'));
    expect(soh).toBeDefined();
    expect(soh!.xml).toContain('<mRID>fortress:soh</mRID>'); // ReadingType convention mRID
    expect(soh!.xml).toContain('<uom>0</uom>');              // SoH % has no 2030.5 UomType
  });
});
