import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSite } from './load.js';

const site = await loadSite();
const heights = [30, 40, 50, 60, 70, 80, 90, 100, 110, 120];

// Forecast in the units Open-Meteo returns (km/h).
function hourly(over){
  const base = {
    time: ['2026-10-06T00:00'],
    wind_speed_10m: [18], wind_speed_80m: [36], wind_speed_120m: [54],
    wind_direction_10m: [180], wind_direction_80m: [180], wind_direction_120m: [180],
    wind_gusts_10m: [27], visibility: [20000], precipitation_probability: [0], precipitation: [0],
    temperature_2m: [20]
  };
  return { hourly: Object.assign(base, over) };
}
const inputs = { speedhorizontal: 15, speedhorizontalback: 15, drag: '1', windResistance: 12 };

test('forecastAt converts km/h to m/s and clamps the gust factor', () => {
  const wx = site.forecastAt(hourly(), 0);
  assert.equal(wx.ws10, 5);
  assert.equal(wx.ws80, 10);
  assert.equal(wx.ws120, 15);
  assert.equal(wx.gustFactor, 1.5);
  assert.equal(site.forecastAt(hourly({ wind_gusts_10m: [180] }), 0).gustFactor, 3);
  assert.equal(site.forecastAt(hourly({ wind_gusts_10m: [1] }), 0).gustFactor, 1);
  assert.equal(site.forecastAt(hourly({ wind_speed_10m: [0], wind_gusts_10m: [10] }), 0).gustFactor, 1);
});

test('windByHeight uses the forecast at 80 and 120 m and interpolates between', () => {
  const wx = site.forecastAt(hourly(), 0);
  const w = site.windByHeight(heights, wx, 180, inputs);
  assert.equal(w.ws[5], 10);   // 80 m
  assert.equal(w.ws[9], 15);   // 120 m
  assert.ok(w.ws[7] > 10 && w.ws[7] < 15);   // 100 m
  assert.ok(w.ws[0] > 5 && w.ws[0] < 10);    // 30 m
  assert.equal(w.estgust[5], 15);
});

test('windByHeight: wind from behind speeds up the outbound leg and slows the return', () => {
  // dronedegrees is the reverse bearing; wind from that direction is a tailwind outbound.
  const w = site.windByHeight(heights, site.forecastAt(hourly(), 0), 180, inputs);
  assert.ok(w.gsOut[5] > inputs.speedhorizontal);
  assert.ok(w.gsBack[5] < inputs.speedhorizontal);
  assert.ok(w.crosswind[5] < 1e-9);
});

test('windByHeight flags gusts over the rating and crosswind over the airspeed', () => {
  const wx = site.forecastAt(hourly(), 0);
  const w = site.windByHeight(heights, wx, 180, inputs);
  // Gust 1.5x: 15 m/s at 80 m (over 12), lower down it's fine.
  assert.equal(w.windResOk[0], true);
  assert.equal(w.windResOk[5], false);
  // Same wind straight across the track, drone slower than the wind at 120 m.
  const slow = Object.assign({}, inputs, { speedhorizontal: 12, speedhorizontalback: 12 });
  const cross = site.windByHeight(heights, wx, 90, slow);
  assert.equal(cross.crosswindOkOut[9], false);
  assert.equal(cross.crosswindOkOut[0], true);
});

test('flyableCeilingM is the highest height that is legal and wind-flyable', () => {
  const w = site.windByHeight(heights, site.forecastAt(hourly(), 0), 180, inputs);
  const legalOk = heights.map(h => h <= 120);
  const ceiling = site.flyableCeilingM(heights, legalOk, w);
  assert.ok(ceiling >= 30 && ceiling < 80, ceiling);
  assert.equal(site.flyableCeilingM(heights, heights.map(() => false), w), 0);
});

test('fastestFlyableIdx picks the quickest flyable height, or -1', () => {
  const timeV = [10, 10, 10, 10];
  const timeH = [100, 50, 20, 80];
  assert.equal(site.fastestFlyableIdx([true, true, true, true], timeV, timeH), 2);
  assert.equal(site.fastestFlyableIdx([true, true, false, true], timeV, timeH), 1);
  assert.equal(site.fastestFlyableIdx([false, false, false, false], timeV, timeH), -1);
});

test('sortRouteBuildings: a few climbable buildings are detoured, many are climbed over', () => {
  const path = [{ lat: 32, lng: 35 }, { lat: 32.01, lng: 35 }];
  const b = (k, height) => ({ lat: 32 + 0.001 * (k + 1), lng: 35, radius: 8, height });
  const off = { lat: 32.005, lng: 35.01, radius: 8, height: 30 };   // ~1 km off the line

  const few = site.sortRouteBuildings([b(0, 10), b(1, 20), off], path, 120);
  assert.equal(few.onRoute.length, 2);
  assert.equal(few.toAvoid.length, 2);
  assert.equal(few.maxClimbedHeight, 0);

  const many = site.sortRouteBuildings([0, 1, 2, 3, 4, 5].map(k => b(k, 10 + k)), path, 120);
  assert.equal(many.onRoute.length, 6);
  assert.equal(many.toAvoid.length, 0);
  assert.equal(many.maxClimbedHeight, 15);

  const tall = site.sortRouteBuildings([0, 1, 2, 3, 4].map(k => b(k, k === 2 ? 150 : 10)), path, 120);
  assert.equal(tall.tooTall.length, 1);
  assert.deepEqual(tall.toAvoid.map(x => x.height), [150]);
  assert.equal(tall.maxClimbedHeight, 10);
});
