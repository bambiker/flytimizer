// "Conditions here" button: a quick go/no-go for the start point (or,
// with no point on the map yet, the person's current location) right
// now, without planning a route - predicted navigation satellites and
// the Kp index, the highest height today's wind allows for this drone,
// and the round-trip range in every direction.

import { track } from './analytics.js';
import { BATTERY_RESERVE_PCT, readBatteryModel } from './battery.js';
import { CANDIDATE_HEIGHTS_M, forecastAt, readFlightInputs, roundTripRange, windByHeight } from './calc.js';
import { hourIndexNow, lat1, lng1, marker, useCurrentLocationAsStart } from './core.js';
import { kpIndexNow, kpLabel, visibleSatellites } from './gnss.js';
import { checkGpsCountry, gpsCheckHtml } from './spoof.js';
import { currentMission } from './mission.js';
import { hideNotice, showNotice } from './notice.js';
import { MAX_FLIGHT_ALTITUDE_M } from './osm.js';
import { compassWord, drawRangeOutline, rangeExtremes } from './range.js';
import { altitudePermitChecked, rulesForLocation } from './rules.js';
import { chooseUnits, escapeHtml, fmtDist, fmtLen, fmtSpeed } from './units.js';
import { getJSON } from './weather.js';

// The highest height (m above ground) the wind allows, climbing up
// from the lowest: the estimated gust stays under the drone's rated
// wind resistance and the wind is slower than the drone, so it can
// still make headway in any direction. Also says what stops it going
// higher. { ceilingM (null if even the lowest height is too windy),
// limit: 'gust' | 'speed' | 'legal' | 'top', at: index of the first
// height that fails, w }
export function windCeiling(heights, wx, inp, legalCapM){
  var w = windByHeight(heights, wx, 0, inp);
  var dragF = parseFloat(inp.drag) || 1;
  // Headway at the mission speed (Normal mode), the most a waypoint
  // mission flies.
  var speed = Math.min(inp.speedhorizontal, inp.speedhorizontalback);
  var ceiling = null;
  for (var i = 0; i < heights.length; i++){
    var limit = heights[i] > legalCapM + 0.01 ? 'legal'
      : !w.windResOk[i] ? 'gust'
      : w.ws[i] * dragF >= speed ? 'speed'
      : null;
    if (limit) return { ceilingM: ceiling, limit: limit, at: i, w: w };
    ceiling = heights[i];
  }
  return { ceilingM: ceiling, limit: 'top', at: -1, w: w };
}

function whereNow(){
  if (marker !== 0) return Promise.resolve({ lat: lat1, lng: lng1, mine: false });
  return new Promise(function(resolve, reject){
    if (!navigator.geolocation) return reject(new Error('unsupported'));
    navigator.geolocation.getCurrentPosition(function(pos){
      useCurrentLocationAsStart(pos.coords.latitude, pos.coords.longitude);
      resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, mine: true });
    }, reject, { timeout: 15000 });
  });
}

function row(label, html){
  return '<div class="cond-row"><dt>' + label + '</dt><dd>' + html + '</dd></div>';
}

export function hideConditions(){
  var card = document.getElementById('conditionsCard');
  if (card) card.hidden = true;
}

