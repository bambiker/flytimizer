import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSite } from './load.js';

const site = await loadSite();

// Points given in metres east/north of (32, 35).
const LAT0 = 32, LNG0 = 35;
const mLng = 111320 * Math.cos(LAT0 * Math.PI / 180);
function at(x, y){ return { lat: LAT0 + y / 110540, lng: LNG0 + x / mLng }; }
function zone(x, y, clearance, type, radius){ const p = at(x, y); return { lat: p.lat, lng: p.lng, clearance: clearance, radius: radius || 50, kind: 'hazard', type: type || 'school', name: null }; }
function route(from, to, obstacles){ const a = at(from[0], from[1]), b = at(to[0], to[1]); return site.computeAvoidanceRoute(a.lat, a.lng, b.lat, b.lng, obstacles); }
function closestTo(path, x, y){ const c = at(x, y); return site.minDistanceFromPath(path, c.lat, c.lng); }

test('avoidance: a school on the straight line is detoured around', () => {
  const r = route([0, 0], [1000, 0], [zone(500, 0, 100)]);
  assert.equal(r.hazardsAvoided, 1);
  assert.ok(closestTo(r.path, 500, 0) >= 99);
  assert.ok(r.distance > 1000 && r.distance < 1100, String(r.distance));
});

test('avoidance: both ends inside a big keep-out zone - the route isn\'t sent out to its edge and back', () => {
  // A 2 km zone around both ends, and a school on the line between them.
  const r = route([0, 0], [1000, 0], [zone(500, 600, 2000, 'heliport'), zone(500, 0, 100)]);
  assert.equal(r.trapped.length, 1);
  assert.ok(closestTo(r.path, 500, 0) >= 99);
  assert.ok(r.distance < 1100, String(r.distance));
});

test('avoidance: both ends inside a zone, the route still keeps off the site itself', () => {
  // The heliport pad (60 m) sits right on the line between them, inside its 2 km zone.
  const r = route([0, 0], [1000, 0], [zone(500, 0, 2000, 'heliport', 60)]);
  assert.ok(closestTo(r.path, 500, 0) >= 59, String(closestTo(r.path, 500, 0)));
  assert.ok(r.distance < 1100, String(r.distance));
});

test('avoidance: starting inside a zone, the route doesn\'t cut closer to the site', () => {
  // Start 300 m from the site's center (inside its 1 km zone); the straight line passes 100 m from it.
  const r = route([0, -300], [2000, 400], [zone(0, 0, 1000, 'airport')]);
  assert.equal(r.trapped.length, 1);
  assert.ok(closestTo(r.path, 0, 0) >= 298, String(closestTo(r.path, 0, 0)));
  assert.ok(r.distance < 2500, String(r.distance));
});
