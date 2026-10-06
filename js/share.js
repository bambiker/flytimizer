// Shareable route URLs, remembered settings, and page start-up.
// Loaded last: its start-up code uses everything above.

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
var SETTINGS_KEY = 'flytimizerSettings';
var LAST_PLACE_KEY = 'flytimizerLastPlace';
var SETTING_FIELDS = ['mission', 'dwell', 'hor', 'asc', 'des', 'windres', 'batt', 'ftime', 'mass', 'drag', 'payload', 'payloadback', 'health'];

function storageGet(key){
  try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e){ return null; }
}
function storageSet(key, value){
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e){}
}

function readSettings(){
  var out = { drone: document.getElementById('droneModel').value };
  SETTING_FIELDS.forEach(function(id){ out[id] = document.getElementById(id).value; });
  return out;
}

function applySettings(st){
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
    if (v === undefined || v === null || v === '' || isNaN(parseFloat(v))) return;
    // For a preset only the payload/drag fields are personal; the
    // speeds come from the preset itself.
    if (isPreset && PRESET_FIELDS.indexOf(id) !== -1) return;
    document.getElementById(id).value = v;
  });
  updateDroneSummary();
}

function saveSettings(){
  storageSet(SETTINGS_KEY, readSettings());
}

function rememberStartPoint(lat, lng){
  storageSet(LAST_PLACE_KEY, { lat: lat, lng: lng });
}

// Places (or moves) the destination marker - the programmatic twin
// of the second map click in addMarker().
function setDestination(lat, lng){
  if (marker === 0) return;
  if (marker === 1){
    marker = 2;
    marker2 = new L.marker([lat, lng], { draggable: true, autoPan: true }).addTo(map);
    marker2.bindTooltip('Destination');
    marker2.on('dragend', function(){ markerLocation(2, marker2); });
  } else {
    marker2.setLatLng([lat, lng]);
  }
  markerLocation(2, marker2);
}

function routeUrl(){
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

function updateUrlForRoute(){
  try { history.replaceState(null, '', routeUrl()); } catch (e){}
}

async function shareRoute(){
  var url = routeUrl();
  var btn = document.getElementById('shareRouteBtn');
  if (navigator.share){
    try {
      await navigator.share({ title: 'Flytimizer route', text: 'Optimal drone altitude for this route, with live wind and terrain:', url: url });
      return;
    } catch (e){
      if (e && e.name === 'AbortError') return; // person closed the share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    if (btn){
      var label = btn.textContent;
      btn.textContent = 'Link copied ✓';
      setTimeout(function(){ btn.textContent = label; }, 2000);
    }
  } catch (e){
    window.prompt('Copy this link to share the route:', url);
  }
}

function parseLatLngParam(v){
  if (!v) return null;
  var parts = v.split(',').map(parseFloat);
  if (parts.length !== 2 || parts.some(isNaN)) return null;
  if (Math.abs(parts[0]) > 90 || Math.abs(parts[1]) > 180) return null;
  return { lat: parts[0], lng: parts[1] };
}

// Returns 'route' when the URL carried a full route (so it should be
// calculated right away), 'start' for a start point only, or null.
function restoreFromUrl(){
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

(function initSharedState(){
  var restored = restoreFromUrl();
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
      if (marker > 0 && document.getElementById('result').style.display === 'block' && typeof getHeight === 'function') getHeight();
    });
  }

  document.getElementById('droneModel').addEventListener('change', saveSettings);
  SETTING_FIELDS.forEach(function(id){
    document.getElementById(id).addEventListener('input', saveSettings);
  });

  onMissionChange();

  if (restored === 'route'){
    window.addEventListener('load', function(){
      if (typeof getHeight === 'function') getHeight();
    });
  }
})();
