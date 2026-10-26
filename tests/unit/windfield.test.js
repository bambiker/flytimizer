import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSite } from './load.js';

const site = await loadSite();
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, a + ' vs ' + b);

// Forecast as forecastAt makes it: m/s, degrees the wind comes from.
function wx(ws, wd){ return { ws10: ws, ws80: ws, ws120: ws, wd10: wd, wd80: wd, wd120: wd, gustFactor: 1.2 }; }
// Samples every 100 m along a list of [lat, lng] corners.
function samplesAlong(corners){
  const out = [];
  let s = 0;
  for (let c = 0; c + 1 < corners.length; c++){
    const [a, b] = [corners[c], corners[c + 1]];
    const d = site.getDistanceFromLatLon(a[0], a[1], b[0], b[1]);
    const n = Math.round(d / 100);
    for (let k = c === 0 ? 0 : 1; k <= n; k++){
      out.push({ lat: a[0] + (b[0] - a[0]) * k / n, lng: a[1] + (b[1] - a[1]) * k / n, s: s + d * k / n, g: 0 });
    }
    s += d;
  }
  return out;
}
const inp = { speedMode: 'air', drag: '1', speedhorizontal: 10 };
const heights = [30, 60];

test('on a straight route with one forecast, every stretch gets the route\'s wind', () => {
  const samples = samplesAlong([[32, 35], [32, 35.02]]);   // due east, ~1.9 km
  const field = site.makeWindField([{ lat: 32, lng: 35, wx: wx(5, 270) }], null, heights);
  const seg = site.routeSegments(samples, heights, field, 20);
  const sp = site.legSegmentSpeeds(seg, 10, inp);
  // Wind from the west, flying east: a 5 m/s tailwind on every stretch.
  sp.gs[0].forEach(g => near(g, 15, 1e-3));
  // Same as the one-wind formula.
  const w = site.windByHeight(heights, wx(5, 270), (site.trueBearing(32, 35, 32, 35.02) + 180) % 360, { ...inp, speedhorizontalback: 10, windResistance: 20 });
  near(sp.gs[0][3], w.gsOut[0], 1e-3);
});

test('a bend in the route changes the wind on the stretches after it', () => {
  const samples = samplesAlong([[32, 35], [32, 35.01], [32.01, 35.01]]);   // east, then north
  const field = site.makeWindField([{ lat: 32, lng: 35, wx: wx(5, 270) }], null, heights);
  const sp = site.legSegmentSpeeds(site.routeSegments(samples, heights, field, 20), 10, inp);
  const first = sp.gs[0][0], last = sp.gs[0][sp.gs[0].length - 1];
  near(first, 15, 1e-3);              // tailwind going east
  near(last, Math.sqrt(100 - 25), 1e-2);   // crosswind going north: crabbing
});

test('a long route uses the nearest forecast point for each stretch', () => {
  const samples = samplesAlong([[32, 35], [32, 35.1]]);   // ~9.4 km east
  const field = site.makeWindField([
    { lat: 32, lng: 35, wx: wx(2, 270) },
    { lat: 32, lng: 35.1, wx: wx(8, 270) }
  ], null, heights);
  const sp = site.legSegmentSpeeds(site.routeSegments(samples, heights, field, 20), 10, inp);
  near(sp.gs[0][0], 12, 1e-3);
  near(sp.gs[0][sp.gs[0].length - 1], 18, 1e-3);
});

test('a stretch with a crosswind as strong as the drone has no ground speed; gusts check the strongest point', () => {
  const samples = samplesAlong([[32, 35], [32.01, 35]]);   // north
  const field = site.makeWindField([{ lat: 32, lng: 35, wx: wx(11, 270) }], null, heights);
  const seg = site.routeSegments(samples, heights, field, 20);
  assert.equal(site.legSegmentSpeeds(seg, 10, inp).gs[0][0], 0);
  assert.equal(site.gsFlyable(site.legSegmentSpeeds(seg, 10, inp).gs[0]), false);
  const windy = site.makeWindField([{ lat: 32, lng: 35, wx: wx(2, 270) }, { lat: 33, lng: 35, wx: wx(15, 270) }], null, heights);
  assert.equal(site.routeSegments(samples, heights, windy, 12).gustOk[0], false);   // 15 x 1.2 > 12
});

test('per-stretch timing and energy match the one-wind numbers when the wind is the same everywhere, and follow it when it isn\'t', () => {
  const samples = samplesAlong([[32, 35], [32, 35.02]]);
  const prof = site.buildAltitudeProfile(samples, 40, samples.map(() => -Infinity), 2, 2, 'follow');
  const n = samples.length - 1;
  const one = site.profileTiming(prof, samples, 12, 5, 3, {});
  const per = site.profileTiming(prof, samples, Array(n).fill(12), 5, 3, {});
  near(per.total, one.total, 1e-6);
  near(per.cruiseSeg.reduce((a, b) => a + b, 0), one.cruise, 1e-6);
  const model = { hoverW: 100, massKg: 1, vmax: 20, curve: { a: -0.2, b: 0.5 }, climbEff: 0.6 };
  near(site.legEnergyFromTiming(model, 1, Array(n).fill(9), per, 5), site.legEnergyFromTiming(model, 1, 9, one, 5), 1e-9);
  // Half the route into a slower stretch: it takes longer.
  const mixed = Array(n).fill(12).map((g, k) => k < n / 2 ? 6 : 12);
  assert.ok(site.profileTiming(prof, samples, mixed, 5, 3, {}).total > one.total + 50);
});

test('route forecast points: just the start on a short route, up to 5 along a long one', () => {
  assert.equal(site.routeForecastPoints(32, 35, 32, 35.02, 1900).length, 1);
  assert.equal(site.routeForecastPoints(32, 35, 32, 35.07, 6500).length, 3);
  const many = site.routeForecastPoints(32, 35, 32, 35.5, 47000);
  assert.equal(many.length, 5);
  near(many[4].lng, 35.5);
});
