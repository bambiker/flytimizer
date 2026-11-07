import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadSite } from './load.js';

const site = await loadSite();

test('every drone preset is complete and in the drone picker', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  for (const [key, p] of Object.entries(site.DRONE_PRESETS)){
    for (const f of ['cruise', 'hor', 'asc', 'des', 'windres', 'batt', 'ftime', 'mass']) assert.ok(p[f] > 0, key + '.' + f);
    assert.ok(p.cruise <= p.hor, key + ': mission speed above top speed');
    assert.ok(html.includes('<option value="' + key + '"'), key + ' missing from the picker');
  }
});
