import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSite } from './load.js';

const site = await loadSite();

test('isIos: iPhone, iPad and iPadOS (a Mac with a touch screen) count; others don\'t', () => {
  assert.equal(site.isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15', 5), true);
  assert.equal(site.isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 5), true);
  assert.equal(site.isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 0), false);
  assert.equal(site.isIos('Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0 Mobile', 5), false);
});
