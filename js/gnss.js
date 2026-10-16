// "Conditions here": how many navigation satellites are above the
// horizon, and the geomagnetic Kp index that can degrade GPS.
//
// A web page can't ask the phone how many satellites it actually sees,
// so - like drone weather apps - this is a prediction: the satellites'
// published orbits (CelesTrak, mean elements in OMM/JSON form) moved on
// to now with Kepler's laws plus the main effect of the Earth's
// flattening (J2), then counted above 10 degrees of elevation. That's
// accurate to well under a degree for these high orbits over a few
// days, plenty for a count. Buildings, hills and trees block some of
// them in practice.

export var GNSS_GROUPS = [
  { key: 'gps', group: 'gps-ops', label: 'GPS' },
  { key: 'galileo', group: 'galileo', label: 'Galileo' },
  { key: 'glonass', group: 'glo-ops', label: 'GLONASS' },
  { key: 'beidou', group: 'beidou', label: 'BeiDou' }
];
export var GNSS_MIN_ELEVATION_DEG = 10;
var CELESTRAK_URL = 'https://celestrak.org/NORAD/elements/gp.php?FORMAT=json&GROUP=';
// CelesTrak updates these a few times a day and asks apps not to
// download them more often than that; keep them a day, and fall back
// to an older copy (up to two weeks) if a download fails.
var GNSS_CACHE_FRESH_MS = 24 * 3600e3;
var GNSS_CACHE_MAX_MS = 14 * 24 * 3600e3;
var KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json';

var MU = 3.986004418e14;      // Earth's gravitational parameter, m^3/s^2
var RE = 6378137;             // equatorial radius, m
var J2 = 1.08262668e-3;
var F = 1 / 298.257223563;    // WGS84 flattening
var DEG = Math.PI / 180;

// Greenwich mean sidereal time (radians) at a Date.
export function gmst(date){
  var d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;   // days since J2000
  var g = (280.46061837 + 360.98564736629 * d) % 360;
  return (g < 0 ? g + 360 : g) * DEG;
}

// Earth-fixed position (m) of a satellite from its OMM mean elements at `date`.
export function satellitePosition(omm, date){
  var epoch = Date.parse(/Z$/.test(omm.EPOCH) ? omm.EPOCH : omm.EPOCH + 'Z');
  var dt = (date.getTime() - epoch) / 1000;
  var n = omm.MEAN_MOTION * 2 * Math.PI / 86400;   // rad/s
  var e = omm.ECCENTRICITY, inc = omm.INCLINATION * DEG;
  var a = Math.cbrt(MU / (n * n));
  var p = a * (1 - e * e);
  var k = 1.5 * n * J2 * (RE / p) * (RE / p);
  var raan = omm.RA_OF_ASC_NODE * DEG - k * Math.cos(inc) * dt;
  var argp = omm.ARG_OF_PERICENTER * DEG + 0.5 * k * (5 * Math.cos(inc) * Math.cos(inc) - 1) * dt;
  var M = (omm.MEAN_ANOMALY * DEG + n * dt) % (2 * Math.PI);
  var E = M;
  for (var i = 0; i < 8; i++) E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  var nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  var r = a * (1 - e * Math.cos(E));
  var u = argp + nu;
  // Inertial position, then rotated by the Earth's turn.
  var x = r * (Math.cos(raan) * Math.cos(u) - Math.sin(raan) * Math.sin(u) * Math.cos(inc));
  var y = r * (Math.sin(raan) * Math.cos(u) + Math.cos(raan) * Math.sin(u) * Math.cos(inc));
  var z = r * Math.sin(u) * Math.sin(inc);
  var th = gmst(date);
  return { x: Math.cos(th) * x + Math.sin(th) * y, y: -Math.sin(th) * x + Math.cos(th) * y, z: z };
}

// Elevation (degrees) of an Earth-fixed point as seen from lat/lng (ground level).
export function elevationDeg(lat, lng, sat){
  var phi = lat * DEG, lam = lng * DEG;
  var e2 = F * (2 - F);
  var N = RE / Math.sqrt(1 - e2 * Math.sin(phi) * Math.sin(phi));
  var ox = N * Math.cos(phi) * Math.cos(lam), oy = N * Math.cos(phi) * Math.sin(lam), oz = N * (1 - e2) * Math.sin(phi);
  var dx = sat.x - ox, dy = sat.y - oy, dz = sat.z - oz;
  var up = Math.cos(phi) * Math.cos(lam) * dx + Math.cos(phi) * Math.sin(lam) * dy + Math.sin(phi) * dz;
  return Math.asin(up / Math.sqrt(dx * dx + dy * dy + dz * dz)) / DEG;
}

