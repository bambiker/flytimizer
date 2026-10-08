// Terrain elevation and the above-ground altitude profile.

import { getDistanceFromLatLon } from './core.js';
import { BUILDING_HEIGHT_SAFETY_MARGIN_M, BUILDING_LATERAL_SAFETY_MARGIN_M, sleep } from './osm.js';
import { M_TO_FT, fmtDist, fmtLen, lenUnit, unitsImperial } from './units.js';
import { VIZ_COLORS, refreshVizTheme } from './visuals.js';

// ---------------------------------------------------------------
// Terrain (Open-Meteo Elevation API, Copernicus GLO-90 DEM)
//
// Heights in this app are heights ABOVE GROUND (AGL): the drone
// follows the terrain, so on a route from the Haifa shore up the
// Carmel it climbs with the ridge instead of holding one altitude
// above takeoff and flying into the hillside. That's also what makes
// the rest of the model consistent: wind forecasts (10/80/120 m) and
// building heights are both above-ground figures, and so is the
// 120 m legal ceiling.
//
// How a height h becomes a flyable altitude profile:
//  1. The route is sampled every ~30 m and each sample gets a ground
//     elevation (g). Buildings near the route raise the required
//     altitude at the samples they sit on (their ground + their
//     height + the usual 20 m margin).
//  2. Consecutive samples are grouped into level stretches, each
//     flown at the highest required altitude inside it. A stretch
//     only grows while the ground under it stays within
//     TERRAIN_LEVEL_TOLERANCE_M - so the drone is always >= h above
//     the ground (and buildings), and never more than h + tolerance
//     (capped at 120 m) above it.
//  3. Between stretches the drone climbs BEFORE reaching higher ground
//     and descends only AFTER leaving it, at its normal climb/descent
//     gradient. If that would put it more than 120 m above a valley,
//     progressively steeper transitions are tried. The result is
//     checked numerically at every sample (clearance and the 120 m
//     ceiling), not just assumed.
//
// Limits worth knowing: GLO-90 has ~90 m cells and is a surface
// model (it partly includes trees and big buildings), so narrow
// cliffs and gullies are smoothed out. Treat it as a planning aid on
// top of visual line of sight, not a guarantee of clearance.
// ---------------------------------------------------------------
export var ELEVATION_API = 'https://api.open-meteo.com/v1/elevation';
export var ELEVATION_BATCH = 100;          // API limit per request
export var ELEVATION_TIMEOUT_MS = 15000;
export var TERRAIN_SAMPLE_SPACING_M = 30;
export var TERRAIN_MAX_SAMPLES = 400;      // spacing widens on long routes to stay under this
export var TERRAIN_LEVEL_TOLERANCE_M = 15; // how much the ground may vary under one level stretch
export var MAX_AGL_M = 120;                // legal ceiling, above ground
export var elevationCache = new Map();

export function setMaxAglM(m){
  MAX_AGL_M = m;
}

export function elevationKey(p){
  return p.lat.toFixed(5) + ',' + p.lng.toFixed(5);
}

