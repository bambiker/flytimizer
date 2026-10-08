import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSite } from './load.js';

const site = await loadSite();

test('getDistanceFromLatLon: 0.01 degrees of latitude is about 1.11 km', () => {
  const m = site.getDistanceFromLatLon(32, 35, 32.01, 35);
  assert.ok(Math.abs(m - 1112) < 5, m);
});

test('trueBearing: north is 0, east is about 90', () => {
  assert.equal(Math.round(site.trueBearing(32, 35, 32.01, 35)), 0);
  assert.equal(Math.round(site.trueBearing(32, 35, 32, 35.01)), 90);
});

test('interpDir interpolates the short way round north', () => {
  assert.ok(Math.abs(site.interpDir(350, 10, 0.5) % 360) < 1e-9);
  assert.ok(Math.abs(site.interpDir(80, 100, 0.5) - 90) < 1e-9);
});

test('groundSpeed: tailwind adds, headwind subtracts, too much crosswind stops', () => {
  assert.equal(site.groundSpeed(10, 5, 0), 15);
  assert.ok(Math.abs(site.groundSpeed(10, 5, Math.PI) - 5) < 1e-9);
  assert.ok(Math.abs(site.groundSpeed(10, 6, Math.PI / 2) - 8) < 1e-9);
  assert.equal(site.groundSpeed(10, 12, Math.PI / 2), 0);
});

test('formatDuration', () => {
  assert.equal(site.formatDuration(42), '42 s');
  assert.equal(site.formatDuration(75), '1 min 15 s');
  assert.equal(site.formatDuration(-75), '-1 min 15 s');
  assert.equal(site.formatDuration(12.34, 1), '12.3 s');
  assert.equal(site.formatDuration(Infinity), '—');
});

test('escapeHtml escapes every HTML-significant character', () => {
  assert.equal(site.escapeHtml('<img src=x onerror="a(\'b\')">&'),
    '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  assert.equal(site.escapeHtml(42), '42');
});

test('classifyHazard: air-raid shelters tagged as bunkers are not military sites', () => {
  assert.equal(site.classifyHazard({ military: 'bunker', name: 'מקלט ציבורי' }), null);
  assert.equal(site.classifyHazard({ military: 'trench' }), null);
  assert.equal(site.classifyHazard({ amenity: 'shelter', military: 'yes' }), null);
  assert.equal(site.classifyHazard({ military: 'base' }), 'military');
  assert.equal(site.classifyHazard({ military: 'airfield' }), 'military_airfield');
  assert.equal(site.classifyHazard({ aeroway: 'aerodrome', landuse: 'military' }), 'military_airfield');
  assert.equal(site.classifyHazard({ aeroway: 'aerodrome', 'aerodrome:type': 'military' }), 'military_airfield');
  assert.equal(site.classifyHazard({ aeroway: 'aerodrome' }), 'airport');
  assert.equal(site.classifyHazard({ landuse: 'military' }), 'military');
  assert.equal(site.classifyHazard({ landuse: 'military', military: 'bunker' }), 'military');
});

test('Israel: 3 km keep-out only around military airfields; other military sites just keep off the site', () => {
  const IL = site.REGULATION_PROFILES.IL;
  const [base, field] = site.applyRulesToHazards([
    { lat: 32, lng: 35, type: 'military', radius: 200 },
    { lat: 32, lng: 35, type: 'military_airfield', radius: 800 }
  ], IL);
  assert.equal(base.clearance, 200 + IL.defaultBufferM);
  assert.equal(base.noFly, true);
  assert.equal(field.clearance, 3800);
  assert.equal(field.noFly, true);
});
