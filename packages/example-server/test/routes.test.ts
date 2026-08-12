import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeApp } from '../src/index.js';

function meterReadingXml(mRID = 'test-reading', value = 1, convention?: string): string {
  return `<MirrorMeterReading xmlns="urn:ieee:std:2030.5:ns">
    <mRID>${mRID}</mRID>
    <ReadingType>${convention ? `<mRID>${convention}</mRID>` : ''}<uom>38</uom></ReadingType>
    <Reading><timePeriod><start>1</start><duration>0</duration></timePeriod><value>${value}</value></Reading>
  </MirrorMeterReading>`;
}

describe('routes', () => {
  it('serves a DeviceCapability with the 2030.5 namespace', async () => {
    const { app } = makeApp();
    const r = await request(app).get('/dcap');
    expect(r.status).toBe(200);
    expect(r.text).toContain('urn:ieee:std:2030.5:ns');
  });
  it('serves queued DERControls and accepts a MirrorMeterReading POST with 201 + Location', async () => {
    const { app, store } = makeApp();
    store.queueControl({ mRID: 'C1', opModFixedW: -3000 });
    const list = await request(app).get('/derp/0/derc');
    expect(list.text).toContain('opModFixedW');
    const post = await request(app).post('/mup/0/mr').set('Content-Type', 'application/sep+xml')
      .send(meterReadingXml());
    expect(post.status).toBe(201);
    expect(post.headers.location).toBeDefined();
    expect(store.meterReadings()).toHaveLength(1);
  });
  it('exposes /test/dercontrol to inject a dispatch', async () => {
    const { app, store } = makeApp();
    const r = await request(app).post('/test/dercontrol').set('Content-Type', 'application/json').send({ mRID: 'X', opModMaxLimW: 2000 });
    expect(r.status).toBe(202);
    expect(store.controls()).toHaveLength(1);
  });
  it('preserves injected control timing, status, and priority on the CSIP wire', async () => {
    const { app } = makeApp();
    await request(app).post('/test/dercontrol').set('Content-Type', 'application/json').send({
      mRID: 'scheduled-control',
      creationTime: 1786506240,
      eventStatus: 1,
      interval: { start: 1786506250, duration: 40 },
      primacy: 10,
      opModFixedW: -3000,
    });

    const list = await request(app).get('/derp/0/derc');
    expect(list.text).toContain('<creationTime>1786506240</creationTime>');
    expect(list.text).toContain('<currentStatus>1</currentStatus>');
    expect(list.text).toContain('<start>1786506250</start><duration>40</duration>');
    expect(list.text).toContain('<primacy>10</primacy>');
  });
  it('rejects a /test/dercontrol injection with no mRID', async () => {
    const { app, store } = makeApp();
    const r = await request(app).post('/test/dercontrol').set('Content-Type', 'application/json').send({ opModMaxLimW: 2000 });
    expect(r.status).toBe(400);
    expect(store.controls()).toHaveLength(0);
  });
  it('accepts a DERStatus PUT with 204 and stores it', async () => {
    const { app, store } = makeApp();
    const put = await request(app).put('/edev/0/der/0/ders').set('Content-Type', 'application/sep+xml').send('<DERStatus/>');
    expect(put.status).toBe(204);
    expect(store.derStatuses()).toHaveLength(1);
  });

  it('accepts a batched MirrorMeterReadingList POST to the MUP and stores each reading', async () => {
    const { app, store } = makeApp();
    const list = '<?xml version="1.0"?><MirrorMeterReadingList xmlns="urn:ieee:std:2030.5:ns" all="2" results="2">'
      + meterReadingXml('a', 1).replace(/ xmlns="[^"]+"/, '')
      + meterReadingXml('b', -2).replace(/ xmlns="[^"]+"/, '')
      + '</MirrorMeterReadingList>';
    const r = await request(app).post('/mup/0').set('Content-Type', 'application/sep+xml').send(list);
    expect(r.status).toBe(201);
    expect(store.meterReadings()).toHaveLength(2);          // unpacked into individual readings
    const wire = await request(app).get('/test/wire');
    const post = wire.body.find((e: { dir: string; label: string }) => e.dir === 'post')!;
    expect(post.label).toContain('2 readings');
  });
  it('does not replay an already-served DERControl on a second poll', async () => {
    const { app, store } = makeApp();
    store.queueControl({ mRID: 'C1', opModFixedW: -3000 });
    const first = await request(app).get('/derp/0/derc');
    expect(first.text).toContain('opModFixedW');
    const second = await request(app).get('/derp/0/derc');
    expect(second.text).not.toContain('opModFixedW');
    expect(store.controls()).toHaveLength(0);
  });
  it('does not mount the /test admin surface when admin is disabled', async () => {
    const { app } = makeApp({ admin: false });
    expect((await request(app).get('/test/meter-readings')).status).toBe(404);
    expect((await request(app).post('/test/dercontrol').set('Content-Type', 'application/json').send({ mRID: 'X' })).status).toBe(404);
  });
  it('resets all stores via /test/reset', async () => {
    const { app, store } = makeApp();
    store.queueControl({ mRID: 'C1' });
    store.addMeterReading('<MirrorMeterReading/>');
    const r = await request(app).post('/test/reset');
    expect(r.status).toBe(204);
    expect(store.controls()).toHaveLength(0);
    expect(store.meterReadings()).toHaveLength(0);
  });

  it('records observed exchanges in /test/wire (admin · poll · post)', async () => {
    const { app } = makeApp();
    await request(app).post('/test/dercontrol').set('Content-Type', 'application/json').send({ mRID: 'W1', opModFixedW: -1000 });
    await request(app).get('/derp/0/derc'); // 2030.5 poll (drains + serves the control)
    await request(app).post('/mup/0/mr').set('Content-Type', 'application/sep+xml')
      .send(meterReadingXml('cell-N-voltage', 3.2, 'fortress:cell-N-voltage'));

    const wire = await request(app).get('/test/wire');
    expect(wire.status).toBe(200);
    const dirs = wire.body.map((e: { dir: string }) => e.dir);
    expect(dirs).toContain('admin');
    expect(dirs).toContain('poll');
    expect(dirs).toContain('post');
    const poll = wire.body.find((e: { dir: string; body: string }) => e.dir === 'poll')!;
    expect(poll.body).toContain('<opModFixedW>-1000</opModFixedW>'); // poll carries the served 2030.5 XML
    const post = wire.body.find((e: { dir: string; label: string }) => e.dir === 'post')!;
    expect(post.label).toContain('fortress:cell-N-voltage');
  });

  it('peeks pending controls at /test/controls without draining them', async () => {
    const { app } = makeApp();
    await request(app).post('/test/dercontrol').set('Content-Type', 'application/json').send({ mRID: 'P1', opModFixedW: -1000 });
    const a = await request(app).get('/test/controls');
    expect(a.status).toBe(200);
    expect(a.body).toHaveLength(1);
    const b = await request(app).get('/test/controls'); // peek again — still there (not drained)
    expect(b.body).toHaveLength(1);
    await request(app).get('/derp/0/derc');              // the 2030.5 poll drains it
    const c = await request(app).get('/test/controls');
    expect(c.body).toHaveLength(0);
  });

  it('reset clears the wire log (and records the reset itself)', async () => {
    const { app } = makeApp();
    await request(app).get('/derp/0/derc');
    await request(app).post('/test/reset');
    const wire = await request(app).get('/test/wire');
    expect(wire.body).toHaveLength(1);
    expect(wire.body[0].path).toBe('/test/reset');
  });

  it('POST /test/wire/clear empties the wire log (without a full reset)', async () => {
    const { app, store } = makeApp();
    await request(app).get('/derp/0/derc');           // logs a poll entry
    expect(store.wire().length).toBeGreaterThan(0);
    const r = await request(app).post('/test/wire/clear');
    expect(r.status).toBe(204);
    expect(store.wire()).toHaveLength(0);
  });
});