export async function fetchElevationBatch(batch){
  var url = ELEVATION_API +
    '?latitude=' + batch.map(function(p){ return p.lat.toFixed(5); }).join(',') +
    '&longitude=' + batch.map(function(p){ return p.lng.toFixed(5); }).join(',');
  var lastErr = null;
  for (var attempt = 0; attempt < 3; attempt++){
    var controller = new AbortController();
    var timer = setTimeout(function(){ controller.abort(); }, ELEVATION_TIMEOUT_MS);
    try {
      var response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('Elevation HTTP ' + response.status);
      var json = await response.json();
      var arr = json && json.elevation;
      if (!Array.isArray(arr) || arr.length !== batch.length) throw new Error('Elevation: unexpected response');
      for (var i = 0; i < arr.length; i++){
        if (typeof arr[i] !== 'number' || !isFinite(arr[i])) throw new Error('Elevation: missing value');
      }
      return arr;
    } catch (err){
      lastErr = err;
      await sleep(800 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function fetchElevations(points){
  var missing = [];
  var seen = {};
  points.forEach(function(p){
    var k = elevationKey(p);
    if (!elevationCache.has(k) && !seen[k]){ seen[k] = true; missing.push(p); }
  });
  var batches = [];
  for (var i = 0; i < missing.length; i += ELEVATION_BATCH){
    batches.push(missing.slice(i, i + ELEVATION_BATCH));
  }
  var results = await Promise.all(batches.map(fetchElevationBatch));
  batches.forEach(function(batch, bi){
    batch.forEach(function(p, pi){ elevationCache.set(elevationKey(p), results[bi][pi]); });
  });
  return points.map(function(p){ return elevationCache.get(elevationKey(p)); });
}

// Points along the path roughly every TERRAIN_SAMPLE_SPACING_M, each
// with its distance from the start (s). Every path vertex is kept.
export function densifyPath(path){
  var segLens = [], total = 0;
  for (var i = 0; i < path.length - 1; i++){
    var len = getDistanceFromLatLon(path[i].lat, path[i].lng, path[i+1].lat, path[i+1].lng);
    segLens.push(len);
    total += len;
  }
  var spacing = Math.max(TERRAIN_SAMPLE_SPACING_M, total / (TERRAIN_MAX_SAMPLES - 1));
  var out = [{ lat: path[0].lat, lng: path[0].lng, s: 0, isVertex: true }];
  var s = 0;
  for (var j = 0; j < segLens.length; j++){
    var n = Math.max(1, Math.ceil(segLens[j] / spacing));
    for (var k = 1; k <= n; k++){
      var t = k / n;
      out.push({
        lat: path[j].lat + (path[j+1].lat - path[j].lat) * t,
        lng: path[j].lng + (path[j+1].lng - path[j].lng) * t,
        s: s + segLens[j] * t,
        isVertex: k === n
      });
    }
    s += segLens[j];
  }
  return out;
}

export async function getTerrainProfile(path){
  var samples = densifyPath(path);
  var elev = await fetchElevations(samples);
  samples.forEach(function(p, k){ p.g = elev[k]; });
  return samples;
}

// Flat stand-in used when elevation data couldn't be loaded, so the
// rest of the calculation still runs (heights then mean "above
// takeoff", as before) - the UI warns loudly when this happens.
export function flatTerrainProfile(path){
  var samples = densifyPath(path);
  samples.forEach(function(p){ p.g = 0; });
  return samples;
}

// Extra altitude required at each sample by buildings we climb over:
// their (approximate) ground + height + safety margin, applied to
// every sample within the building's footprint + lateral margin.
export function buildingAltitudeRequirements(samples, buildingsNearPath){
  var req = samples.map(function(){ return -Infinity; });
  buildingsNearPath.forEach(function(b){
    var reach = b.radius + BUILDING_LATERAL_SAFETY_MARGIN_M;
    var hits = [];
    for (var k = 0; k < samples.length; k++){
      if (getDistanceFromLatLon(samples[k].lat, samples[k].lng, b.lat, b.lng) <= reach) hits.push(k);
    }
    if (hits.length === 0) return;
    // Building ground: the highest terrain among the samples it
    // touches (conservative - it may stand on the uphill side).
    var ground = -Infinity;
    hits.forEach(function(k){ ground = Math.max(ground, samples[k].g); });
    var top = ground + b.height + BUILDING_HEIGHT_SAFETY_MARGIN_M;
    hits.forEach(function(k){ req[k] = Math.max(req[k], top); });
  });
  return req;
}

export function reverseSamples(samples){
  var total = samples[samples.length - 1].s;
  return samples.slice().reverse().map(function(p){
    return { lat: p.lat, lng: p.lng, g: p.g, s: total - p.s, isVertex: p.isVertex };
  });
}

// Altitude at distance s along a list of {s, alt} profile points.
export function profileAltAt(pts, s){
  if (s <= pts[0].s) return pts[0].alt;
  for (var i = 0; i < pts.length - 1; i++){
    if (s <= pts[i+1].s){
      var span = pts[i+1].s - pts[i].s;
      var t = span > 0 ? (s - pts[i].s) / span : 1;
      return pts[i].alt + (pts[i+1].alt - pts[i].alt) * t;
    }
  }
  return pts[pts.length - 1].alt;
}

export function pushProfilePoint(pts, s, alt){
  var last = pts[pts.length - 1];
  if (last && Math.abs(last.s - s) < 0.01 && Math.abs(last.alt - alt) < 0.01) return;
  pts.push({ s: s, alt: alt });
}

// Climb/descent transitions between level stretches. climbRun and
// descRun are horizontal metres per metre of altitude change (0 =
// transition squeezed into the gap between two samples).
export function profileTransitions(segs, climbRun, descRun){
  var pts = [];
  pushProfilePoint(pts, segs[0].S, segs[0].alt);
  for (var i = 0; i < segs.length - 1; i++){
    var cur = segs[i], nxt = segs[i+1];
    var last = pts[pts.length - 1];
    if (nxt.alt > cur.alt){
      // Reach the higher altitude by the time the higher ground starts.
      var P = Math.min(cur.E, Math.max(cur.S, last.s, nxt.S - (nxt.alt - cur.alt) * climbRun));
      pushProfilePoint(pts, P, cur.alt);
      pushProfilePoint(pts, nxt.S, nxt.alt);
    } else {
      // Only start down once past the higher ground.
      var Q = Math.max(nxt.S, Math.min(nxt.E, cur.E + (cur.alt - nxt.alt) * descRun));
      pushProfilePoint(pts, cur.E, cur.alt);
      pushProfilePoint(pts, Q, nxt.alt);
    }
  }
  var lastSeg = segs[segs.length - 1];
  pushProfilePoint(pts, lastSeg.E, lastSeg.alt);
  return pts;
}

export function checkProfile(samples, R, pts){
  var minClear = Infinity, maxAGL = -Infinity, minAGL = Infinity, sumAGL = 0;
  for (var k = 0; k < samples.length; k++){
    var alt = profileAltAt(pts, samples[k].s);
    var agl = alt - samples[k].g;
    minClear = Math.min(minClear, alt - R[k]);
    maxAGL = Math.max(maxAGL, agl);
    minAGL = Math.min(minAGL, agl);
    sumAGL += agl;
  }
  return { minClear: minClear, maxAGL: maxAGL, minAGL: minAGL, meanAGL: sumAGL / samples.length };
}

// Drops profile points that aren't needed: a straight line from an
// anchor to a later point replaces everything in between, as long as
// it still clears every sample and stays under the ceiling there.
export function simplifyProfile(samples, R, pts){
  if (pts.length <= 2) return pts;
  var allowedAGL = samples.map(function(p){
    return Math.max(MAX_AGL_M, profileAltAt(pts, p.s) - p.g) + 0.01;
  });
  function firstSampleAfter(s){
    var lo = 0, hi = samples.length;
    while (lo < hi){ var mid = (lo + hi) >> 1; if (samples[mid].s <= s) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function lineOk(a, b){
    for (var k = firstSampleAfter(a.s); k < samples.length && samples[k].s < b.s; k++){
      var t = (samples[k].s - a.s) / (b.s - a.s);
      var alt = a.alt + (b.alt - a.alt) * t;
      if (alt < R[k] - 0.01 || alt - samples[k].g > allowedAGL[k]) return false;
    }
    return true;
  }
  var out = [pts[0]];
  var a = 0;
  while (a < pts.length - 1){
    var best = a + 1;
    for (var j = a + 2; j < pts.length && j <= a + 60; j++){
      if (lineOk(pts[a], pts[j])) best = j; else break;
    }
    out.push(pts[best]);
    a = best;
  }
  return out;
}

// Altitude profile (metres above sea level along the route) for
// target height-above-ground h. reqAlt: per-sample minimum altitude
// from buildings (see buildingAltitudeRequirements).
//
// mode 'follow' (default): terrain following, as described above.
// mode 'level': hold altitude - stay level until the ground or a
// building forces a climb, or the height limit over lower ground
// forces a descent. This "lazy" rule gives the least total climbing
// possible between the clearance floor and the legal ceiling.
export function buildAltitudeProfile(samples, h, reqAlt, climbRun, descRun, mode){
  var n = samples.length;
  var R = samples.map(function(p, k){ return Math.max(p.g + h, reqAlt[k]); });
  var T = Math.max(0, Math.min(TERRAIN_LEVEL_TOLERANCE_M, MAX_AGL_M - h));

  var segs = [];
  if (mode === 'level'){
    var cur = R[0];
    var feasible = true;
    for (var k = 0; k < n; k++){
      var ceil = samples[k].g + MAX_AGL_M;
      if (R[k] > ceil + 0.01) feasible = false;
      if (cur < R[k]) cur = R[k];
      else if (cur > ceil) cur = Math.max(ceil, R[k]);
      var last = segs[segs.length - 1];
      if (last && Math.abs(last.alt - cur) < 0.01) last.E = samples[k].s;
      else segs.push({ S: samples[k].s, E: samples[k].s, alt: cur });
    }
    return finishAltitudeProfile(samples, R, segs, climbRun, descRun, feasible);
  }

  var a = 0;
  while (a < n){
    var maxR = R[a], minG = samples[a].g, b = a;
    while (b + 1 < n){
      var nr = Math.max(maxR, R[b+1]), ng = Math.min(minG, samples[b+1].g);
      if (nr - ng > h + T) break;
      maxR = nr; minG = ng; b++;
    }
    var prev = segs[segs.length - 1];
    if (prev && Math.abs(prev.alt - maxR) < 0.01){
      prev.E = samples[b].s;
    } else {
      segs.push({ S: samples[a].s, E: samples[b].s, alt: maxR });
    }
    a = b + 1;
  }
  return finishAltitudeProfile(samples, R, segs, climbRun, descRun, true);
}

// Shared tail: transitions between level stretches (steepening them
// if needed to respect the ceiling), verification, simplification
// and climb/descent totals.
export function finishAltitudeProfile(samples, R, segs, climbRun, descRun, feasible){
  var n = samples.length;
  var pts = null, check = null;
  var steepness = [1, 0.5, 0.25, 0];
  for (var si = 0; si < steepness.length; si++){
    pts = profileTransitions(segs, climbRun * steepness[si], descRun * steepness[si]);
    check = checkProfile(samples, R, pts);
    if (check.maxAGL <= MAX_AGL_M + 0.5) break;
  }
  pts = simplifyProfile(samples, R, pts);

  var climbUp = Math.max(0, pts[0].alt - samples[0].g);         // takeoff
  var climbDown = Math.max(0, pts[pts.length - 1].alt - samples[n - 1].g); // landing
  for (var i = 1; i < pts.length; i++){
    var d = pts[i].alt - pts[i-1].alt;
    if (d > 0) climbUp += d; else climbDown -= d;
  }

  return {
    pts: pts,
    maxAGL: check.maxAGL,
    minClear: check.minClear,
    minAGL: check.minAGL,
    meanAGL: check.meanAGL,
    ok: feasible && check.maxAGL <= MAX_AGL_M + 0.5 && check.minClear >= -0.5,
    climbUp: climbUp,
    climbDown: climbDown
  };
}

// lat/lng at distance s along densified samples.
export function samplePointAt(samples, s){
  for (var i = 0; i < samples.length - 1; i++){
    if (s <= samples[i+1].s){
      var span = samples[i+1].s - samples[i].s;
      var t = span > 0 ? (s - samples[i].s) / span : 0;
      return {
        lat: samples[i].lat + (samples[i+1].lat - samples[i].lat) * t,
        lng: samples[i].lng + (samples[i+1].lng - samples[i].lng) * t
      };
    }
  }
  var last = samples[samples.length - 1];
  return { lat: last.lat, lng: last.lng };
}

// Mission waypoints for an outbound profile: every path turn plus
// every point where the altitude changes slope, with heights relative
// to the takeoff point (what DJI's relativeToStartPoint expects).
export function profileWaypoints(samples, prof){
  var dists = prof.pts.map(function(p){ return p.s; });
  samples.forEach(function(p){ if (p.isVertex) dists.push(p.s); });
  dists.sort(function(x, y){ return x - y; });
  var uniq = [];
  dists.forEach(function(d){
    if (uniq.length === 0 || d - uniq[uniq.length - 1] > 1) uniq.push(d);
  });
  var g0 = samples[0].g;
  return uniq.map(function(d){
    var pos = samplePointAt(samples, d);
    return { lat: pos.lat, lng: pos.lng, heightRel: profileAltAt(prof.pts, d) - g0 };
  });
}

// Side view of the route: ground, the 120 m-above-ground ceiling, and
// the planned outbound altitude.
// Side view of the route, start on the left: the ground, the
// above-ground height limit, and the planned altitude of each leg.
// back = { prof, h } for the return leg (its profile runs from the
// destination, so it's mirrored onto the same axis), or null.
// When both legs fly the same altitudes, one line is drawn and the
// legend says so; otherwise the return leg is a wider band under the
// outbound line, so stretches where they coincide show both colours.
// opts.turnInAir: a photo/inspection mission turns around in the air
// at the destination instead of landing there (the calculation skips
// that landing and takeoff too), so the lines don't drop to the ground
// there; the return line instead meets the outbound line's last
// altitude, showing any climb or descent between the two legs.
export function renderTerrainProfile(samples, prof, h, back, opts){
  opts = opts || {};
  var el = document.getElementById('terrainProfile');
  if (!el) return;
  if (!samples || !prof || samples[samples.length - 1].s < 1){
    el.style.display = 'none';
    return;
  }
  refreshVizTheme();
  var W = 600, H = 204, padL = 46, padR = 12, padT = 40, padB = 26;
  var total = samples[samples.length - 1].s;
  var outPts = prof.pts;
  var backPts = back && back.prof ? back.prof.pts.map(function(p){ return { s: total - p.s, alt: p.alt }; }).reverse() : null;
  var sameAlt = !!backPts && samples.every(function(p){
    return Math.abs(profileAltAt(outPts, p.s) - profileAltAt(backPts, p.s)) < 1;
  });

  var minG = Infinity, maxY = -Infinity;
  samples.forEach(function(p){ minG = Math.min(minG, p.g); maxY = Math.max(maxY, p.g + MAX_AGL_M); });
  outPts.concat(backPts || []).forEach(function(p){ maxY = Math.max(maxY, p.alt); });
  var y0 = Math.floor((minG - 10) / 10) * 10;
  var y1 = Math.ceil((maxY + 5) / 10) * 10;
  function X(s){ return padL + (s / total) * (W - padL - padR); }
  function Y(a){ return padT + (1 - (a - y0) / (y1 - y0)) * (H - padT - padB); }

  var ground = 'M' + X(0) + ',' + Y(y0);
  samples.forEach(function(p){ ground += ' L' + X(p.s).toFixed(1) + ',' + Y(p.g).toFixed(1); });
  ground += ' L' + X(total) + ',' + Y(y0) + ' Z';
  var ceiling = samples.map(function(p, i){ return (i ? 'L' : 'M') + X(p.s).toFixed(1) + ',' + Y(p.g + MAX_AGL_M).toFixed(1); }).join(' ');
  // A leg's line, from the ground at the start to the ground at the
  // destination - or, when turning in the air, to `endAlt` there.
  function flightPath(pts, endAlt){
    var d = pts.map(function(p, i){ return (i ? 'L' : 'M') + X(p.s).toFixed(1) + ',' + Y(p.alt).toFixed(1); }).join(' ');
    var end = endAlt === undefined ? samples[samples.length - 1].g : endAlt;
    return 'M' + X(0) + ',' + Y(samples[0].g) + ' L' + d.slice(1) + ' L' + X(total) + ',' + Y(end).toFixed(1);
  }
  var outEndAlt = outPts[outPts.length - 1].alt;

  var mono = 'font-family="JetBrains Mono, monospace" font-size="10"';
  var ticks = '';
  // Gridlines at round numbers in the display unit (m or ft).
  var uf = unitsImperial ? M_TO_FT : 1;
  var spanU = (y1 - y0) * uf;
  var step = spanU > 900 ? 300 : spanU > 300 ? 100 : spanU > 120 ? 50 : 20;
  for (var tu = Math.ceil(y0 * uf / step) * step; tu <= y1 * uf; tu += step){
    var t = tu / uf;
    ticks += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + Y(t) + '" y2="' + Y(t) + '" stroke="' + VIZ_COLORS.line + '" stroke-width="0.5"/>' +
      '<text x="' + (padL - 6) + '" y="' + (Y(t) + 3) + '" text-anchor="end" ' + mono + ' fill="' + VIZ_COLORS.muted + '">' + tu + '</text>';
  }
  var distLabel = fmtDist(total);

  // Legend row under the title: one entry per line drawn, then the limit.
  var legend = [];
  if (!backPts) legend.push({ color: VIZ_COLORS.accent, text: 'outbound (≥' + fmtLen(h) + ' AGL)' });
  else if (sameAlt) legend.push({ color: VIZ_COLORS.accent, text: 'outbound & return, same height (≥' + fmtLen(h) + ' AGL)' });
  else {
    legend.push({ color: VIZ_COLORS.accent, text: 'outbound (≥' + fmtLen(h) + ' AGL)' });
    legend.push({ color: VIZ_COLORS.accent2, width: 5, text: 'return (≥' + fmtLen(back.h) + ' AGL)' });
  }
  legend.push({ color: VIZ_COLORS.danger, dash: true, text: fmtLen(MAX_AGL_M) + ' AGL limit' });
  var lx = padL, legendSvg = '';
  legend.forEach(function(item){
    legendSvg += '<line x1="' + lx + '" x2="' + (lx + 14) + '" y1="25" y2="25" stroke="' + item.color + '" stroke-width="' + (item.dash ? 1 : (item.width || 2.2)) + '"' + (item.dash ? ' stroke-dasharray="4 3"' : '') + '/>' +
      '<text x="' + (lx + 18) + '" y="28" fill="' + VIZ_COLORS.muted + '">' + item.text + '</text>';
    lx += 18 + item.text.length * 6.1 + 18;
  });

  var title = backPts ? 'OUTBOUND & RETURN' : 'OUTBOUND';
  var ariaLegs = !backPts ? 'the planned outbound altitude'
    : sameAlt ? 'the planned altitude, the same for the outbound and return legs'
    : 'the planned outbound and return altitudes';
  el.innerHTML =
    '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Side view of the route: ground elevation, the above-ground height limit, and ' + ariaLegs + '">' +
      '<text x="' + padL + '" y="12" ' + mono + ' fill="' + VIZ_COLORS.muted + '">ALTITUDE ABOVE SEA LEVEL (' + lenUnit() + ') — ' + title + '</text>' +
      '<g ' + mono + '>' + legendSvg + '</g>' +
      ticks +
      '<path d="' + ground + '" fill="' + VIZ_COLORS.muted + '" fill-opacity="0.28" stroke="' + VIZ_COLORS.muted + '" stroke-width="1"/>' +
      '<path d="' + ceiling + '" fill="none" stroke="' + VIZ_COLORS.danger + '" stroke-width="1" stroke-dasharray="4 3"/>' +
      (backPts && !sameAlt ? '<path class="flight-return" d="' + flightPath(backPts, opts.turnInAir ? outEndAlt : undefined) + '" fill="none" stroke="' + VIZ_COLORS.accent2 + '" stroke-width="5" stroke-linejoin="round"/>' : '') +
      '<path class="flight-out" d="' + flightPath(outPts, opts.turnInAir ? outEndAlt : undefined) + '" fill="none" stroke="' + VIZ_COLORS.accent + '" stroke-width="2.2" stroke-linejoin="round"/>' +
      '<text x="' + padL + '" y="' + (H - 8) + '" ' + mono + ' fill="' + VIZ_COLORS.muted + '">start</text>' +
      '<text x="' + (W - padR) + '" y="' + (H - 8) + '" text-anchor="end" ' + mono + ' fill="' + VIZ_COLORS.muted + '">' + distLabel + '</text>' +
    '</svg>';
  el.style.display = 'block';
}
