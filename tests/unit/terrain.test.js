import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSite } from './load.js';

const site = await loadSite();
site.setMaxAglM(120);

// Samples every 30 m along a north-south line, like the app's densified route.
function route(ground, lengthM = 3000, step = 30){
  const out = [];
  for (let s = 0; s <= lengthM + 0.001; s += step){
    out.push({ lat: 32 + s / 111195, lng: 35, g: ground(s), s });
  }
  return out;
}
const none = samples => samples.map(() => -Infinity);
const climbRun = 12 / 5, descRun = 12 / 3;   // 12 m/s across, 5 up, 3 down

// Small deterministic random generator, so the property tests are repeatable.
function rng(seed){ return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }
function randomTerrain(r){
  const waves = [0, 1, 2].map(() => ({ a: 5 + r() * 60, l: 200 + r() * 1500, p: r() * 6.3 }));
  const cliffAt = r() * 3000, cliff = (r() - 0.5) * 80;
  return s => 100 + waves.reduce((g, w) => g + w.a * Math.sin(s / w.l * 6.283 + w.p), 0) + (s > cliffAt ? cliff : 0);
}

test('on flat ground, terrain following holds the target height the whole way', () => {
  const samples = route(() => 50);
  const p = site.buildAltitudeProfile(samples, 40, none(samples), climbRun, descRun);
  assert.equal(p.ok, true);
  for (const pt of p.pts) assert.equal(pt.alt, 90);
  assert.equal(p.climbUp, 40);     // just the takeoff
  assert.equal(p.climbDown, 40);   // just the landing
  assert.ok(Math.abs(p.minAGL - 40) < 1e-9 && Math.abs(p.maxAGL - 40) < 1e-9);
});

for (const mode of ['follow', 'level']){
  test(mode + ': never below the minimum height, never above the limit when flyable (random terrain)', () => {
    const r = rng(mode === 'follow' ? 1 : 2);
    let flyable = 0;
    for (let i = 0; i < 60; i++){
      const samples = route(randomTerrain(r));
      const h = [30, 50, 80, 120][i % 4];
      const p = site.buildAltitudeProfile(samples, h, none(samples), climbRun, descRun, mode);
      if (!p.ok) continue;
      flyable++;
      for (const smp of samples){
        const agl = site.profileAltAt(p.pts, smp.s) - smp.g;
        assert.ok(agl >= h - 0.5, 'below ' + h + ' m: ' + agl.toFixed(2) + ' at ' + smp.s);
        assert.ok(agl <= 120 + 0.5, 'above the limit: ' + agl.toFixed(2) + ' at ' + smp.s);
      }
    }
    assert.ok(flyable > 30, 'only ' + flyable + ' of 60 random routes were flyable');
  });
}

test('gentle hills well under the limit are always flyable, in both modes', () => {
  // So the property tests above can't pass just by marking everything unflyable.
  const r = rng(4);
  for (let i = 0; i < 40; i++){
    const waves = [0, 1].map(() => ({ a: 5 + r() * 35, l: 600 + r() * 1500, p: r() * 6.3 }));
    const samples = route(s => 100 + waves.reduce((g, w) => g + w.a * Math.sin(s / w.l * 6.283 + w.p), 0));
    for (const h of [30, 50]){
      for (const mode of ['follow', 'level']){
        assert.equal(site.buildAltitudeProfile(samples, h, none(samples), climbRun, descRun, mode).ok, true, mode + ' at ' + h + ' m, route ' + i);
      }
    }
  }
});

test('holding altitude never climbs more in total than following the terrain', () => {
  const r = rng(3);
  for (let i = 0; i < 40; i++){
    const samples = route(randomTerrain(r));
    const follow = site.buildAltitudeProfile(samples, 40, none(samples), climbRun, descRun, 'follow');
    const level = site.buildAltitudeProfile(samples, 40, none(samples), climbRun, descRun, 'level');
    if (follow.ok && level.ok) assert.ok(level.climbUp <= follow.climbUp + 0.5, level.climbUp + ' > ' + follow.climbUp);
  }
});

test('a building on the route raises the profile over it, with the safety margin', () => {
  const samples = route(() => 20);
  const building = { lat: 32 + 1500 / 111195, lng: 35, radius: 10, height: 60 };
  const req = site.buildingAltitudeRequirements(samples, [building]);
  const top = 20 + 60 + site.BUILDING_HEIGHT_SAFETY_MARGIN_M;
  const reach = building.radius + site.BUILDING_LATERAL_SAFETY_MARGIN_M;
  samples.forEach((smp, k) => {
    assert.equal(req[k], Math.abs(smp.s - 1500) <= reach ? top : -Infinity, 'sample at ' + smp.s);
  });
  const p = site.buildAltitudeProfile(samples, 30, req, climbRun, descRun);
  assert.equal(p.ok, true);
  assert.ok(site.profileAltAt(p.pts, 1500) >= top - 0.5);
  assert.ok(site.profileAltAt(p.pts, 0) < top);   // only climbs where it has to
});

test('a building taller than the limit makes the profile unflyable', () => {
  const samples = route(() => 20);
  const req = site.buildingAltitudeRequirements(samples, [{ lat: 32 + 1500 / 111195, lng: 35, radius: 10, height: 200 }]);
  for (const mode of ['follow', 'level']){
    assert.equal(site.buildAltitudeProfile(samples, 30, req, climbRun, descRun, mode).ok, false, mode);
  }
});

test('reverseSamples runs the route the other way, distances measured from the destination', () => {
  const samples = route(s => s / 10, 300, 100);
  const back = site.reverseSamples(samples);
  assert.deepEqual(back.map(p => p.s), [0, 100, 200, 300]);
  assert.deepEqual(back.map(p => p.g), [30, 20, 10, 0]);
});

test('profileAltAt interpolates between profile points and holds the ends', () => {
  const pts = [{ s: 0, alt: 10 }, { s: 100, alt: 30 }, { s: 200, alt: 30 }];
  assert.equal(site.profileAltAt(pts, -5), 10);
  assert.equal(site.profileAltAt(pts, 50), 20);
  assert.equal(site.profileAltAt(pts, 150), 30);
  assert.equal(site.profileAltAt(pts, 999), 30);
});
