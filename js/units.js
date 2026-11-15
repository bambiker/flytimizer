// Units and number formatting.

import { MILE_M } from './rules.js';

// ---------------------------------------------------------------
// Units
//
// Results show in imperial units (ft, mph, mi) for routes in the US
// and metric elsewhere, unless the person picks one explicitly.
// Inputs (drone speeds etc.) stay metric for now.
// ---------------------------------------------------------------
export var unitsImperial = false;
export var UNITS_KEY = 'flytimizerUnits';
export var M_TO_FT = 3.28084;

export function chooseUnits(rules){
  var sel = document.getElementById('unitsSelect');
  var pref = sel ? sel.value : 'auto';
  if (pref === 'metric') unitsImperial = false;
  else if (pref === 'imperial') unitsImperial = true;
  else unitsImperial = !rules.fallback && rules.profile.code === 'US';
}

export function lenNum(m){ return Math.round(unitsImperial ? m * M_TO_FT : m); }
// Place and country names come from OpenStreetMap, which anyone can
// edit, and end up in innerHTML and Leaflet tooltips (which render
// HTML) - escape them so a name can't inject markup or script.
export function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, function(c){
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

export function lenUnit(){ return unitsImperial ? 'ft' : 'm'; }
export function fmtLen(m){ return lenNum(m) + ' ' + lenUnit(); }
export function fmtSpeed(ms){ return unitsImperial ? (ms * 2.23694).toFixed(1) + ' mph' : ms.toFixed(1) + ' m/s'; }
export function fmtDist(m){
  if (unitsImperial){
    return m >= 0.25 * MILE_M ? (m / MILE_M).toFixed(2) + ' mi' : Math.round(m * M_TO_FT) + ' ft';
  }
  return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
}
