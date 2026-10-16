import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSite } from './load.js';

const site = await loadSite();
const heights = [30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
const date = new Date('2026-10-16T12:00:00Z');

test('a geostationary satellite is overhead on the equator below it, and ~53 degrees up from 32 N', () => {
  const th = site.gmst(date) * 180 / Math.PI;
  const geo = { EPOCH: '2026-10-16T12:00:00', MEAN_MOTION: 1.00273791, ECCENTRICITY: 0, INCLINATION: 0, RA_OF_ASC_NODE: 0, ARG_OF_PERICENTER: 0, MEAN_ANOMALY: ((th + 35) % 360 + 360) % 360 };
  assert.ok(site.elevationDeg(0, 35, site.satellitePosition(geo, date)) > 89.9);
  // Six hours on it hasn't moved over the ground.
  assert.ok(site.elevationDeg(0, 35, site.satellitePosition(geo, new Date(date.getTime() + 6 * 3600e3))) > 89.5);
  const e = site.elevationDeg(32, 35, site.satellitePosition(geo, date));
  assert.ok(e > 51 && e < 54, String(e));
  // On the far side of the Earth it's below the horizon.
  assert.ok(site.elevationDeg(0, -145, site.satellitePosition(geo, date)) < -60);
});

test('a GPS-like constellation shows 7 to 12 satellites above 10 degrees all day', () => {
  const gps = [];
  for (let p = 0; p < 6; p++) for (let s = 0; s < 5; s++) gps.push({ EPOCH: '2026-10-15T00:00:00Z', MEAN_MOTION: 2.00563, ECCENTRICITY: 0.01, INCLINATION: 55, RA_OF_ASC_NODE: p * 60, ARG_OF_PERICENTER: 0, MEAN_ANOMALY: s * 72 + p * 15 });
  for (let h = 0; h < 24; h += 2){
    const n = site.countVisible(gps, 32.08, 34.78, new Date(date.getTime() + h * 3600e3));
    assert.ok(n >= 7 && n <= 12, h + 'h: ' + n);
  }
  assert.ok(site.countVisible(gps, 32.08, 34.78, date, 0) > site.countVisible(gps, 32.08, 34.78, date, 30));
});

test('currentKp reads NOAA\'s table (header row or objects) for the current 3-hour slot', () => {
  const rows = [['time_tag', 'kp', 'observed', 'noaa_scale'], ['2026-10-16 09:00:00', '2.33', 'observed', null], ['2026-10-16 12:00:00', '5.00', 'predicted', 'G1'], ['2026-10-16 15:00:00', '3', 'predicted', null]];
  assert.equal(site.currentKp(rows, date), 5);
  assert.equal(site.currentKp(rows, new Date('2026-10-16T11:59:00Z')), 2.33);
  assert.equal(site.currentKp([{ time_tag: '2026-10-16T09:00:00', kp: 4 }], date), 4);
  assert.equal(site.currentKp([], date), null);
  assert.equal(site.currentKp('nonsense', date), null);
  assert.match(site.kpLabel(2), /quiet/);
  assert.match(site.kpLabel(5.3), /storm/);
});

function wx(w10, w80, w120, gust10){
  return site.forecastAt({ hourly: { time: ['x'], wind_speed_10m: [w10 * 3.6], wind_speed_80m: [w80 * 3.6], wind_speed_120m: [w120 * 3.6],
    wind_direction_10m: [0], wind_direction_80m: [0], wind_direction_120m: [0], wind_gusts_10m: [gust10 * 3.6],
    visibility: [20000], precipitation_probability: [0], precipitation: [0], temperature_2m: [20] } }, 0);
}
const inp = { speedhorizontal: 15, speedhorizontalback: 15, drag: '1', windResistance: 12, speedMode: 'ground' };

test('windCeiling: the legal limit, gusts over the rating, or wind as fast as the drone', () => {
  let c = site.windCeiling(heights, wx(3, 5, 6, 4), inp, 50);
  assert.deepEqual([c.ceilingM, c.limit], [50, 'legal']);
  c = site.windCeiling(heights, wx(3, 5, 6, 4), inp, 120);
  assert.deepEqual([c.ceilingM, c.limit], [120, 'top']);
  // Gust factor 1.5: 8 m/s at 80 m gusts 12 - at the rating.
  c = site.windCeiling(heights, wx(4, 8, 10, 6), inp, 120);
  assert.equal(c.limit, 'gust');
  assert.ok(c.ceilingM < 80 && c.ceilingM >= 30, String(c.ceilingM));
  // Steady wind (no gusts) as fast as a slow drone.
  c = site.windCeiling(heights, wx(6, 10, 12, 6), Object.assign({}, inp, { speedhorizontal: 9, speedhorizontalback: 9, windResistance: 20 }), 120);
  assert.equal(c.limit, 'speed');
  // Too windy even at the bottom.
  c = site.windCeiling(heights, wx(10, 12, 14, 15), inp, 120);
  assert.equal(c.ceilingM, null);
});
