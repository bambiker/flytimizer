// The wind among the buildings, from the buildings themselves (beta).
//
// urbanwind.js reads GHSL on a ~90 m grid: it knows how built-up a
// neighbourhood is, not whether a point is in a sheltered street or an
// open square. Where the drone takes off and lands, low down, that
// matters. Here the OpenStreetMap footprints around the point are
// rasterised to a 2 m height grid, and a model trained on the U-Net
// (itself trained on CFD) gives how much of the open-ground wind is
// left at that very point.
//
// fineFeatures() must stay identical to fine_features() in
// tools/urban_fine_features.py, which the training uses - the unit tests
// check them against values computed there.
//
// Until data/urban_fine_model.json exists the site keeps the GHSL model
// (loadFineModel rejects, and endpointWinds falls back).

import { estimateBuildingHeight, buildingHeightTagged, fetchOverpass, fillMissingBuildingHeights, OVERPASS_QUERY_TIMEOUT_S } from './osm.js';
import { predictLogRatio } from './urbanwind.js';

export var FINE_MODEL_URL = 'data/urban_fine_model.json';
export var FINE_CELL_M = 2;
export var FINE_WINDOW_M = 150;
export var FINE_N = Math.round(2 * FINE_WINDOW_M / FINE_CELL_M) + 1;   // 151
var ZMAX = 80, R_NEAR = 20, R_MID = 50, R_FAR = 150;
var UP_LEN = 100, UP_HALF = 30, UP_RAY_HALF = 10;
var SHELTER_MIN = -1, SHELTER_MAX = 5;
// Below this share of built ground within 150 m in OSM while GHSL says
// the place is built up, OSM probably lacks the buildings there: the
// GHSL model is used instead.
export var FINE_MIN_LAM150 = 0.03;
var M_PER_DEG = 111320;

// [z, zrel, lam20, lam50, lam150, hm50, hm150, dbld, hnear, lamup,
// shelter, updist] at the middle cell of grid { H (Float32Array, row 0
// north), n }, height z (m), wind from wdir (degrees).
export function fineFeatures(grid, z, wdir){
  var H = grid.H, n = grid.n, ci = (n - 1) / 2;
  z = Math.min(z, ZMAX);
  var n20 = 0, b20 = 0, n50 = 0, b50 = 0, n150 = 0, b150 = 0, s50 = 0, s150 = 0;
  var dbld = R_FAR, hnear = 0, nup = 0, bup = 0, shelter = SHELTER_MIN, updist = R_FAR;
  for (var r = 0; r < n; r++){
    var dN = (ci - r) * FINE_CELL_M;
    for (var c = 0; c < n; c++){
      var dE = (c - ci) * FINE_CELL_M;
      var d = Math.hypot(dN, dE);
      if (d > R_FAR) continue;
      var h = H[r * n + c], built = h > 0;
      n150++;
      if (built){ b150++; s150 += h; }
      if (d <= R_MID){
        n50++;
        if (built){ b50++; s50 += h; }
        if (d <= R_NEAR){ n20++; if (built) b20++; }
      }
      if (built && (d < dbld || (d === dbld && h > hnear))){ dbld = d; hnear = h; }
      if (d === 0) continue;
      var brg = ((Math.atan2(dE, dN) * 180 / Math.PI) % 360 + 360) % 360;
      var off = Math.abs(((brg - wdir + 180) % 360 + 360) % 360 - 180);
      if (off <= UP_HALF && d <= UP_LEN){
        nup++;
        if (built){ bup++; shelter = Math.max(shelter, (h - z) / Math.max(d, FINE_CELL_M)); }
      }
      if (built && off <= UP_RAY_HALF && d < updist) updist = d;
    }
  }
  var hm50 = b50 ? s50 / b50 : 0, hm150 = b150 ? s150 / b150 : 0;
  shelter = Math.min(Math.max(shelter, SHELTER_MIN), SHELTER_MAX);
  return [z, z / Math.max(hm50, 3), b20 / n20, b50 / n50, b150 / n150, hm50, hm150,
          dbld, hnear, nup ? bup / nup : 0, shelter, updist];
}

