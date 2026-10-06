// Units and number formatting.

// ---------------------------------------------------------------
// Units
//
// Results show in imperial units (ft, mph, mi) for routes in the US
// and metric elsewhere, unless the person picks one explicitly.
// Inputs (drone speeds etc.) stay metric for now.
// ---------------------------------------------------------------
var unitsImperial = false;
var UNITS_KEY = 'flytimizerUnits';
var M_TO_FT = 3.28084;

function chooseUnits(rules){
  var sel = document.getElementById('unitsSelect');
  var pref = sel ? sel.value : 'auto';
  if (pref === 'metric') unitsImperial = false;
  else if (pref === 'imperial') unitsImperial = true;
  else unitsImperial = !rules.fallback && rules.profile.code === 'US';
}

function lenNum(m){ return Math.round(unitsImperial ? m * M_TO_FT : m); }
// Place and country names come from OpenStreetMap, which anyone can
// edit, and end up in innerHTML and Leaflet tooltips (which render
// HTML) - escape them so a name can't inject markup or script.
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, function(c){
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function lenUnit(){ return unitsImperial ? 'ft' : 'm'; }
function fmtLen(m){ return lenNum(m) + ' ' + lenUnit(); }
function fmtSpeed(ms){ return unitsImperial ? (ms * 2.23694).toFixed(1) + ' mph' : ms.toFixed(1) + ' m/s'; }
function fmtDist(m){
  if (unitsImperial){
    return m >= 0.25 * MILE_M ? (m / MILE_M).toFixed(2) + ' mi' : Math.round(m * M_TO_FT) + ' ft';
  }
  return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
}
