// Entry point (the only script index.html loads): wires up the page's
// buttons and fields, builds the map, then restores saved settings or
// a shared route.
//
// Buttons say what they do with data-action (and data-arg), including
// ones the scripts create later, so one click listener handles them all.

import { track } from './analytics.js';
import { applyDronePreset, checkCustom } from './drone.js';
import { getHeight } from './calc.js';
import { clearMarkers, getLocation, searchLocation } from './core.js';
import { clearRouteLayers, initMap } from './map-view.js';
import { onMissionChange } from './mission.js';
import { hideNotice } from './notice.js';
import { clearPlans, selectPlan } from './plans.js';
import { syncRangeLayer } from './range.js';
import { initSharedState, shareRoute } from './share.js';
import { resetForecastOffset, setForecastOffset } from './weather.js';
import { downloadWPML } from './wpml.js';

// "Start over": clears the points, the route drawn on the map and the
// result, and the route from the address bar. Drone settings stay.
function startOver(){
  clearMarkers();
  clearRouteLayers();
  clearPlans();
  resetForecastOffset();
  document.getElementById('result').style.display = 'none';
  ['searchNotice', 'calcNotice', 'resultNotice'].forEach(hideNotice);
  document.getElementById('locationSearchInput').value = '';
  try { history.replaceState(null, '', location.pathname); } catch (e){}
  document.querySelector('.map-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

var ACTIONS = {
  search: searchLocation,
  locate: getLocation,
  calculate: getHeight,
  share: shareRoute,
  reset: startOver,
  plan: selectPlan,
  forecast: function(hour){ setForecastOffset(Number(hour)); },
  download: function(index){ downloadWPML(Number(index)); }
};

// Choices worth counting (outcomes like calculate or share are counted
// where they happen).
var TRACKED = {
  plan: function(arg){ return ['select_plan', { plan: arg }]; },
  forecast: function(arg){ return ['select_forecast_hour', { hours_ahead: Number(arg) }]; },
  reset: function(){ return ['start_over', {}]; }
};

document.addEventListener('click', function(e){
  var feedback = e.target.closest('a.feedback-link[href*="docs.google.com/forms"]');
  if (feedback) track('feedback_click', { place: 'footer' });
  var el = e.target.closest('[data-action]');
  if (!el || !ACTIONS[el.dataset.action]) return;
  if (TRACKED[el.dataset.action]) track.apply(null, TRACKED[el.dataset.action](el.dataset.arg));
  ACTIONS[el.dataset.action](el.dataset.arg);
});

document.getElementById('locationSearchInput').addEventListener('keydown', function(e){
  if (e.key === 'Enter'){
    e.preventDefault();
    searchLocation();
  }
});

// These run before the "save settings" listeners that initSharedState()
// adds to the same fields, so what gets saved is already up to date.
document.getElementById('mission').addEventListener('change', onMissionChange);
document.getElementById('droneModel').addEventListener('change', applyDronePreset);
['hor', 'asc', 'des', 'windres', 'batt', 'ftime', 'mass'].forEach(function(id){
  document.getElementById(id).addEventListener('input', checkCustom);
});

document.getElementById('rangeToggle').addEventListener('change', function(e){
  syncRangeLayer();
  track('toggle_range', { shown: e.target.checked });
});

initMap();
initSharedState();
