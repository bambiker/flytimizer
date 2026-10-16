// GPS spoofing check: does the country the device's location is in
// match the country its network says it's in?
//
// Spoofing sends fake satellite signals, so the phone still "sees"
// satellites but reports a position somewhere else - in this region
// typically Beirut airport, sometimes Cairo or Amman. A web page can't
// see the satellites themselves, but it can compare the reported
// position with two things GPS doesn't control:
//  - the country of the internet connection (from the IP address), and
//  - the device's time zone, which phones normally take from the mobile
//    network.
// It catches a jump to another country, not a shift of a few hundred
// metres, and a VPN or a manually set time zone can make one of the two
// signals wrong - so one disagreeing signal is only "possible".

import { detectCountry } from './rules.js';

// Time zones that pin down a country, for the region and the countries
// the app has rules for.
export var TZ_COUNTRY = {
  'Asia/Jerusalem': 'IL', 'Asia/Tel_Aviv': 'IL', 'Asia/Beirut': 'LB', 'Asia/Amman': 'JO',
  'Africa/Cairo': 'EG', 'Asia/Damascus': 'SY', 'Asia/Gaza': 'PS', 'Asia/Hebron': 'PS',
  'Asia/Nicosia': 'CY', 'Europe/Nicosia': 'CY', 'Asia/Famagusta': 'CY', 'Asia/Baghdad': 'IQ',
  'Asia/Riyadh': 'SA', 'Europe/Istanbul': 'TR', 'Asia/Tehran': 'IR'
};

// Positions spoofed receivers in the region commonly report.
export var SPOOF_HOTSPOTS = [
  { name: 'Beirut airport', country: 'LB', lat: 33.8209, lng: 35.4884 },
  { name: 'Cairo airport', country: 'EG', lat: 30.1219, lng: 31.4056 },
  { name: 'Amman airport', country: 'JO', lat: 31.7226, lng: 35.9932 }
];
var HOTSPOT_RADIUS_M = 15000;

var IP_COUNTRY_URLS = ['https://get.geojs.io/v1/ip/country.json', 'https://api.country.is/'];

function distanceM(lat1, lng1, lat2, lng2){
  var r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

export function nearHotspot(lat, lng){
  return SPOOF_HOTSPOTS.find(function(h){ return distanceM(lat, lng, h.lat, h.lng) <= HOTSPOT_RADIUS_M; }) || null;
}

export function timeZoneCountry(tz){
  if (tz === undefined){
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e){ tz = null; }
  }
  return TZ_COUNTRY[tz] || null;
}

var ipCountryPromise = null;
// Country of the internet connection (two-letter code), or null.
export function ipCountry(){
  if (!ipCountryPromise){
    ipCountryPromise = (async function(){
      for (var i = 0; i < IP_COUNTRY_URLS.length; i++){
        var controller = new AbortController();
        var timer = setTimeout(function(){ controller.abort(); }, 6000);
        try {
          var response = await fetch(IP_COUNTRY_URLS[i], { signal: controller.signal });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          var json = await response.json();
          var code = json && (json.country || json.country_code);
          if (typeof code === 'string' && /^[A-Za-z]{2}$/.test(code)) return code.toUpperCase();
        } catch (err){
          console.warn('IP country lookup failed:', err);
        } finally {
          clearTimeout(timer);
        }
      }
      return null;
    })();
  }
  return ipCountryPromise;
}

// Pure decision: { status: 'ok' | 'likely' | 'possible' | 'unknown',
// gps, network, hotspot }. `network` is the country the other signals
// point to when they disagree with GPS.
export function assessGpsCountry(c){
  var signals = [c.ip, c.tz].filter(Boolean);
  var hotspot = nearHotspot(c.lat, c.lng);
  if (signals.length === 0) return { status: 'unknown', gps: c.gps || null, network: null, hotspot: hotspot };
  if (!c.gps){
    // No country for the position, but a well-known fake one is still a warning sign.
    // (Unless the network says you really are in that country.)
    return hotspot && signals.indexOf(hotspot.country) === -1
      ? { status: 'possible', gps: null, network: c.tz || c.ip, hotspot: hotspot }
      : { status: 'unknown', gps: null, network: null, hotspot: null };
  }
  if (signals.indexOf(c.gps) !== -1) return { status: 'ok', gps: c.gps, network: c.gps, hotspot: null };
  var agree = signals.length === 2 && c.ip === c.tz;
  return { status: agree || hotspot ? 'likely' : 'possible', gps: c.gps, network: agree ? c.ip : (c.tz || c.ip), hotspot: hotspot };
}

export function countryName(code){
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code; } catch (e){ return code; }
}

// Runs the check for a position the device reported.
export async function checkGpsCountry(lat, lng){
  var results = await Promise.all([detectCountry(lat, lng).catch(function(){ return null; }), ipCountry()]);
  // The approximate country boxes are too rough near a border to judge by.
  var gps = results[0] && results[0].source === 'geocoder' ? results[0].code : null;
  return assessGpsCountry({ gps: gps, ip: results[1], tz: timeZoneCountry(), lat: lat, lng: lng });
}

// One line for the person, or null when there's nothing to say.
export function gpsCheckHtml(a, accuracyM){
  var acc = typeof accuracyM === 'number' && isFinite(accuracyM)
    ? ' Reported accuracy ±' + (accuracyM >= 1000 ? (accuracyM / 1000).toFixed(1) + ' km' : Math.round(accuracyM) + ' m') +
      (accuracyM > 500 ? ' — a weak fix (no GPS, or jamming); the position may be from Wi-Fi or the mobile network.' : '.')
    : '';
  if (a.status === 'ok') return '✓ Your location matches your network (' + countryName(a.gps) + ').' + acc;
  if (a.status === 'unknown') return 'Couldn’t compare your location with your network.' + acc;
  var where = a.hotspot ? 'near ' + a.hotspot.name + ', a common fake position' : 'in ' + countryName(a.gps);
  var lead = a.status === 'likely' ? '⚠️ <strong>GPS spoofing likely</strong>' : '⚠️ <strong>Possible GPS spoofing</strong>';
  return lead + ': your device puts you ' + where + ', but your ' + (a.status === 'likely' ? 'internet connection and time zone say' : 'network says') +
    ' ' + countryName(a.network) + '. Don’t trust GPS here: check the drone app shows where you really are, fly in line of sight and be ready to fly it manually (it may return home to the wrong place). ' +
    '<a href="https://gpsjam.org/" target="_blank" rel="noopener">GPS interference map</a>.' + acc;
}