export async function checkConditions(){
  var btn = document.getElementById('conditionsBtn');
  var card = document.getElementById('conditionsCard');
  hideNotice('searchNotice');
  var place;
  try {
    place = await whereNow();
  } catch (err){
    track('conditions_check', { result: 'no_location' });
    showNotice('searchNotice', "Couldn't get your location (it may be turned off or not allowed for this site). Click the map or search for a place first, then press Conditions here.");
    return;
  }
  var label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    var now = new Date();
    var results = await Promise.all([
      getJSON().catch(function(err){ console.warn('Forecast lookup failed:', err); return null; }),
      rulesForLocation(place.lat, place.lng),
      visibleSatellites(place.lat, place.lng, now).catch(function(){ return null; }),
      kpIndexNow(),
      place.mine ? checkGpsCountry(place.lat, place.lng).catch(function(){ return null; }) : null
    ]);
    var json = results[0], rules = results[1], sats = results[2], kp = results[3], gpsCheck = results[4];
    chooseUnits(rules);
    var legalCapM = altitudePermitChecked() ? MAX_FLIGHT_ALTITUDE_M : Math.min(MAX_FLIGHT_ALTITUDE_M, rules.profile.maxAglM);
    var html = '';
    if (gpsCheck){
      html += row('GPS position check', gpsCheckHtml(gpsCheck, place.accuracy) +
        (gpsCheck.status === 'likely' || gpsCheck.status === 'possible' ? ' The figures below are for the reported position: click where you really are on the map and press Conditions here again.' : ''));
      track('gps_check', { result: gpsCheck.status, from: 'conditions' });
    }

    html += row('Satellites', sats
      ? '<strong>~' + sats.total + '</strong> navigation satellites above ' + 10 + '° (' +
        sats.groups.map(function(g){ return g.label + ' ' + g.count; }).join(', ') + ')' +
        (sats.missing ? ' — some constellations couldn’t be loaded' : '') +
        '. A prediction from their orbits; buildings, hills and trees hide some.'
      : 'Couldn’t load the satellite orbits right now.');
    if (kp !== null) html += row('GPS space weather', 'Kp <strong>' + kp.toFixed(0) + '</strong>: ' + kpLabel(kp));

    var mission = currentMission();
    var inp = readFlightInputs(mission);
    var heights = CANDIDATE_HEIGHTS_M.slice();
    if (json){
      var wx = forecastAt(json, Math.min(hourIndexNow(json.hourly.time), json.hourly.time.length - 1));
      var c = windCeiling(heights, wx, inp, legalCapM);
      var top;
      if (c.ceilingM === null){
        top = '<strong>Too windy to fly</strong> even at ' + fmtLen(heights[0]) + ': ' +
          (c.limit === 'gust' ? 'gusts around ' + fmtSpeed(c.w.estgust[0]) + ', over this drone’s ' + fmtSpeed(inp.windResistance) + ' rating'
            : 'wind ' + fmtSpeed(c.w.ws[0]) + ', as fast as the drone') + '.';
      } else {
        var i = heights.indexOf(c.ceilingM);
        top = 'Up to <strong>' + fmtLen(c.ceilingM) + '</strong> above the ground (wind ' + fmtSpeed(c.w.ws[i]) + ', gusts ~' + fmtSpeed(c.w.estgust[i]) + ' there)';
        top += c.limit === 'legal' ? ' — the legal limit here; the wind would allow more.'
          : c.limit === 'gust' ? ' — at ' + fmtLen(heights[c.at]) + ' gusts reach ~' + fmtSpeed(c.w.estgust[c.at]) + ', over this drone’s ' + fmtSpeed(inp.windResistance) + ' rating.'
          : c.limit === 'speed' ? ' — at ' + fmtLen(heights[c.at]) + ' the wind is as fast as the drone.'
          : '.';
      }
      html += row('Highest height in this wind', top);

      var battModel = readBatteryModel();
      var payloadOut = inp.payloadOutCoef;
      var ranges = roundTripRange({
        heights: heights, legalOk: heights.map(function(h){ return h <= legalCapM + 0.01; }), wx: wx, inp: inp, battModel: battModel,
        payloadOut: payloadOut, payloadBack: inp.payloadBackCoef, temperatureC: wx.temperatureC, mission: mission
      });
      var ext = rangeExtremes(ranges);
      drawRangeOutline(place.lat, place.lng, ranges, true);
      html += row('Farthest round trip', !battModel ? 'Enter the drone’s battery figures to see its range.'
        : !ext ? 'Not enough battery for a round trip in any direction right now.'
        : 'Up to <strong>' + fmtDist(ext.far.distM) + '</strong> toward the ' + compassWord(ext.far.bearing) +
          (ext.far.distM - ext.near.distM > 0.05 * ext.far.distM ? ', ' + fmtDist(ext.near.distM) + ' toward the ' + compassWord(ext.near.bearing) : ' in every direction') +
          ' and back, keeping a ' + BATTERY_RESERVE_PCT + '% reserve (dashed outline on the map).');
    } else {
      html += row('Wind', 'Couldn’t load the wind forecast right now, so the height and range can’t be worked out.');
    }

    var when = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    card.innerHTML = '<p class="cond-head">Conditions ' + (place.mine ? 'at your location' : 'at the start point') +
      ', ' + escapeHtml(when) + ' — ' + escapeHtml(document.getElementById('droneModel').selectedOptions[0].textContent) + '</p>' +
      '<dl>' + html + '</dl>';
    card.hidden = false;
    track('conditions_check', { result: json ? 'ok' : 'no_forecast', satellites: sats ? sats.total : -1, kp: kp === null ? -1 : kp });
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}
