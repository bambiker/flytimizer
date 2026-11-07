// The 48-hour outlook strip under the result, and the hour picked in it.

import { getHeight } from './calc.js';
import { fmtLen, fmtSpeed } from './units.js';


// ---------------------------------------------------------------
// 48-hour outlook
//
// A strip of 48 hourly bars under the result: bar height = wind at
// 80 m, colour = a quick go/no-go from the same rules the full
// calculation uses (estimated gusts vs the drone's wind rating, and
// rain). Tapping an hour re-plans the route for that hour - the map
// lookups are cached, so only the numbers change.
// ---------------------------------------------------------------
export var forecastOffsetH = 0;
export var FORECAST_HOURS = 48;

export function forecastHourInfo(json, idx, windres){
  var H = json.hourly;
  var w10 = H.wind_speed_10m[idx] / 3.6, w80 = H.wind_speed_80m[idx] / 3.6, w120 = H.wind_speed_120m[idx] / 3.6;
  var g10 = H.wind_gusts_10m[idx] / 3.6;
  var gf = w10 > 0.1 ? Math.min(Math.max(g10 / w10, 1), 3) : 1;
  var w30 = w10 * 50 / 70 + w80 * 20 / 70; // same interpolation as the main calculation
  var gustLow = w30 * gf, gustHigh = w120 * gf;
  var pp = H.precipitation_probability[idx] || 0, pr = H.precipitation[idx] || 0;
  var status = 'good';
  if (gustLow >= windres || pp >= 50 || pr > 0.2) status = 'bad';
  else if (gustHigh >= windres || pp >= 20 || pr > 0) status = 'fair';
  return { status: status, w80: w80, gustLow: gustLow, gustHigh: gustHigh, pp: pp, time: new Date(H.time[idx] + 'Z') };
}

export function forecastTimeLabel(d, withDay){
  var now = new Date();
  var tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  var day = d.toDateString() === now.toDateString() ? 'Today'
    : d.toDateString() === tomorrow.toDateString() ? 'Tomorrow'
    : d.toLocaleDateString([], { weekday: 'short' });
  var t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return withDay ? day + ' ' + t : t;
}

export function renderForecastStrip(json, nowIdx){
  var box = document.getElementById('forecastStrip');
  if (!box || !json || !json.hourly) return;
  var windres = parseFloat(document.getElementById('windres').value) || 10;
  var n = Math.min(FORECAST_HOURS, json.hourly.time.length - nowIdx);
  var infos = [];
  var maxW = 1;
  for (var k = 0; k < n; k++){
    infos.push(forecastHourInfo(json, nowIdx + k, windres));
    maxW = Math.max(maxW, infos[k].w80);
  }
  var bars = infos.map(function(f, k){
    var label = forecastTimeLabel(f.time, true) + ': wind ' + fmtSpeed(f.w80) + ' at ' + fmtLen(80) +
      ', gusts ' + fmtSpeed(f.gustLow) + '–' + fmtSpeed(f.gustHigh) + ', rain ' + f.pp.toFixed(0) + '%' +
      (f.status === 'bad' ? ' — not recommended' : f.status === 'fair' ? ' — marginal' : ' — good');
    var h = Math.max(8, Math.round(f.w80 / maxW * 100));
    var tick = (f.time.getHours() % 6 === 0) ? '<span class="fc-tick" aria-hidden="true">' + (f.time.getHours() === 0 ? f.time.toLocaleDateString([], { weekday: 'short' }) : String(f.time.getHours()).padStart(2, '0')) + '</span>' : '';
    return '<button type="button" class="fc-bar fc-' + f.status + (k === forecastOffsetH ? ' fc-selected' : '') + '" title="' + label + '" aria-label="' + label + '" data-action="forecast" data-arg="' + k + '">' +
      '<span class="fc-fill" style="height:' + h + '%"></span>' + tick + '</button>';
  }).join('');
  box.innerHTML = '<div class="fc-bars">' + bars + '</div>';

  var sel = infos[Math.min(forecastOffsetH, infos.length - 1)];
  var head = document.getElementById('forecastSelected');
  if (head && sel){
    head.textContent = 'Planning for ' + forecastTimeLabel(sel.time, true) + (forecastOffsetH === 0 ? ' (now)' : '');
  }
  var nowBtn = document.getElementById('forecastNowBtn');
  if (nowBtn) nowBtn.style.display = forecastOffsetH === 0 ? 'none' : '';
}

// Back to planning for now, without recalculating (used by Start over).
export function resetForecastOffset(){
  forecastOffsetH = 0;
}

export function setForecastOffset(k){
  forecastOffsetH = Math.max(0, Math.min(FORECAST_HOURS - 1, k));
  getHeight();
}
