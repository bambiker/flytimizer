import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSite } from './load.js';

const site = await loadSite();
const heights = [30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
const legalOk = heights.map(() => true);

// Forecast in the units Open-Meteo returns (km/h); the same wind at
// every height, gusts no stronger than the average.
function wxFrom(kmh, dir){
  return site.forecastAt({ hourly: {
    time: ['2026-10-06T00:00'],
    wind_speed_10m: [kmh], wind_speed_80m: [kmh], wind_speed_120m: [kmh],
    wind_direction_10m: [dir], wind_direction_80m: [dir], wind_direction_120m: [dir],
    wind_gusts_10m: [kmh], visibility: [20000], precipitation_probability: [0], precipitation: [0],
    temperature_2m: [20]
  } }, 0);
}
const inp = {
  dwellS: 60, speedup: 5, speeddown: 3, speedhorizontal: 15, speedupback: 5, speeddownback: 3, speedhorizontalback: 15,
  drag: '1', windResistance: 12, speedMode: 'air'
};
const model = { wh: 77, usableFraction: 1, massKg: 0.9, vmax: 15, hoverW: 77 * 60 / 46 / site.airspeedPowerFactor(6, 15) };
function range(wx, over){
  return site.roundTripRange(Object.assign({
    heights: heights, legalOk: legalOk, wx: wx, inp: inp, battModel: model,
    payloadOut: 1, payloadBack: 1, temperatureC: 20, mission: 'delivery'
  }, over));
}
function at(ranges, bearing){ return ranges.find(r => r.bearing === bearing).distM; }

test('roundTripRange: the distance it gives uses exactly the battery down to the reserve', () => {
  const wx = wxFrom(18, 300);
  for (const mode of ['air', 'ground']){
    const i2 = Object.assign({}, inp, { speedMode: mode });
    const ranges = range(wx, { inp: i2, payloadOut: 1.3 });
    const r = ranges.find(x => x.bearing === 45);
    const hi = heights.indexOf(r.heightM);
    // The same trip through the normal per-leg battery maths.
    const w = site.windByHeight(heights, wx, 225, i2);
    const samples = [{ s: 0, g: 0 }, { s: r.distM / 2, g: 0 }, { s: r.distM, g: 0 }];
    const prof = site.buildAltitudeProfile(samples, r.heightM, samples.map(() => -Infinity), 3, 5);
    const tOut = site.profileTiming(prof, samples, w.gsOut[hi], i2.speedup, i2.speeddown);
    const tBack = site.profileTiming(prof, samples, w.gsBack[hi], i2.speedupback, i2.speeddownback);
    const pct = site.batteryPct(model, site.legEnergyFromTiming(model, 1.3, w.airOut[hi], tOut, i2.speedup), 20) +
      site.batteryPct(model, site.legEnergyFromTiming(model, 1, w.airBack[hi], tBack, i2.speedupback), 20) +
      site.batteryPct(model, model.hoverW * Math.pow(1.3, 1.5) * 60 / 3600, 20);
    assert.ok(Math.abs(pct - (100 - site.BATTERY_RESERVE_PCT)) < 0.5, mode + ': ' + pct);
  }
});

test('roundTripRange: a circle in calm air, smaller in every direction in wind', () => {
  const calm = range(wxFrom(0, 0));
  assert.equal(calm.length, 360 / site.RANGE_STEP_DEG);
  calm.forEach(r => assert.ok(Math.abs(r.distM - calm[0].distM) < 1e-6));
  assert.ok(calm[0].distM > 5000 && calm[0].distM < 20000, String(calm[0].distM));
  const windy = range(wxFrom(36, 0));
  windy.forEach((r, k) => assert.ok(r.distM < calm[k].distM));
});

test('roundTripRange: holding airspeed, a round trip along the wind is shorter than across it', () => {
  // Wind from the north: north and south are along it, east and west across.
  const r = range(wxFrom(36, 0));
  assert.ok(at(r, 0) < at(r, 90));
  // Same load both ways: out-and-back north is the same trip as south.
  assert.ok(Math.abs(at(r, 0) - at(r, 180)) < 1);
  assert.ok(Math.abs(at(r, 90) - at(r, 270)) < 1);
});

test('roundTripRange: carrying the load out, it reaches farther downwind than upwind', () => {
  // Wind from the north blows south: heavy outbound with the wind, light back against it.
  const r = range(wxFrom(36, 0), { payloadOut: 1.4 });
  assert.ok(at(r, 180) > at(r, 0));
});

test('roundTripRange: no battery model, no range; a wind it can\'t fly in, no distance', () => {
  assert.equal(range(wxFrom(18, 0), { battModel: null }), null);
  // Gusts over the drone's rating at every height.
  const r = range(wxFrom(60, 0));
  r.forEach(x => { assert.equal(x.distM, 0); assert.equal(x.heightM, null); });
  assert.equal(site.rangeExtremes(r), null);
});

test('roundTripRange: above the legal limit isn\'t used', () => {
  const r = range(wxFrom(18, 0), { legalOk: heights.map(h => h <= 60) });
  r.forEach(x => assert.ok(x.heightM <= 60));
});

test('destinationPoint and compassWord', () => {
  const p = site.destinationPoint(32, 35, 90, 5000);
  assert.ok(Math.abs(site.getDistanceFromLatLon(32, 35, p.lat, p.lng) - 5000) < 5);
  assert.ok(Math.abs(site.trueBearing(32, 35, p.lat, p.lng) - 90) < 0.1);
  const n = site.destinationPoint(0, 179.99, 90, 5000);
  assert.ok(n.lng < -179);
  assert.equal(site.compassWord(0), 'north');
  assert.equal(site.compassWord(350), 'north');
  assert.equal(site.compassWord(135), 'southeast');
  assert.equal(site.compassWord(-90), 'west');
});

test('rangeExtremes picks the farthest and shortest directions', () => {
  const e = site.rangeExtremes([{ bearing: 0, distM: 3 }, { bearing: 90, distM: 9 }, { bearing: 180, distM: 1 }]);
  assert.equal(e.far.bearing, 90);
  assert.equal(e.near.bearing, 180);
});
