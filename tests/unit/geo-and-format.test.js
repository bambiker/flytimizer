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
