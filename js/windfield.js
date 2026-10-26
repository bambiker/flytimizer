// The wind along a route, stretch by stretch.
//
// Every stretch of a leg (between two terrain samples, ~30 m apart)
// gets its own wind:
//  - the forecast at the nearest forecast point (the start, and on a
//    long route a few more points along it, see weather.js);
//  - the building effect at that very place (urbanwind.js), worked
//    out every ~URBAN_SNAP_M and cached;
//  - its own heading, so a detour that turns into the wind is slower
//    there than the straight line would suggest.
// From that each stretch gets its own ground speed and airspeed, which
// battery.js turns into time and energy stretch by stretch.
//
// The safety checks stay on the side of caution: the gust and
// crosswind checks use the forecast wind without the building
// slow-down (buildings make the wind gustier even where they slow it),
// and the strongest of the forecast points.

import { airspeedFor, getDistanceFromLatLon, groundSpeed, interpDir, trueBearing } from './core.js';
import { urbanFactorAt } from './urbanwind.js';

export var URBAN_SNAP_M = 100;
var M_PER_DEG = 111320;

// Average wind (m/s) and direction (degrees from) at height h, between
// the forecast's 10, 80 and 120 m levels.
export function windAtHeight(wx, h){
  if (h < 80) return { ws: wx.ws10 * (80 - h) / 70 + wx.ws80 * (h - 10) / 70, wd: interpDir(wx.wd10, wx.wd80, (h - 10) / 70) };
  if (h === 80) return { ws: wx.ws80, wd: wx.wd80 };
  if (h === 120) return { ws: wx.ws120, wd: wx.wd120 };
  return { ws: wx.ws80 * (120 - h) / 40 + wx.ws120 * (h - 80) / 40, wd: interpDir(wx.wd80, wx.wd120, (h - 80) / 40) };
}

// points: [{ lat, lng, wx }] - at least one (the start). urbanArea:
// loadUrbanArea's result, or null for the forecast as it is.
export function makeWindField(points, urbanArea, heights){
  var cache = new Map();
  function nearest(lat, lng){
    if (points.length === 1) return points[0];
    var best = points[0], bestD = Infinity;
    points.forEach(function(p){
      var d = getDistanceFromLatLon(lat, lng, p.lat, p.lng);
      if (d < bestD){ bestD = d; best = p; }
    });
    return best;
  }
  function urbanFactor(lat, lng, wd, i){
    if (!urbanArea) return 1;
    // Snap to a ~100 m grid so neighbouring stretches share the work.
    var sLat = URBAN_SNAP_M / M_PER_DEG, sLng = sLat / Math.cos(lat * Math.PI / 180);
    var la = Math.round(lat / sLat) * sLat, lo = Math.round(lng / sLng) * sLng;
    var key = i + ':' + la.toFixed(6) + ',' + lo.toFixed(6) + ':' + Math.round(wd / 5);
    if (!cache.has(key)) cache.set(key, urbanFactorAt(urbanArea.model, urbanArea.grid, la, lo, wd, heights[i]).factor);
    return cache.get(key);
  }
  return {
    // { ws (with the building effect), wsCheck (never below the
    // forecast), wd, gustFactor } at a place, for heights[i].
    at: function(lat, lng, i){
      var p = nearest(lat, lng);
      var w = windAtHeight(p.wx, heights[i]);
      var f = urbanFactor(lat, lng, w.wd, i);
      return { ws: w.ws * f, wsCheck: Math.max(w.ws, w.ws * f), wd: w.wd, gustFactor: p.wx.gustFactor };
    },
    // The strongest estimated gust (m/s) at heights[i] over the
    // forecast points, without the building slow-down.
    maxGust: function(i){
      return points.reduce(function(m, p){ return Math.max(m, windAtHeight(p.wx, heights[i]).ws * p.wx.gustFactor); }, 0);
    }
  };
}

// The wind on every stretch of a leg (samples in flying order), for
// every height: { len: [k], brg: [k], ws: [i][k], wsCheck: [i][k],
// wd: [i][k], gustOk: [i] } - stretch k runs from sample k to k+1.
export function routeSegments(samples, heights, field, windResistance){
  var seg = { len: [], brg: [], ws: [], wsCheck: [], wd: [], gustOk: [] };
  var mids = [];
  for (var k = 0; k + 1 < samples.length; k++){
    var a = samples[k], b = samples[k + 1];
    seg.len.push(b.s - a.s);
    seg.brg.push(trueBearing(a.lat, a.lng, b.lat, b.lng));
    mids.push({ lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 });
  }
  for (var i = 0; i < heights.length; i++){
    seg.ws[i] = []; seg.wsCheck[i] = []; seg.wd[i] = [];
    var gustOk = field.maxGust(i) < windResistance;
    for (k = 0; k < mids.length; k++){
      var w = field.at(mids[k].lat, mids[k].lng, i);
      seg.ws[i].push(w.ws); seg.wsCheck[i].push(w.wsCheck); seg.wd[i].push(w.wd);
      if (w.wsCheck * w.gustFactor >= windResistance) gustOk = false;
    }
    seg.gustOk[i] = gustOk;
  }
  return seg;
}

// Ground speed and airspeed on every stretch at horizontal speed hs:
// { gs: [i][k], air: [i][k] }. A stretch the drone can't fly (crosswind
// as strong as the drone, or no headway) gets ground speed 0, which
// makes that height unflyable for the leg.
export function legSegmentSpeeds(seg, hs, inp){
  var holdGround = inp.speedMode !== 'air';
  var dragF = parseFloat(inp.drag) || 1;
  var out = { gs: [], air: [] };
  for (var i = 0; i < seg.ws.length; i++){
    out.gs[i] = []; out.air[i] = [];
    for (var k = 0; k < seg.len.length; k++){
      // The formulas take the wind's angle to the reverse of the heading.
      var diff = (seg.wd[i][k] - (seg.brg[k] + 180)) / 180 * Math.PI;
      var windF = seg.ws[i][k] * dragF;
      var cross = seg.wsCheck[i][k] * Math.abs(Math.sin(diff));
      var gsMax = cross < hs ? groundSpeed(hs, windF, diff) : 0;
      var gs, air;
      if (holdGround){
        gs = Math.min(hs, gsMax);
        air = gs > 0 ? airspeedFor(gs, windF, diff) : hs;
      } else {
        gs = gsMax;
        air = hs;
      }
      out.gs[i].push(isFinite(gs) && gs > 0 ? gs : 0);
      out.air[i].push(air);
    }
  }
  return out;
}
