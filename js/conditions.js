// "Conditions here" button: a quick go/no-go for the start point (or,
// with no point on the map yet, the person's current location) right
// now, without planning a route - predicted navigation satellites and
// the Kp index, the highest height today's wind allows for this drone,
// and the round-trip range in every direction. The engine works them
// out (engine-client.js); this draws the card.

import { track } from './analytics.js';
import { readBatteryFields } from './battery.js';
import { readFlightInputs } from './calc.js';
import { lat1, lng1, marker, useCurrentLocationAsStart } from './core.js';
import { compute } from './engine-client.js';
import { BATTERY_RESERVE_PCT } from './labels.js';
import { checkGpsCountry, gpsCheckHtml } from './spoof.js';
import { currentMission } from './mission.js';
import { hideNotice, showNotice } from './notice.js';
import { compassWord, drawRangeOutline } from './range.js';
import { altitudePermitChecked } from './rules.js';
import { chooseUnits, escapeHtml, fmtDist, fmtLen, fmtSpeed } from './units.js';

export function kpLabel(kp){
  if (kp >= 7) return 'severe geomagnetic storm — GPS may be unreliable';
  if (kp >= 5) return 'geomagnetic storm — GPS accuracy may be reduced';
  if (kp >= 4) return 'active — mostly fine, watch the GPS signal';
  return 'quiet — no effect on GPS expected';
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
    var mission = currentMission();
    var inp = readFlightInputs(mission);
    var results = await Promise.all([
      compute('conditions', { place: { lat: place.lat, lng: place.lng }, mission: mission, inp: inp, battery: readBatteryFields(),
                              altPermit: altitudePermitChecked(), now: now.getTime() }),
      place.mine ? checkGpsCountry(place.lat, place.lng).catch(function(){ return null; }) : null
    ]);
    var C = results[0], gpsCheck = results[1];
    if (C.error){
      track('conditions_check', { result: C.error === 'busy' ? 'engine_busy' : 'engine_error' });
      showNotice('searchNotice', C.error === 'busy'
        ? 'Too many calculations from your connection in the last few minutes. Please wait a little and try again.'
        : 'Couldn’t reach Flytimizer’s calculation server. It may be starting up - trying again in a minute usually works.');
      return;
    }
    var sats = C.sats, kp = C.kp;
    chooseUnits(C.rules);
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

    var heights = C.heights;
    if (C.forecast){
      var c = C.ceiling;
      c.w = { ws: c.ws, estgust: c.estgust };
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

      var ext = C.rangeExt;
      drawRangeOutline(place.lat, place.lng, C.ranges, true);
      html += row('Farthest round trip', !C.battery ? 'Enter the drone’s battery figures to see its range.'
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
    track('conditions_check', { result: C.forecast ? 'ok' : 'no_forecast', satellites: sats ? sats.total : -1, kp: kp === null ? -1 : kp });
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}
