import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGhslTiff } from '../ghsl-fixture.js';

const u = await import('../../js/urbanwind.js');
const g = await import('../../js/ghsl.js');
const calc = await import('../../js/calc.js');

// The same 24 x 24 cell grid (3 arc-seconds) the reference values below
// were computed on with the training script (GhslGrid.features and
// surrogate_predict in station_eval.py), so the site and the trained
// model see the same features.
const D = 3 / 3600, TOP = 32.1, LEFT = 34.75, N = 24;
function grids(){
  const h = new Float32Array(N * N), s = new Float32Array(N * N);
  for (let r = 0; r < N; r++){
    const latc = TOP - (r + 0.5) * D;
    const area = (D * 111320) * (D * 111320 * Math.cos(latc * Math.PI / 180));
    for (let c = 0; c < N; c++){
      h[r * N + c] = (r * 7 + c * 3) % 30;
      s[r * N + c] = area * ((r + c) % 5) / 10;
    }
  }
  const base = { rows: N, cols: N, top: TOP, left: LEFT, dy: D, dx: D };
  return u.makeUrbanGrid(Object.assign({ values: h }, base), Object.assign({ values: s }, base));
}
const CASES = [[32.09, 34.76, 270, 30], [32.085, 34.755, 45, 10], [32.095, 34.765, 180, 100], [32.0905, 34.7601, 0, 60]];
const FEATURES = [
  [30.0, 1.99187, 0.175, 15.061224, 27.0, 0.176923, 13.934783],
  [10.0, 0.633075, 0.175, 15.795918, 28.0, 0.196154, 14.54902],
  [80.0, 5.584046, 0.175, 14.326531, 29.0, 0.166667, 11.175],
  [60.0, 4.424779, 0.192308, 13.56, 27.0, 0.184, 17.152174]
];
const MODEL = { init: -0.2, lr: 0.5, w_full: 0.25, trees: [
  { f: [2, -2, 0, -2, -2], t: [0.15, -2, 20, -2, -2], l: [1, -1, 3, -1, -1], r: [2, -1, 4, -1, -1], v: [0, 0.1, 0, -0.4, -0.2] },
  { f: [1, -2, -2], t: [2.0, -2, -2], l: [1, -1, -1], r: [2, -1, -1], v: [0, -0.1, 0.05] }] };
const LOG_RATIO = [-0.35, -0.45, -0.275, -0.275];
const FACTOR = [0.793282, 0.74634, 0.8317, 0.815055];

function close(a, b, tol, what){
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), what + ': ' + a + ' vs ' + b);
}

test('urbanFeatures matches the training script', () => {
  const grid = grids();
  CASES.forEach((c, i) => {
    const x = u.urbanFeatures(grid, c[0], c[1], c[2], c[3]);
    x.forEach((v, k) => close(v, FEATURES[i][k], 1e-4, 'case ' + i + ' feature ' + k));
  });
});

test('heights above the model are read at its top height', () => {
  const grid = grids();
  const at80 = u.urbanFeatures(grid, 32.09, 34.76, 270, 80);
  assert.deepEqual(u.urbanFeatures(grid, 32.09, 34.76, 270, 120), at80);
});

test('predictLogRatio and urbanFactorAt match the training script', () => {
  const grid = grids();
  CASES.forEach((c, i) => {
    const x = u.urbanFeatures(grid, c[0], c[1], c[2], c[3]);
    close(u.predictLogRatio(MODEL, x), LOG_RATIO[i], 1e-6, 'log ratio ' + i);
    close(u.urbanFactorAt(MODEL, grid, c[0], c[1], c[2], c[3]).factor, FACTOR[i], 1e-4, 'factor ' + i);
  });
});

test('no buildings: the factor is 1 whatever the model says', () => {
  const base = { rows: N, cols: N, top: TOP, left: LEFT, dy: D, dx: D };
  const empty = u.makeUrbanGrid(Object.assign({ values: new Float32Array(N * N) }, base), Object.assign({ values: new Float32Array(N * N) }, base));
  const r = u.urbanFactorAt(MODEL, empty, 32.09, 34.76, 270, 30);
  assert.equal(r.w, 0);
  assert.equal(r.factor, 1);
});

