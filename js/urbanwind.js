// Building effect on the wind (beta).
//
// Built-up areas slow the wind near the ground: buildings shelter it
// and stir it up. The forecast (Open-Meteo) only knows this roughly,
// over cells kilometres wide. Here a small model gives, for any point
// and height, how much of the open-ground wind is left after the
// buildings around it:
//
//   factor = (1 - w) + w * ratio
//
// ratio comes from a model trained to imitate a U-Net that was itself
// trained on CFD simulations of Tel Aviv, and checked against weather
// stations in Tel Aviv, Jerusalem, Tokyo and Singapore. It only reads
// global building data the site already uses: GHSL building height
// (GHS-BUILT-H) and built-up surface (GHS-BUILT-S), on their ~90 m grid.
// w (0-1) fades the correction out where little is built, so in open
// country the forecast is used as it is.
//
// The features below must stay identical to the ones the model was
// trained with (GhslGrid.features in the training script) - the unit
// tests check them against values computed there.

import { GHSL_BUILT_S_URL, GHSL_URL, ghslGrid } from './ghsl.js';

export var URBAN_MODEL_URL = 'data/urban_wind_model.json';
export var URBAN_R_DISK = 250;     // m: built fraction and mean height around the point
export var URBAN_R_UP = 600;       // m: length of the upwind sector
export var URBAN_UP_HALF = 30;     // degrees: half-width of the upwind sector
export var URBAN_ZMAX = 80;        // m: highest height the model knows; above it, its value there
export var URBAN_W_FULL = 0.25;    // built fraction at which the correction is used fully (the model file gives its own)
export var URBAN_SAMPLE_M = 100;   // spacing of the route points the factor is averaged over
export var URBAN_MAX_POINTS = 150;
var M_PER_DEG = 111320;

async function fetchModel(){
  var r = await fetch(URBAN_MODEL_URL);
  if (!r.ok) throw new Error('Urban wind model HTTP ' + r.status);
  return r.json();
}
// Tests swap urbanIO.fetchModel.
export var urbanIO = { fetchModel: fetchModel };

var modelPromise = null;
export function loadUrbanModel(){
  if (!modelPromise){
    modelPromise = urbanIO.fetchModel();
    modelPromise.catch(function(){ modelPromise = null; });
  }
  return modelPromise;
}
export function resetUrban(){ modelPromise = null; }

// Height (m) and built fraction (0-1) on the same grid, from the two
// GHSL windows. Values that can't be real (no-data codes) count as 0.
export function makeUrbanGrid(hGrid, sGrid){
  var n = hGrid.rows * hGrid.cols;
  var H = new Float32Array(n), F = new Float32Array(n);
  for (var r = 0; r < hGrid.rows; r++){
    var latc = hGrid.top - (r + 0.5) * hGrid.dy;
    var area = (hGrid.dy * M_PER_DEG) * (hGrid.dx * M_PER_DEG * Math.cos(latc * Math.PI / 180));
    for (var c = 0; c < hGrid.cols; c++){
      var k = r * hGrid.cols + c;
      var h = hGrid.values[k], s = sGrid.values[k];
      H[k] = isFinite(h) && h >= 0 && h <= 1000 ? h : 0;
      s = isFinite(s) && s >= 0 && s <= 1.2 * area ? s : 0;
      F[k] = Math.min(Math.max(s / area, 0), 1);
    }
  }
  return { H: H, F: F, rows: hGrid.rows, cols: hGrid.cols, top: hGrid.top, left: hGrid.left, dy: hGrid.dy, dx: hGrid.dx };
}

// [z, zrel, lam250, hm250, hloc, lamup, hmup] at a point; wdir is the
// direction the wind blows FROM (degrees).
export function urbanFeatures(g, lat, lng, wdir, z){
  z = Math.min(z, URBAN_ZMAX);
  var r0 = Math.floor((g.top - lat) / g.dy), c0 = Math.floor((lng - g.left) / g.dx);
  var coslat = Math.cos(lat * Math.PI / 180);
  var cellM = Math.min(g.dy * M_PER_DEG, g.dx * M_PER_DEG * coslat);
  var K = Math.ceil(URBAN_R_UP / cellM) + 1;
  var sF = 0, sFH = 0, n = 0, uF = 0, uFH = 0, un = 0, hloc = 0;
  for (var dr = -K; dr <= K; dr++){
    for (var dc = -K; dc <= K; dc++){
      var rr = r0 + dr, cc = c0 + dc;
      if (rr < 0 || rr >= g.rows || cc < 0 || cc >= g.cols) continue;
      var k = rr * g.cols + cc, F = g.F[k], H = g.H[k];
      var dN = (g.top - (rr + 0.5) * g.dy - lat) * M_PER_DEG;
      var dE = (g.left + (cc + 0.5) * g.dx - lng) * M_PER_DEG * coslat;
      var d = Math.hypot(dN, dE);
      if (d <= URBAN_R_DISK){ sF += F; sFH += F * H; n++; }
      var brg = ((Math.atan2(dE, dN) * 180 / Math.PI) % 360 + 360) % 360;
      var off = Math.abs(((brg - wdir + 180) % 360 + 360) % 360 - 180);
      if (d <= URBAN_R_UP && off <= URBAN_UP_HALF){ uF += F; uFH += F * H; un++; }
      if (Math.abs(dr) <= 1 && Math.abs(dc) <= 1 && H > hloc) hloc = H;
    }
  }
  // A coarse grid can have no cell centre within the disk: then the cell
  // the point is in stands for it.
  if (n === 0 && r0 >= 0 && r0 < g.rows && c0 >= 0 && c0 < g.cols){
    var ko = r0 * g.cols + c0;
    sF = g.F[ko]; sFH = g.F[ko] * g.H[ko]; n = 1;
  }
  var lam = n > 0 ? sF / n : 0;
  var hm = sF > 1e-6 ? sFH / sF : 0;
  var lamup = un > 0 ? uF / un : lam;
  var hmup = uF > 1e-6 ? uFH / uF : 0;
  return [z, z / Math.max(hm, 3), lam, hm, hloc, lamup, hmup];
}