export function countVisible(omms, lat, lng, date, minElevDeg){
  var min = minElevDeg === undefined ? GNSS_MIN_ELEVATION_DEG : minElevDeg;
  return omms.filter(function(o){
    return o && o.MEAN_MOTION > 0 && elevationDeg(lat, lng, satellitePosition(o, date)) >= min;
  }).length;
}

function readCache(key){
  try { return JSON.parse(localStorage.getItem(key)); } catch (e){ return null; }
}
function writeCache(key, value){
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e){ /* full or blocked: just don't cache */ }
}

async function fetchJson(url){
  var controller = new AbortController();
  var timer = setTimeout(function(){ controller.abort(); }, 15000);
  try {
    var response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error('HTTP ' + response.status + ' from ' + url.split('/')[2]);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function constellation(group){
  var key = 'flytimizerGnss:' + group;
  var cached = readCache(key);
  var age = cached ? Date.now() - cached.at : Infinity;
  if (cached && age < GNSS_CACHE_FRESH_MS) return cached.omms;
  try {
    var data = await fetchJson(CELESTRAK_URL + encodeURIComponent(group));
    if (!Array.isArray(data) || data.length === 0) throw new Error('No orbits for ' + group);
    // Keep only what the calculation needs (the cache stays small).
    var omms = data.map(function(o){
      return { EPOCH: o.EPOCH, MEAN_MOTION: o.MEAN_MOTION, ECCENTRICITY: o.ECCENTRICITY, INCLINATION: o.INCLINATION,
               RA_OF_ASC_NODE: o.RA_OF_ASC_NODE, ARG_OF_PERICENTER: o.ARG_OF_PERICENTER, MEAN_ANOMALY: o.MEAN_ANOMALY };
    });
    writeCache(key, { at: Date.now(), omms: omms });
    return omms;
  } catch (err){
    if (cached && age < GNSS_CACHE_MAX_MS) return cached.omms;
    throw err;
  }
}

// Satellites above 10 degrees at lat/lng now, per constellation:
// { total, groups: [{ label, count }] }, leaving out any constellation
// whose orbits couldn't be loaded. Null if none could.
export async function visibleSatellites(lat, lng, date){
  date = date || new Date();
  var results = await Promise.all(GNSS_GROUPS.map(function(g){
    return constellation(g.group).then(function(omms){
      return { label: g.label, count: countVisible(omms, lat, lng, date) };
    }, function(err){
      console.warn('GNSS orbits unavailable:', err);
      return null;
    });
  }));
  var groups = results.filter(Boolean);
  if (groups.length === 0) return null;
  return { total: groups.reduce(function(s, g){ return s + g.count; }, 0), groups: groups, missing: GNSS_GROUPS.length - groups.length };
}

// The Kp index for the current 3-hour slot from NOAA's forecast table
// (observed, estimated or predicted). Accepts the table as rows of
// arrays with a header row, or as objects. Null if not found.
export function currentKp(table, date){
  if (!Array.isArray(table) || table.length === 0) return null;
  var rows = table;
  if (Array.isArray(table[0])){
    var head = table[0].map(function(h){ return String(h).toLowerCase(); });
    rows = table.slice(1).map(function(r){
      var o = {};
      head.forEach(function(h, i){ o[h] = r[i]; });
      return o;
    });
  }
  var now = (date || new Date()).getTime(), best = null;
  rows.forEach(function(r){
    var t = Date.parse(String(r.time_tag || '').replace(' ', 'T') + (/Z$/.test(r.time_tag || '') ? '' : 'Z'));
    var kp = parseFloat(r.kp !== undefined ? r.kp : r.Kp);
    if (isFinite(t) && isFinite(kp) && t <= now && (!best || t > best.t)) best = { t: t, kp: kp };
  });
  return best ? best.kp : null;
}

export async function kpIndexNow(){
  try {
    return currentKp(await fetchJson(KP_URL));
  } catch (err){
    console.warn('Kp index unavailable:', err);
    return null;
  }
}

export function kpLabel(kp){
  if (kp >= 7) return 'severe geomagnetic storm — GPS may be unreliable';
  if (kp >= 5) return 'geomagnetic storm — GPS accuracy may be reduced';
  if (kp >= 4) return 'active — mostly fine, watch the GPS signal';
  return 'quiet — no effect on GPS expected';
}