// Building footprints ([{ pts: [{lat, lng}], height }]) burnt into the
// 2 m grid centred on (lat, lng); where they overlap the taller wins.
export function rasterizeBuildings(buildings, lat, lng){
  var n = FINE_N, ci = (n - 1) / 2, H = new Float32Array(n * n);
  var coslat = Math.cos(lat * Math.PI / 180);
  buildings.forEach(function(b){
    if (!(b.height > 0) || b.pts.length < 3) return;
    // Footprint in metres east (x) and north (y) of the point.
    var xs = [], ys = [];
    b.pts.forEach(function(p){ xs.push((p.lng - lng) * M_PER_DEG * coslat); ys.push((p.lat - lat) * M_PER_DEG); });
    var c0 = Math.max(0, Math.floor(Math.min.apply(null, xs) / FINE_CELL_M + ci)), c1 = Math.min(n - 1, Math.ceil(Math.max.apply(null, xs) / FINE_CELL_M + ci));
    var r0 = Math.max(0, Math.floor(ci - Math.max.apply(null, ys) / FINE_CELL_M)), r1 = Math.min(n - 1, Math.ceil(ci - Math.min.apply(null, ys) / FINE_CELL_M));
    for (var r = r0; r <= r1; r++){
      var y = (ci - r) * FINE_CELL_M;
      for (var c = c0; c <= c1; c++){
        var x = (c - ci) * FINE_CELL_M, inside = false;
        for (var i = 0, j = xs.length - 1; i < xs.length; j = i++){
          if ((ys[i] > y) !== (ys[j] > y) && x < (xs[j] - xs[i]) * (y - ys[i]) / (ys[j] - ys[i]) + xs[i]) inside = !inside;
        }
        if (inside && b.height > H[r * n + c]) H[r * n + c] = b.height;
      }
    }
  });
  return { H: H, n: n };
}

// { factor, ratio, inBuilding, lam150 } at the middle of the grid; the
// ratio is what the model says is left of the open-ground wind.
export function fineFactorAt(model, grid, z, wdir){
  var x = fineFeatures(grid, z, wdir);
  var ratio = Math.min(Math.max(Math.exp(predictLogRatio(model, x)), 0.05), 3);
  return { factor: ratio, ratio: ratio, inBuilding: x[7] === 0, lam150: x[4] };
}

async function fetchModel(){
  var r = await fetch(FINE_MODEL_URL);
  if (!r.ok) throw new Error('Fine wind model HTTP ' + r.status);
  return r.json();
}
// Tests swap fineIO.fetchModel.
export var fineIO = { fetchModel: fetchModel };
var modelPromise = null;
export function loadFineModel(){
  if (!modelPromise){
    modelPromise = fineIO.fetchModel();
    modelPromise.catch(function(){ modelPromise = null; });
  }
  return modelPromise;
}
export function resetFine(){ modelPromise = null; }

// The building footprints within the window around a point, from
// OpenStreetMap, with heights as the rest of the site estimates them
// (tags, then GHSL where OSM has none).
export async function getBuildingFootprints(lat, lng){
  var query = '[out:json][timeout:' + OVERPASS_QUERY_TIMEOUT_S + '];' +
    'way["building"](around:' + Math.ceil(FINE_WINDOW_M * 1.5) + ',' + lat.toFixed(6) + ',' + lng.toFixed(6) + ');out tags geom;';
  var data = await fetchOverpass(query);
  var list = (data.elements || []).filter(function(el){ return el.geometry && el.geometry.length >= 3; }).map(function(el){
    var tags = el.tags || {}, pts = el.geometry.map(function(g){ return { lat: g.lat, lng: g.lon }; });
    var c = pts.reduce(function(a, p){ return { lat: a.lat + p.lat / pts.length, lng: a.lng + p.lng / pts.length }; }, { lat: 0, lng: 0 });
    return { pts: pts, lat: c.lat, lng: c.lng, height: estimateBuildingHeight(tags), heightSource: buildingHeightTagged(tags) ? 'osm' : 'guess' };
  });
  await fillMissingBuildingHeights(list);
  return list;
}

// What endpointWinds needs at a point: the model and the grid. Rejects
// if either can't be had (no model yet, OSM down). The model first:
// without it there's nothing to look the buildings up for.
export async function loadFineArea(lat, lng){
  var model = await loadFineModel();
  var buildings = await getBuildingFootprints(lat, lng);
  return { model: model, grid: rasterizeBuildings(buildings, lat, lng), count: buildings.length };
}