// log(ratio) from the model's trees (gradient boosting: start value +
// learning rate x the leaf of every tree).
export function predictLogRatio(model, x){
  var out = model.init;
  for (var i = 0; i < model.trees.length; i++){
    var t = model.trees[i], node = 0;
    while (t.l[node] >= 0) node = x[t.f[node]] <= t.t[node] ? t.l[node] : t.r[node];
    out += model.lr * t.v[node];
  }
  return out;
}

// { factor, ratio, w } at a point.
export function urbanFactorAt(model, g, lat, lng, wdir, z){
  var x = urbanFeatures(g, lat, lng, wdir, z);
  var ratio = Math.min(Math.max(Math.exp(predictLogRatio(model, x)), 0.05), 3);
  var w = Math.min(Math.max(x[2] / (model.w_full || URBAN_W_FULL), 0), 1);
  return { factor: (1 - w) + w * ratio, ratio: ratio, w: w };
}

// Points every URBAN_SAMPLE_M along the route (at most URBAN_MAX_POINTS).
export function routePoints(path){
  if (path.length < 2) return [{ lat: path[0].lat, lng: path[0].lng }];
  var pts = [], legs = [], total = 0;
  for (var i = 1; i < path.length; i++){
    var a = path[i - 1], b = path[i];
    var dN = (b.lat - a.lat) * M_PER_DEG, dE = (b.lng - a.lng) * M_PER_DEG * Math.cos(a.lat * Math.PI / 180);
    legs.push(Math.hypot(dN, dE));
    total += legs[i - 1];
  }
  var n = Math.max(1, Math.min(URBAN_MAX_POINTS - 1, Math.ceil(total / URBAN_SAMPLE_M)));
  for (var k = 0; k <= n; k++){
    var at = total * k / n, j = 0;
    while (j < legs.length - 1 && at > legs[j]){ at -= legs[j]; j++; }
    var t = legs.length && legs[j] > 0 ? Math.min(at / legs[j], 1) : 0;
    var p = path[Math.min(j, path.length - 1)], q = path[Math.min(j + 1, path.length - 1)];
    pts.push({ lat: p.lat + (q.lat - p.lat) * t, lng: p.lng + (q.lng - p.lng) * t });
  }
  return pts;
}

// Downloads what's needed for a route: the model and the two GHSL
// windows around it. Rejects if any of them can't be read.
export async function loadUrbanArea(path){
  var lats = path.map(function(p){ return p.lat; }), lngs = path.map(function(p){ return p.lng; });
  var m = (URBAN_R_UP + 200) / M_PER_DEG;
  var south = Math.min.apply(null, lats) - m, north = Math.max.apply(null, lats) + m;
  var mLng = m / Math.cos(Math.max(Math.abs(south), Math.abs(north)) * Math.PI / 180);
  var west = Math.min.apply(null, lngs) - mLng, east = Math.max.apply(null, lngs) + mLng;
  // The model first: without it there's nothing to download the grids for.
  var model = await loadUrbanModel();
  var got = await Promise.all([model, ghslGrid(GHSL_URL, south, west, north, east),
    ghslGrid(GHSL_BUILT_S_URL, south, west, north, east)]);
  if (got[1].rows !== got[2].rows || got[1].cols !== got[2].cols) throw new Error('GHSL grids differ');
  return { model: got[0], grid: makeUrbanGrid(got[1], got[2]), points: routePoints(path) };
}

// The factor for each height, averaged along the route, with the wind
// direction at that height (wdByHeight, degrees from). Also the factor
// near the ground (10 m) at the start and the destination.
export function routeUrbanFactors(area, heights, wdByHeight, wdGround){
  var factor = [], maxW = 0;
  var pts = area.points;
  for (var i = 0; i < heights.length; i++){
    var sum = 0;
    for (var k = 0; k < pts.length; k++){
      var u = urbanFactorAt(area.model, area.grid, pts[k].lat, pts[k].lng, wdByHeight[i], heights[i]);
      sum += u.factor;
      if (u.w > maxW) maxW = u.w;
    }
    factor.push(sum / pts.length);
  }
  var first = pts[0], last = pts[pts.length - 1];
  var start = urbanFactorAt(area.model, area.grid, first.lat, first.lng, wdGround, 10);
  var dest = urbanFactorAt(area.model, area.grid, last.lat, last.lng, wdGround, 10);
  return { heights: heights.slice(), factor: factor, maxW: maxW, start: start, dest: dest };
}

// The factor for one height from routeUrbanFactors' result (linear
// between its heights, the end values beyond them); 1 without one.
export function urbanFactorFor(urban, height){
  if (!urban || !urban.heights.length) return 1;
  var hs = urban.heights, f = urban.factor;
  if (height <= hs[0]) return f[0];
  for (var i = 1; i < hs.length; i++){
    if (height <= hs[i]) return f[i - 1] + (f[i] - f[i - 1]) * (height - hs[i - 1]) / (hs[i] - hs[i - 1]);
  }
  return f[f.length - 1];
}
