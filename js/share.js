// Shareable route URLs, remembered settings, and page start-up
// (initSharedState, called by app.js).

import { track } from './analytics.js';
import { getHeight } from './calc.js';
import { lat1, lat2, lng1, lng2, marker, setDestination, setstartloc } from './core.js';
import { DRONE_PRESETS, PRESET_FIELDS, applyDronePreset, updateDroneSummary } from './drone.js';
import { map } from './map-view.js';
import { onMissionChange } from './mission.js';
import { hideNotice, showNotice } from './notice.js';
import { UNITS_KEY } from './units.js';

// ---------------------------------------------------------------
// Shareable routes & remembered settings
//
// Every successful calculation writes the route into the address bar
// (?from=lat,lng&to=lat,lng&drone=...), so copying the URL - or the
// "Share this route" button - reproduces it exactly. Opening such a
// link places both markers, loads the drone settings and runs the
// calculation straight away.
//
// Separately, the drone settings and the last start point are kept in
// localStorage, so a returning visitor lands where they left off
// (unless they arrived through a shared link, which always wins).
// ---------------------------------------------------------------
export var SETTINGS_KEY = 'flytimizerSettings';
export var LAST_PLACE_KEY = 'flytimizerLastPlace';
export var SETTING_FIELDS = ['mission', 'speedMode', 'dwell', 'hor', 'asc', 'des', 'windres', 'batt', 'ftime', 'mass', 'drag', 'payload', 'payloadback', 'health'];

export function storageGet(key){
  try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e){ return null; }
}
export function storageSet(key, value){
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e){}
}

export function readSettings(){
  var out = { drone: document.getElementById('droneModel').value };
  SETTING_FIELDS.forEach(function(id){ out[id] = document.getElementById(id).value; });
  return out;
}

export function applySettings(st){
  if (!st) return;
  var sel = document.getElementById('droneModel');
  var isPreset = st.drone && Object.prototype.hasOwnProperty.call(DRONE_PRESETS, st.drone);
  if (isPreset || st.drone === 'custom') sel.value = st.drone;
  if (isPreset) applyDronePreset(); // load the preset's own numbers first
  SETTING_FIELDS.forEach(function(id){
    var v = st[id];
    if (id === 'mission'){
      if (v === 'delivery' || v === 'photo') document.getElementById('mission').value = v;
      return;
    }
    if (id === 'speedMode'){
      if (v === 'ground' || v === 'air') document.getElementById('speedMode').value = v;
      return;
    }
    if (v === undefined || v === null || v === '' || isNaN(parseFloat(v))) return;
    // For a preset only the payload/drag fields are personal; the
    // speeds come from the preset itself.
    if (isPreset && PRESET_FIELDS.indexOf(id) !== -1) return;
    document.getElementById(id).value = v;
  });
  updateDroneSummary();
}

export function saveSettings(){
  storageSet(SETTINGS_KEY, readSettings());
}

export function rememberStartPoint(lat, lng){
  storageSet(LAST_PLACE_KEY, { lat: lat, lng: lng });
}

export function routeUrl(){
  var params = new URLSearchParams();
  if (marker >= 1) params.set('from', lat1.toFixed(5) + ',' + lng1.toFixed(5));
  if (marker === 2) params.set('to', lat2.toFixed(5) + ',' + lng2.toFixed(5));
  var st = readSettings();
  params.set('drone', st.drone);
  SETTING_FIELDS.forEach(function(id){
    var speedField = PRESET_FIELDS.indexOf(id) !== -1;
    if (st.drone === 'custom' || !speedField) params.set(id, st[id]);
  });
  return location.origin + location.pathname + '?' + params.toString().replace(/%2C/g, ',');
}

export function updateUrlForRoute(){
  try { history.replaceState(null, '', routeUrl()); } catch (e){}
}

export async function shareRoute(){
  var url = routeUrl();
  var btn = document.getElementById('shareRouteBtn');
  hideNotice('resultNotice');
  if (navigator.share){
    try {
      await navigator.share({ title: 'Flytimizer route', text: 'Optimal drone altitude for this route, with live wind and terrain:', url: url });
      track('share_route', { method: 'share_sheet' });
      return;
    } catch (e){
      if (e && e.name === 'AbortError') return; // person closed the share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    track('share_route', { method: 'copy' });
    if (btn){
      var label = btn.textContent;
      btn.textContent = 'Link copied ✓';
      setTimeout(function(){ btn.textContent = label; }, 2000);
    }
  } catch (e){
    showNotice('resultNotice', 'Copy this link to share the route:', { copyText: url });
    track('share_route', { method: 'shown' });
  }
}

export function parseLatLngParam(v){
  if (!v) return null;
  var parts = v.split(',').map(parseFloat);
  if (parts.length !== 2 || parts.some(isNaN)) return null;
  if (Math.abs(parts[0]) > 90 || Math.abs(parts[1]) > 180) return null;
  return { lat: parts[0], lng: parts[1] };
}

// Returns 'route' when the URL carried a full route (so it should be
// calculated right away), 'start' for a start point only, or null.
export function restoreFromUrl(){
  var params = new URLSearchParams(location.search);
  var from = parseLatLngParam(params.get('from'));
  if (!from) return null;
  var st = { drone: params.get('drone') };
  SETTING_FIELDS.forEach(function(id){ if (params.has(id)) st[id] = params.get(id); });
  applySettings(st);
  setstartloc(from.lat, from.lng);
  var to = parseLatLngParam(params.get('to'));
  if (to){
    setDestination(to.lat, to.lng);
    map.fitBounds([[from.lat, from.lng], [to.lat, to.lng]], { padding: [40, 40], maxZoom: 16 });
    return 'route';
  }
  map.setView([from.lat, from.lng], 14);
  return 'start';
}

export function initSharedState(){
  var restored = restoreFromUrl();
  // Someone opened a shared link (a whole route, or just a start point).
  if (restored) track('open_shared_link', { kind: restored });
  if (!restored){
    applySettings(storageGet(SETTINGS_KEY));
    var last = storageGet(LAST_PLACE_KEY);
    if (last && typeof last.lat === 'number' && typeof last.lng === 'number'){
      map.setView([last.lat, last.lng], 14);
    }
  }

  var permitEl = document.getElementById('altPermit');
  if (permitEl){
    permitEl.checked = storageGet('flytimizerAltPermit') === true;
    permitEl.addEventListener('change', function(){ storageSet('flytimizerAltPermit', permitEl.checked); });
  }

  var unitsEl = document.getElementById('unitsSelect');
  if (unitsEl){
    var savedUnits = storageGet(UNITS_KEY);
    if (savedUnits === 'metric' || savedUnits === 'imperial') unitsEl.value = savedUnits;
    unitsEl.addEventListener('change', function(){
      storageSet(UNITS_KEY, unitsEl.value);
      // Re-run so every number re-renders (lookups come from cache).
      if (marker > 0 && document.getElementById('result').style.display === 'block') getHeight();
    });
  }

  document.getElementById('droneModel').addEventListener('change', saveSettings);
  SETTING_FIELDS.forEach(function(id){
    document.getElementById(id).addEventListener('input', saveSettings);
  });

  onMissionChange();

  if (restored === 'route'){
    window.addEventListener('load', function(){
      getHeight();
    });
  }
}
