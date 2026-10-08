import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGhslTiff } from '../ghsl-fixture.js';

const g = await import('../../js/ghsl.js');
const osm = await import('../../js/osm.js');

// 1/100 degree cells over 32.0-32.32 N, 34.7-35.02 E: 30 m tall north
// of 32.2, 5 m below, nothing west of 34.75.
const tiff = makeGhslTiff({ x0: 34.7, y0: 32.32, dx: 0.01, width: 32, height: 32, tile: 16,
  value: (lat, lng) => lng < 34.75 ? 0 : lat > 32.2 ? 30 : 5 });
let requests = 0;
function serve(buf){
  g.resetGhsl();
  requests = 0;
  g.ghslIO.fetchRange = async (start, len) => { requests++; const b = buf.subarray(start, Math.min(start + len, buf.length)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
}

test('parseGhslHeader reads the grid and tile layout', () => {
  const h = g.parseGhslHeader(tiff.buffer.slice(tiff.byteOffset, tiff.byteOffset + 4096));
  assert.equal(h.width, 32);
  assert.equal(h.tileW, 16);
  assert.equal(h.deflate, true);
  assert.ok(Math.abs(h.x0 - 34.7) < 1e-9 && Math.abs(h.y0 - 32.32) < 1e-9 && h.dx === 0.01);
});

test('ghslHeights reads the cells under each point (highest of the cell and its neighbours)', async () => {
  serve(tiff);
  const hs = await g.ghslHeights([{ lat: 32.25, lng: 34.9 }, { lat: 32.1, lng: 34.9 }, { lat: 32.1, lng: 34.72 }, { lat: 33, lng: 34.9 }]);
  assert.deepEqual(hs, [30, 5, 0, null]);
  // Right next to the 30 m area, a cell's neighbour counts.
  assert.deepEqual(await g.ghslHeights([{ lat: 32.195, lng: 34.9 }]), [30]);
  // Tiles are cached: asking again downloads nothing.
  const before = requests;
  await g.ghslHeights([{ lat: 32.25, lng: 34.9 }]);
  assert.equal(requests, before);
});

test('fillMissingBuildingHeights raises only buildings without an OSM height, never lowers', async () => {
  serve(tiff);
  const list = [
    { lat: 32.25, lng: 34.9, height: 7, heightSource: 'guess' },    // -> 30
    { lat: 32.25, lng: 34.9, height: 12, heightSource: 'osm' },     // tagged: kept
    { lat: 32.1, lng: 34.9, height: 7, heightSource: 'guess' }      // 5 m area: guess kept
  ];
  const r = await osm.fillMissingBuildingHeights(list);
  assert.deepEqual(r, { checked: 2, raised: 1, failed: false });
  assert.deepEqual(list.map(b => b.height), [30, 12, 7]);
  assert.equal(list[0].heightSource, 'ghsl');
});

test('if the height data can\'t be read, buildings keep their guesses', async () => {
  g.resetGhsl();
  g.ghslIO.fetchRange = async () => { throw new Error('offline'); };
  const list = [{ lat: 32.25, lng: 34.9, height: 7, heightSource: 'guess' }];
  const r = await osm.fillMissingBuildingHeights(list);
  assert.deepEqual(r, { checked: 0, raised: 0, failed: true });
  assert.equal(list[0].height, 7);
  // A file in another layout is refused rather than misread.
  assert.throws(() => g.parseGhslHeader(new ArrayBuffer(64)), /BigTIFF/);
});

test('buildingHeightTagged', () => {
  assert.equal(osm.buildingHeightTagged({ building: 'yes', height: '20' }), true);
  assert.equal(osm.buildingHeightTagged({ building: 'yes', 'building:levels': '4' }), true);
  assert.equal(osm.buildingHeightTagged({ building: 'apartments' }), false);
});
