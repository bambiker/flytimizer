import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGhslTiff } from '../ghsl-fixture.js';

const g = await import('../../js/ghsl.js');
const P = await import('../../js/people.js');

test('countPeople: an even density over a straight route', () => {
  // 1 km in 11 samples, 100 people per cell of 0.001 x 0.001 degrees at the equator (~111 x 111 m).
  const samples = Array.from({ length: 11 }, (_, i) => ({ s: i * 100, lat: 0, lng: 0 }));
  const r = P.countPeople(samples, samples.map(() => 100), 0.001, 0.001);
  const perM2 = 100 / (111.32 * 110.574);
  assert.ok(Math.abs(r.people - perM2 * 1000 * 100) < 0.5, String(r.people));   // ~812 within 50 m either side
  assert.ok(Math.abs(r.peakPerKm2 - perM2 * 1e6) < 1);
  assert.equal(r.lengthM, 1000);
  // Empty land, and a wider corridor.
  assert.equal(P.countPeople(samples, samples.map(() => 0), 0.001, 0.001).people, 0);
  assert.ok(Math.abs(P.countPeople(samples, samples.map(() => 100), 0.001, 0.001, 100).people - 2 * r.people) < 1e-6);
});

test('densityLabel', () => {
  assert.equal(P.densityLabel(3), 'almost no one lives there');
  assert.equal(P.densityLabel(300), 'sparsely populated');
  assert.equal(P.densityLabel(3000), 'suburban');
  assert.equal(P.densityLabel(30000), 'dense city');
});

test('peopleUnderRoute reads the 64-bit population file along the route', async () => {
  // 10 people per 0.01-degree cell, except none west of 34.75.
  const tiff = makeGhslTiff({ x0: 34.7, y0: 32.32, dx: 0.01, width: 32, height: 32, tile: 16, bits: 64, value: (lat, lng) => lng < 34.75 ? 0 : 10 });
  g.resetGhsl();
  g.ghslIO.fetchRange = async (start, len) => { const b = tiff.subarray(start, Math.min(start + len, tiff.length)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const east = await P.peopleUnderRoute([{ lat: 32.1, lng: 34.8 }, { lat: 32.1, lng: 34.9 }]);
  const west = await P.peopleUnderRoute([{ lat: 32.1, lng: 34.705 }, { lat: 32.1, lng: 34.745 }]);
  assert.equal(west.people, 0);
  // ~9.4 km at 10 people per ~1.04 km2 cell -> ~9.6 people/km2 x 0.94 km2 of corridor.
  assert.ok(east.people > 8 && east.people < 10, String(east.people));
});
