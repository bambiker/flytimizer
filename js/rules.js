// Country rules: per-country height limits, keep-out distances and notes.

import { HAZARD_ROUTING_RADIUS_CAP_M } from './osm.js';
import { escapeHtml, fmtDist, unitsImperial } from './units.js';

// ---------------------------------------------------------------
// Country rules
//
// The rules applied to a route are those of the country its START
// point is in (looked up with OpenStreetMap's Nominatim reverse
// geocoder, with a rough bounding-box fallback if that fails).
// Israel and the United States have their own rule sets; anywhere
// else uses Israel's, which are the stricter of the two - a
// conservative default, clearly labelled as such in the result.
//
// Per country:
//  - maxAglM: legal height limit above ground. Heights above it are
//    marked unflyable unless the person ticks "I have authorization".
//  - bufferM / defaultBufferM: keep-out distance the ROUTE detours by,
//    added to the site's own mapped size.
//  - noFlyTypes: site types where flying may be illegal or need
//    authorization - these raise the prominent red warning.
//  - warnM: how far (beyond the site's own size) that warning reaches,
//    when it should reach further than the detour itself (e.g. US
//    controlled airspace around airports: you need authorization
//    there, but the route can't sensibly detour 8 km around it).
//  - noFlyNote: what to tell the person about each type.
//  - specialZones: fixed areas with their own rules (Washington DC).
//
// These are a planning aid compiled from published summaries, not
// legal advice. Rules change; every result links to the official
// source to check before flying.
// ---------------------------------------------------------------
export var MILE_M = 1609.344;

export var REGULATION_PROFILES = {
  IL: {
    code: 'IL',
    country: 'Israel',
    authority: 'CAAI',
    maxAglM: 50,
    maxAglLabel: '50 m',
    defaultBufferM: 30,
    bufferM: {
      airport: 2000,   // no closer than 2 km to a runway or landing strip
      heliport: 2000,  // same runway/landing-strip rule
      military_airfield: 3000,  // 3 km from a military runway (small-UAS rule); other military sites: keep off the site itself
      prison: 1000     // 1 km, distance specified for a Prison Service site
    },
    noFlyTypes: { airport: true, heliport: true, prison: true, embassy: true, military: true, military_airfield: true },
    warnM: {},
    noFlyNote: {
      military: 'don\u2019t fly over it: security installations are closed to drones'
    },
    notes: [
      'Flying higher than 50 m needs a CAAI permit.',
      'Keep well away from people, homes and gatherings (250 m is commonly cited), never fly over people, and keep the drone in visual line of sight.',
      'Drones must be registered with CAAI.'
    ],
    checkLabel: 'CAAI no-fly-zone maps and current NOTAMs',
    checkUrl: 'https://www.gov.il/en/departments/civil_aviation_authority_of_israel',
    specialZones: []
  },
  US: {
    code: 'US',
    country: 'United States',
    authority: 'FAA',
    maxAglM: 400 * 0.3048,
    maxAglLabel: '400 ft (122 m)',
    defaultBufferM: 30,
    bufferM: {},
    // No fixed national distance from airports - the rule is about
    // controlled airspace, which surrounds most airports out to
    // roughly 5 miles. So: detour only around the field itself, but
    // warn well beyond it.
    noFlyTypes: { airport: true, military: true, military_airfield: true, prison: true },
    warnM: { airport: 5 * MILE_M, military_airfield: 5 * MILE_M },
    noFlyNote: {
      airport: 'airspace near airports is usually controlled — you need LAANC authorization before flying',
      military: 'many military sites have FAA drone restrictions over them (14 CFR 99.7)',
      military_airfield: 'military airfields have controlled or restricted airspace around them — check B4UFLY before flying',
      prison: 'some correctional facilities have FAA drone restrictions over them (14 CFR 99.7)'
    },
    notes: [
      'Keep the drone in visual line of sight at all times.',
      'Controlled airspace (around most airports) needs LAANC authorization; check for Temporary Flight Restrictions (TFRs), e.g. around stadiums during events.',
      'Drones over 250 g must be registered and broadcast Remote ID.'
    ],
    checkLabel: 'B4UFLY / a LAANC app and current TFRs',
    checkUrl: 'https://www.faa.gov/uas/getting_started/b4ufly',
    specialZones: [
      {
        name: 'Washington DC Flight Restricted Zone',
        lat: 38.8512, lng: -77.0377,          // Ronald Reagan Washington National Airport
        radiusM: 15 * MILE_M,
        noFly: true,
        text: 'flying a drone within 15 miles of Reagan National Airport is prohibited without specific FAA authorization'
      },
      {
        name: 'Washington DC Special Flight Rules Area',
        lat: 38.8512, lng: -77.0377,
        radiusM: 30 * MILE_M,
        noFly: false,
        text: 'within 30 miles of Reagan National Airport, recreational flights are allowed only under specific conditions and other flights need Part 107 compliance or authorization'
      }
    ]
  }
};
export var RULES_FALLBACK_CODE = 'IL';
export var NO_FLY_WARNING_EXTRA_MARGIN_M = 100; // map-data imprecision margin on top of the keep-out distance
export var countryCache = new Map();

