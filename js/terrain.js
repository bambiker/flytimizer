// The flight profile from the result: the side view, and the waypoints
// of the downloadable flight plan.

import { M_TO_FT, fmtDist, fmtLen, lenUnit, unitsImperial } from './units.js';
import { VIZ_COLORS, refreshVizTheme } from './visuals.js';

export var MAX_AGL_M = 120;                // legal ceiling, above ground

export function setMaxAglM(m){
  MAX_AGL_M = m;
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