test('no-data codes count as no buildings', () => {
  const base = { rows: 1, cols: 1, top: TOP, left: LEFT, dy: D, dx: D };
  const grid = u.makeUrbanGrid(Object.assign({ values: new Float32Array([65535]) }, base), Object.assign({ values: new Float32Array([4294967295]) }, base));
  assert.equal(grid.H[0], 0);
  assert.equal(grid.F[0], 0);
});

test('routePoints spaces points along the whole route', () => {
  const pts = u.routePoints([{ lat: 32, lng: 34.8 }, { lat: 32.009, lng: 34.8 }, { lat: 32.009, lng: 34.81 }]);
  assert.deepEqual(pts[0], { lat: 32, lng: 34.8 });
  const last = pts[pts.length - 1];
  close(last.lat, 32.009, 1e-9, 'end lat');
  close(last.lng, 34.81, 1e-9, 'end lng');
  assert.ok(pts.length >= 19 && pts.length <= 21, 'about one point per 100 m: ' + pts.length);
  // A hover (one point) still gives one point.
  assert.equal(u.routePoints([{ lat: 32, lng: 34.8 }]).length, 1);
});

test('urbanFactorFor interpolates between heights and holds the ends', () => {
  const urban = { heights: [30, 40, 80], factor: [0.6, 0.8, 1.0] };
  assert.equal(u.urbanFactorFor(urban, 30), 0.6);
  close(u.urbanFactorFor(urban, 35), 0.7, 1e-12, '35 m');
  assert.equal(u.urbanFactorFor(urban, 10), 0.6);
  assert.equal(u.urbanFactorFor(urban, 120), 1.0);
  assert.equal(u.urbanFactorFor(null, 50), 1);
});

test('windByHeight: the building factor changes the wind flown in, not the gust checks', () => {
  const wx = { ws10: 4, ws80: 8, ws120: 10, wd10: 270, wd80: 270, wd120: 270, gustFactor: 1.5 };
  const inp = { speedhorizontal: 10, speedhorizontalback: 10, windResistance: 12, drag: '1', speedMode: 'ground' };
  const heights = [30, 80, 120];
  const open = calc.windByHeight(heights, wx, 90, inp);
  const urban = calc.windByHeight(heights, Object.assign({}, wx, { urban: { heights: heights, factor: [0.5, 0.8, 1] } }), 90, inp);
  close(urban.ws[0], open.ws[0] * 0.5, 1e-12, 'wind at 30 m');
  close(urban.wsOpen[0], open.ws[0], 1e-12, 'open-ground wind kept');
  assert.deepEqual(urban.estgust, open.estgust);
  assert.deepEqual(urban.crosswind, open.crosswind);
  assert.deepEqual(urban.windResOk, open.windResOk);
  // Into a weaker headwind (outbound, flying west into a west wind) the drone is faster.
  assert.ok(urban.gsOut[0] > open.gsOut[0]);
  // A factor above 1 makes the checks stricter, not looser.
  const fast = calc.windByHeight(heights, Object.assign({}, wx, { urban: { heights: heights, factor: [1.5, 1, 1] } }), 90, inp);
  close(fast.estgust[0], open.estgust[0] * 1.5, 1e-12, 'gust with a stronger wind');
});

test('ghslGrid reads a window of cells across tiles, NaN outside the file', async () => {
  const tiff = makeGhslTiff({ x0: 34.7, y0: 32.32, dx: 0.01, width: 32, height: 32, tile: 16,
    value: (lat, lng) => Math.floor((32.32 - lat) * 100) * 100 + Math.floor((lng - 34.7) * 100) });
  g.resetGhsl();
  g.ghslIO.fetchRange = async (start, len) => { const b = tiff.subarray(start, Math.min(start + len, tiff.length)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const w = await g.ghslGrid('x', 32.125, 34.845, 32.185, 34.875);
  assert.equal(w.rows, 7);
  assert.equal(w.cols, 4);
  close(w.top, 32.19, 1e-9, 'top');
  close(w.left, 34.84, 1e-9, 'left');
  // each cell's value is its row * 100 + its column
  assert.equal(w.values[0], 13 * 100 + 14);
  assert.equal(w.values[w.values.length - 1], 19 * 100 + 17);
  const out = await g.ghslGrid('x', 32.3, 34.6, 32.33, 34.71);
  assert.ok(Number.isNaN(out.values[0]));
});