// Rough boxes used only if the reverse geocoder can't be reached.
// They overlap neighbouring countries at the edges, which is
// acceptable for a fallback (and anything unmatched gets Israel's
// rules anyway).
export var COUNTRY_BOXES = [
  { code: 'IL', s: 29.45, n: 33.35, w: 34.2, e: 35.9 },
  { code: 'US', s: 24.4, n: 49.4, w: -125.0, e: -66.9 },   // contiguous states
  { code: 'US', s: 51.0, n: 71.6, w: -170.0, e: -129.9 },  // Alaska
  { code: 'US', s: 18.8, n: 22.3, w: -160.3, e: -154.7 },  // Hawaii
  { code: 'US', s: 17.8, n: 18.6, w: -67.4, e: -65.2 }     // Puerto Rico
];

export function countryFromBoxes(lat, lng){
  for (var i = 0; i < COUNTRY_BOXES.length; i++){
    var b = COUNTRY_BOXES[i];
    if (lat >= b.s && lat <= b.n && lng >= b.w && lng <= b.e) return { code: b.code, name: null, source: 'approx' };
  }
  return { code: null, name: null, source: 'approx' };
}

export async function detectCountry(lat, lng){
  var key = lat.toFixed(2) + ',' + lng.toFixed(2);
  if (countryCache.has(key)) return countryCache.get(key);
  var result;
  try {
    var controller = new AbortController();
    var timer = setTimeout(function(){ controller.abort(); }, 8000);
    var url = 'https://nominatim.openstreetmap.org/reverse?format=json&zoom=3&accept-language=en&lat=' + lat.toFixed(5) + '&lon=' + lng.toFixed(5);
    var response = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error('Reverse geocode HTTP ' + response.status);
    var json = await response.json();
    var cc = json && json.address && json.address.country_code;
    if (!cc) throw new Error('No country here');
    result = { code: cc.toUpperCase(), name: json.address.country || null, source: 'geocoder' };
  } catch (err){
    console.warn('Country lookup failed, using approximate boxes:', err);
    result = countryFromBoxes(lat, lng);
  }
  countryCache.set(key, result);
  return result;
}

// {profile, detected:{code,name}, fallback:boolean}
export async function rulesForLocation(lat, lng){
  var detected = await detectCountry(lat, lng);
  var profile = REGULATION_PROFILES[detected.code];
  return {
    profile: profile || REGULATION_PROFILES[RULES_FALLBACK_CODE],
    detected: detected,
    fallback: !profile
  };
}

export function hazardBufferFor(profile, type){
  return (profile.bufferM[type] !== undefined) ? profile.bufferM[type] : profile.defaultBufferM;
}

// Adds the rule-dependent fields to hazards found by
// getHazardsNearRoute: buffer, routing clearance, whether it's a
// no-fly type, and how far its warning reaches.
export function applyRulesToHazards(hazards, profile){
  hazards.forEach(function(h){
    h.buffer = hazardBufferFor(profile, h.type);
    h.clearance = Math.min(h.radius + h.buffer, HAZARD_ROUTING_RADIUS_CAP_M);
    h.noFly = !!profile.noFlyTypes[h.type];
    h.warnM = Math.max(h.buffer, profile.warnM[h.type] || 0) + NO_FLY_WARNING_EXTRA_MARGIN_M;
  });
  return hazards;
}

export function formatDistance(m){
  if (typeof unitsImperial !== 'undefined' && unitsImperial) return fmtDist(m);
  if (m >= 1000){
    var km = m / 1000;
    return km.toFixed(km % 1 === 0 ? 0 : 1) + ' km';
  }
  return m.toFixed(0) + ' m';
}

// Has the person said they're authorized to fly above the local limit?
export function altitudePermitChecked(){
  var el = document.getElementById('altPermit');
  return !!(el && el.checked);
}

export function renderRulesInfo(rules, legalCapM, permit){
  var el = document.getElementById('rulesInfo');
  if (!el) return;
  var p = rules.profile;
  var where = escapeHtml(rules.detected.name || (rules.detected.code ? rules.detected.code : 'this location'));
  var head;
  if (rules.fallback){
    head = '<strong>Rules: Israel (default).</strong> We don’t have a rule set for ' + where + ' yet, so we’re applying Israel’s, which are on the strict side — check your local regulations too.';
  } else {
    head = '<strong>Rules: ' + p.country + ' (' + p.authority + ').</strong> Height limit ' + p.maxAglLabel + ' above ground.';
  }
  if (permit && legalCapM > p.maxAglM){
    head += ' You’ve indicated authorization to fly higher, so heights up to ' + legalCapM.toFixed(0) + ' m are allowed.';
  }
  var notes = p.notes.map(function(n){ return '<li>' + n + '</li>'; }).join('');
  el.innerHTML = head + '<ul class="rules-notes">' + notes + '</ul>' +
    'Before every flight, check <a href="' + p.checkUrl + '" target="_blank" rel="noopener">' + p.checkLabel + '</a>.' +
    (rules.detected.source === 'approx' ? ' <span class="warning-hint">(Country detected approximately — the location service didn’t answer.)</span>' : '');
  el.style.display = 'block';
}
