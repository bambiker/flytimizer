import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSite } from './load.js';

const site = await loadSite();
const BEIRUT_AIRPORT = [33.825, 35.49];
const TEL_AVIV = [32.08, 34.78];

test('assessGpsCountry: position in Beirut with an Israeli connection and time zone is likely spoofed', () => {
  const a = site.assessGpsCountry({ gps: 'LB', ip: 'IL', tz: 'IL', lat: BEIRUT_AIRPORT[0], lng: BEIRUT_AIRPORT[1] });
  assert.equal(a.status, 'likely');
  assert.equal(a.network, 'IL');
  assert.equal(a.hotspot.name, 'Beirut airport');
  assert.match(site.gpsCheckHtml(a, 12), /GPS spoofing likely.*near Beirut airport, a common fake position.*internet connection and time zone say Israel/);
});

test('assessGpsCountry: matching signals are fine; one disagreeing signal is only "possible"', () => {
  assert.equal(site.assessGpsCountry({ gps: 'IL', ip: 'IL', tz: 'IL', lat: TEL_AVIV[0], lng: TEL_AVIV[1] }).status, 'ok');
  // A VPN abroad, but the time zone agrees with the position.
  assert.equal(site.assessGpsCountry({ gps: 'IL', ip: 'DE', tz: 'IL', lat: TEL_AVIV[0], lng: TEL_AVIV[1] }).status, 'ok');
  // Somewhere else, not a known fake position, and only the time zone disagrees.
  assert.equal(site.assessGpsCountry({ gps: 'JO', ip: null, tz: 'IL', lat: 32.0, lng: 36.5 }).status, 'possible');
  // Really in Beirut.
  assert.equal(site.assessGpsCountry({ gps: 'LB', ip: 'LB', tz: 'LB', lat: BEIRUT_AIRPORT[0], lng: BEIRUT_AIRPORT[1] }).status, 'ok');
  // Nothing to compare with.
  assert.equal(site.assessGpsCountry({ gps: 'IL', ip: null, tz: null, lat: TEL_AVIV[0], lng: TEL_AVIV[1] }).status, 'unknown');
});

test('assessGpsCountry: no country for the position, but a known fake one, is still a warning unless you\'re really there', () => {
  assert.equal(site.assessGpsCountry({ gps: null, ip: 'IL', tz: 'IL', lat: BEIRUT_AIRPORT[0], lng: BEIRUT_AIRPORT[1] }).status, 'possible');
  assert.equal(site.assessGpsCountry({ gps: null, ip: 'LB', tz: 'LB', lat: BEIRUT_AIRPORT[0], lng: BEIRUT_AIRPORT[1] }).status, 'unknown');
  assert.equal(site.assessGpsCountry({ gps: null, ip: 'IL', tz: 'IL', lat: TEL_AVIV[0], lng: TEL_AVIV[1] }).status, 'unknown');
});

test('time zone to country, hotspots and the accuracy note', () => {
  assert.equal(site.timeZoneCountry('Asia/Jerusalem'), 'IL');
  assert.equal(site.timeZoneCountry('Asia/Beirut'), 'LB');
  assert.equal(site.timeZoneCountry('Europe/Paris'), null);
  assert.equal(site.nearHotspot(TEL_AVIV[0], TEL_AVIV[1]), null);
  assert.match(site.gpsCheckHtml({ status: 'ok', gps: 'IL' }, 1500), /matches your network \(Israel\).*±1\.5 km — a weak fix/);
});
