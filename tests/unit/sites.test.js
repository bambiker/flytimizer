import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSite } from './load.js';

const site = await loadSite();

test('parseSkipSites keeps only the optional site types', () => {
  assert.deepEqual(site.parseSkipSites('school, playground,airport,nonsense,'), ['school', 'playground']);
  assert.deepEqual(site.parseSkipSites(''), []);
  assert.deepEqual(site.parseSkipSites(undefined), []);
});

test('splitHazards: switched-off types aren\'t avoided, but a country\'s no-fly sites always are', () => {
  const hz = [
    { type: 'school', noFly: false }, { type: 'hospital', noFly: false },
    { type: 'heliport', noFly: true },      // e.g. Israel: no-fly, can't be switched off
    { type: 'heliport', noFly: false },     // e.g. the US: only sensitive
    { type: 'airport', noFly: true }
  ];
  const r = site.splitHazards(hz, ['school', 'heliport', 'airport']);
  assert.deepEqual(r.avoided.map(h => h.type + h.noFly), ['hospitalfalse', 'heliporttrue', 'airporttrue']);
  assert.deepEqual(r.ignored.map(h => h.type + h.noFly), ['schoolfalse', 'heliportfalse']);
  assert.equal(site.splitHazards(hz, []).ignored.length, 0);
});
