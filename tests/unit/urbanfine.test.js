import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadSite } from './load.js';

const site = await loadSite();
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/urban_fine_features.json', import.meta.url)));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, a + ' vs ' + b);

function gridFromRects(n, rects){
  const H = new Float32Array(n * n);
  rects.forEach(([r0, c0, rh, cw, h]) => {
    for (let r = r0; r < Math.min(n, r0 + rh); r++) for (let c = c0; c < Math.min(n, c0 + cw); c++) H[r * n + c] = h;
  });
  return { H, n };
}
// A model that only looks at one feature: ratio = a below t, b above.
const stump = (f, t, a, b) => ({ init: 0, lr: 1, trees: [{ f: [f, -2, -2], t: [t, 0, 0], l: [1, -1, -1], r: [2, -1, -1], v: [0, Math.log(a), Math.log(b)] }] });

test('fine features match the Python training code (tools/urban_fine_features.py)', () => {
  assert.equal(fixture.n, site.FINE_N);
  assert.equal(fixture.cell_m, site.FINE_CELL_M);
  fixture.cases.forEach(c => {
    const x = site.fineFeatures(gridFromRects(fixture.n, c.rects), c.z, c.wdir);
    assert.equal(x.length, fixture.features.length);
    x.forEach((v, k) => near(v, c.features[k], 1e-9));
  });
});

test('OSM footprints are burnt into the 2 m grid around the point', () => {
  // A 20 m x 10 m building whose west wall is 10 m east of the point.
  const lat = 32, lng = 35, m = 1 / 111320, mE = m / Math.cos(lat * Math.PI / 180);
  const b = { height: 15, pts: [[0, 10], [0, 30], [10, 30], [10, 10]].map(([n, e]) => ({ lat: lat + n * m, lng: lng + e * mE })) };
  const g = site.rasterizeBuildings([b], lat, lng);
  const built = g.H.reduce((s, h) => s + (h > 0), 0);
  assert.ok(built >= 40 && built <= 66, String(built));   // ~200 m² of 4 m² cells
  const x = site.fineFeatures(g, 10, 90);                // wind from the east: the building is upwind
  near(x[7], 10, 2.01);                                  // distance to it
  assert.equal(x[8], 15);
  assert.ok(x[11] <= 12);                                // straight upwind
  assert.equal(site.fineFeatures(g, 10, 270)[11], 150);  // wind from the west: nothing upwind
});

test('takeoff wind: the fine model where OSM has the buildings, the area model where it lacks them or on a roof', () => {
  const pts = [{ lat: 32, lng: 35, wx: { ws10: 4, ws80: 4, ws120: 4, wd10: 90, wd80: 90, wd120: 90, gustFactor: 1.2 } }];
  const canyon = gridFromRects(site.FINE_N, [[0, 60, 151, 10, 30], [0, 81, 151, 10, 30]]);   // a street between two long blocks
  // Sheltered when a building is within 15 m.
  const fine = { model: stump(7, 15, 0.4, 1), grid: canyon };
  const g = site.endpointWinds(pts, null, 32, 35, [10], fine);
  near(g[0].factor, 0.4);
  near(g[0].ws, 1.6);
  assert.equal(g[0].source, 'buildings');
  near(g[0].gustCheck, 4 * 1.2);   // the safety check keeps the forecast
  // Taking off from a roof: not the fine model.
  const roof = { model: fine.model, grid: gridFromRects(site.FINE_N, [[70, 70, 11, 11, 20]]) };
  assert.equal(site.endpointWinds(pts, null, 32, 35, [10], roof)[0].source, null);
  // No OSM buildings, but GHSL says it's built up: the area model.
  const n = 30;
  const area = { model: { init: Math.log(0.7), lr: 0, w_full: 0.25, trees: [] }, grid: { H: new Float32Array(n * n).fill(20), F: new Float32Array(n * n).fill(1),
    rows: n, cols: n, top: 32 + n * 0.0008 / 2, left: 35 - n * 0.00095 / 2, dy: 0.0008, dx: 0.00095 } };
  const empty = { model: fine.model, grid: gridFromRects(site.FINE_N, []) };
  const a = site.endpointWinds(pts, area, 32, 35, [10], empty)[0];
  assert.equal(a.source, 'area');
  near(a.factor, 0.7);
});
