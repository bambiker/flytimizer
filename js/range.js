// Round-trip range on the map: the outline of how far the drone can
// fly from the start and still get back, direction by direction (see
// roundTripRange in calc.js), plus a one-line summary in the result.

import { BATTERY_RESERVE_PCT } from './battery.js';
import { deg2rad } from './core.js';
import { map, rangeLayer } from './map-view.js';
import { fmtDist } from './units.js';

var EARTH_RADIUS_M = 6371000;

// The point distM along bearing (degrees, 0 = north) from lat/lng.
export function destinationPoint(lat, lng, bearing, distM){
  var d = distM / EARTH_RADIUS_M, b = deg2rad(bearing);
  var p1 = deg2rad(lat), l1 = deg2rad(lng);
  var p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  var l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 * 180 / Math.PI, lng: ((l2 * 180 / Math.PI) + 540) % 360 - 180 };
}

var COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
export function compassWord(bearing){
  return COMPASS[Math.round(((bearing % 360) + 360) % 360 / 45) % 8];
}

// Farthest and shortest directions, or null if the drone can't make
// a round trip anywhere.
export function rangeExtremes(ranges){
  if (!ranges || !ranges.length) return null;
  var far = ranges[0], near = ranges[0];
  ranges.forEach(function(r){
    if (r.distM > far.distM) far = r;
    if (r.distM < near.distM) near = r;
  });
  return far.distM > 0 ? { far: far, near: near } : null;
}

// Draws the outline (unless the person has switched it off) and fills
// in the summary. fit: zoom the map to it - used when there's only a
// start point, so the range is the main thing to look at.
export function renderRange(lat, lng, ranges, fit){
  var info = document.getElementById('rangeInfo');
  var text = document.getElementById('rangeText');
  rangeLayer.clearLayers();
  if (!ranges){
    info.style.display = 'none';
    return;
  }
  info.style.display = '';
  var ext = rangeExtremes(ranges);
  if (!ext){
    text.textContent = 'Not enough battery for a round trip in any direction right now, keeping a ' + BATTERY_RESERVE_PCT + '% reserve.';
    return;
  }
  var spread = ext.far.distM - ext.near.distM;
  text.textContent = 'Round trip from the start, keeping a ' + BATTERY_RESERVE_PCT + '% reserve: up to ' +
    fmtDist(ext.far.distM) + ' toward the ' + compassWord(ext.far.bearing) +
    (spread > 0.05 * ext.far.distM
      ? ', but only ' + fmtDist(ext.near.distM) + ' toward the ' + compassWord(ext.near.bearing) + ' because of the wind'
      : ' in every direction') +
    '. Straight out and back at your set speed; terrain, buildings and restricted areas aren’t counted, and most rules also require keeping the drone in sight.';
  var pts = ranges.map(function(r){
    var p = destinationPoint(lat, lng, r.bearing, r.distM);
    return [p.lat, p.lng];
  });
  var shape = L.polygon(pts, {
    // Not interactive, so clicks inside it still set points on the map.
    color: '#14b8a6', weight: 2, dashArray: '8 6', fillColor: '#14b8a6', fillOpacity: 0.08, interactive: false
  });
  shape.addTo(rangeLayer);
  syncRangeLayer();
  if (fit) map.fitBounds(shape.getBounds(), { padding: [20, 20] });
}

// The "Show on map" checkbox.
export function syncRangeLayer(){
  var on = document.getElementById('rangeToggle').checked;
  if (on && !map.hasLayer(rangeLayer)) rangeLayer.addTo(map);
  if (!on && map.hasLayer(rangeLayer)) map.removeLayer(rangeLayer);
}
