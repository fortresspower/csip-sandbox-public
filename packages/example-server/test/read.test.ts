import { describe, it, expect } from 'vitest';
import { Store } from '../src/store.js';
import { seedBackfill } from '../src/backfill.js';
import request from 'supertest';
import { makeApp } from '../src/index.js';

describe('backfill', () => {
  it('seeds ~24h of 5-min readings for the default subscription, split across MUPs', () => {
    const s = new Store();
    seedBackfill(s, { now: 1_000_000 /* epoch-seconds */, hours: 24, stepSec: 300 });
    const std = s.readReadings({ mup: 0, start: 0, limit: 100000 });
    const ext = s.readReadings({ mup: 1, start: 0, limit: 100000 });
    expect(std.all).toBeGreaterThan(0);
    expect(ext.all).toBeGreaterThan(0);
    // 24h / 5min = 288 samples per point; oldest ts is ~24h before now
    const oldest = Math.min(...std.items.map((r) => r.ts));
    expect(1_000_000 - oldest).toBeGreaterThanOrEqual(24 * 3600 - 300);
  });
});

describe('backfill wiring', () => {
  it('makeApp seeds history so a fresh read is non-empty', async () => {
    const { app } = makeApp({ console: false });
    const r = await request(app).get('/mup/0/mr?s=0&l=1');
    const all = Number(/all="(\d+)"/.exec(r.text)?.[1] ?? '0');
    expect(all).toBeGreaterThan(100);
  });
  it('POST /test/reset reseeds (history present again after reset)', async () => {
    const { app } = makeApp({ console: false });
    await request(app).post('/test/reset');
    const r = await request(app).get('/mup/0/mr?s=0&l=1');
    const all = Number(/all="(\d+)"/.exec(r.text)?.[1] ?? '0');
    expect(all).toBeGreaterThan(100);
  });
});

describe('POSTed readings become readable', () => {
  it('a posted MirrorMeterReadingList is returned by GET /mup/0/mr (mrid-filtered)', async () => {
    const { app } = makeApp({ console: false });
    const body = `<MirrorMeterReadingList xmlns="urn:ieee:std:2030.5:ns"><MirrorMeterReading><mRID>liveTestPoint</mRID><description>model999.live</description><ReadingType><uom>38</uom></ReadingType><Reading><timePeriod><start>1780500000</start><duration>0</duration></timePeriod><value>4242</value></Reading></MirrorMeterReading></MirrorMeterReadingList>`;
    await request(app).post('/mup/0').set('Content-Type', 'application/sep+xml').send(body);
    const r = await request(app).get('/mup/0/mr?s=0&l=10&mrid=liveTestPoint');
    expect(r.text).toContain('all="1"');
    expect(r.text).toContain('<value>4242</value>');
  });
});

describe('GET /mup/:m/mr', () => {
  it('returns a paged MirrorMeterReadingList with all/results and a next Link', async () => {
    const { app, store } = makeApp({ console: false });
    for (let i = 0; i < 5; i++) store.addReading({ ts: 100 + i, mup: 0, mrid: 'testOnlyMrid', point: 'model101.W', uom: 38, value: i });
    const r = await request(app).get('/mup/0/mr?s=0&l=2&mrid=testOnlyMrid');
    expect(r.status).toBe(200);
    expect(r.text).toContain('all="5"');
    expect(r.text).toContain('results="2"');
    expect(r.text).toContain('rel="next"');
    expect(r.text).toContain('s=2');
  });
  it('omits the next Link on the last page', async () => {
    const { app, store } = makeApp({ console: false });
    store.addReading({ ts: 1, mup: 0, mrid: 'testOnlyMridSingle', point: 'p', uom: 0, value: 1 });
    const r = await request(app).get('/mup/0/mr?s=0&l=50&mrid=testOnlyMridSingle');
    expect(r.text).not.toContain('rel="next"');
  });
  it('returns a stored reading on its MUP', async () => {
    const { app, store } = makeApp({ console: false });
    store.addReading({ ts: 1, mup: 1, mrid: 'fortress:soh', point: 'model40101.sohBat', uom: 0, value: 98 });
    const r = await request(app).get('/mup/1/mr?s=0&l=50&mrid=fortress%3Asoh');
    expect(r.text).toContain('fortress:soh');
    expect(r.text).toContain('<value>98</value>');   // the stored value
  });

  it('synthesizes a series for any requested mRID with no stored data (no subscription gate)', async () => {
    const { app } = makeApp({ console: false });
    const r = await request(app).get('/mup/1/mr?s=0&l=5&mrid=fortress%3A40104-anything');
    const all = Number(/all="(\d+)"/.exec(r.text)?.[1] ?? '0');
    expect(all).toBeGreaterThan(100);                // ~288 synthesized 5-min samples over 24h
    expect(r.text).toContain('fortress:40104-anything');
    // a read with NO mrid filter is stored-only (no synth) — unchanged behaviour
    const none = await request(app).get('/mup/1/mr?s=0&l=5');
    expect(none.text).not.toContain('fortress:40104-anything');
  });
});
