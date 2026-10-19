// Which restricted-area types the route steers around.
//
// Airports, military sites, prisons and the like are no-fly sites under
// the rules of the country the route starts in (rules.js noFlyTypes):
// those are always avoided. The rest - schools, hospitals, playgrounds
// and so on - aren't no-fly zones in themselves; they're avoided by
// default because they're usually full of people, and flying over
// people is restricted in many places. The person can switch any of
// them off; switched-off sites are still drawn (in grey) but not
// avoided. Kept in the hidden #skipSites field as a comma list, so it's
// remembered and shared like the other settings.

import { HAZARD_TYPE_LABEL } from './osm.js';

export var OPTIONAL_SITE_TYPES = ['school', 'kindergarten', 'playground', 'hospital', 'nursing_home', 'university', 'power', 'heliport', 'embassy'];

export function parseSkipSites(value){
  return String(value || '').split(',').map(function(s){ return s.trim(); })
    .filter(function(s){ return OPTIONAL_SITE_TYPES.indexOf(s) !== -1; });
}

export function skippedSiteTypes(){
  var el = document.getElementById('skipSites');
  return parseSkipSites(el ? el.value : '');
}

// Splits looked-up hazards into the ones to avoid and the ones the
// person chose not to; a country's no-fly sites are always avoided.
export function splitHazards(hazards, skipped){
  var avoided = [], ignored = [];
  hazards.forEach(function(h){
    (!h.noFly && skipped.indexOf(h.type) !== -1 ? ignored : avoided).push(h);
  });
  return { avoided: avoided, ignored: ignored };
}

var SITE_LABELS = {
  school: 'Schools', kindergarten: 'Kindergartens', playground: 'Playgrounds', hospital: 'Hospitals',
  nursing_home: 'Nursing homes', university: 'Universities and colleges', power: 'Power facilities',
  heliport: 'Heliports', embassy: 'Embassies'
};

function updateSummary(){
  var skipped = skippedSiteTypes();
  var el = document.getElementById('sitesSummary');
  if (el) el.textContent = skipped.length === 0 ? 'all avoided' : skipped.length + ' type' + (skipped.length === 1 ? '' : 's') + ' not avoided';
}

// Ticks the boxes to match #skipSites (after settings are loaded).
export function syncSiteCheckboxes(){
  var skipped = skippedSiteTypes();
  OPTIONAL_SITE_TYPES.forEach(function(t){
    var box = document.getElementById('avoid-' + t);
    if (box) box.checked = skipped.indexOf(t) === -1;
  });
  updateSummary();
}

// Builds the checkboxes; app.js calls this once at start-up.
export function initSiteSettings(){
  var holder = document.getElementById('siteToggles');
  var hidden = document.getElementById('skipSites');
  if (!holder || !hidden) return;
  holder.innerHTML = OPTIONAL_SITE_TYPES.map(function(t){
    var label = SITE_LABELS[t] || HAZARD_TYPE_LABEL[t] || t;
    return '<label class="field-check"><input type="checkbox" id="avoid-' + t + '" checked> <span>' + label + '</span></label>';
  }).join('');
  holder.addEventListener('change', function(){
    hidden.value = OPTIONAL_SITE_TYPES.filter(function(t){ return !document.getElementById('avoid-' + t).checked; }).join(',');
    // Saved like the other settings (share.js listens for input).
    hidden.dispatchEvent(new Event('input', { bubbles: true }));
    updateSummary();
  });
  updateSummary();
}
