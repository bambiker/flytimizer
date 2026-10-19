import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSite } from './load.js';

const site = await loadSite();
const from = { lat: 32.0, lng: 34.8 }, to = { lat: 32.0, lng: 34.83 };   // ~2.8 km east

// A grid with a dense block straddling the straight line in the middle.
function grid(blockDens){
  const g = site.gridFrame(from, to, 90);
  g.dens = new Float64Array(g.nx * g.ny);
  for (let i = 0; i < g.nx * g.ny; i++){
    const c = site.cellCenter(g, i);
    const inBlock = Math.abs(c.lat - 32.0) < 0.004 && Math.abs(c.lng - 34.815) < 0.004;
    g.dens[i] = inBlock ? blockDens : 1e-6;
  }
  return g;
}
function peopleOn(g, path){
  let s = 0;
  for (let i = 1; i < path.length; i++){
    const a = path[i - 1], b = path[i];
    const len = site.getDistanceFromLatLon(a.lat, a.lng, b.lat, b.lng), n = Math.ceil(len / 20);
    for (let k = 0; k < n; k++){ const t = (k + 0.5) / n; s += g.dens[site.cellOf(g, { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t })] * len / n * 100; }
  }
  return s;
}

test('with no weight on people the grid path is the straight line; with weight it goes round the dense block', () => {
  const g = grid(0.02);   // 20,000 people per km2
  const straight = site.simplifyPath(g, site.gridPath(g, from, to, 0, []), from, to, []);
  assert.equal(straight.length, 2);
  const round = site.simplifyPath(g, site.gridPath(g, from, to, 10, []), from, to, []);
  assert.ok(round.length > 2);
  assert.ok(peopleOn(g, round) < 0.1 * peopleOn(g, straight), peopleOn(g, round) + ' vs ' + peopleOn(g, straight));
  const extra = site.pathLengthM(round) / site.pathLengthM(straight) - 1;
  assert.ok(extra > 0.02 && extra < 0.35, String(extra));
});

test('the path never enters a keep-out zone, even to save people', () => {
  const g = grid(0.02);
  // A keep-out zone just north of the block, where the detour would go.
  const zone = { lat: 32.0055, lng: 34.815, clearance: 450, radius: 50 };
  const circles = site.keepOutCircles([zone], from, to);
  const path = site.simplifyPath(g, site.gridPath(g, from, to, 10, circles), from, to, circles);
  const c = { lat: zone.lat, lng: zone.lng };
  assert.ok(site.minDistanceFromPath(path, c.lat, c.lng) >= 440, String(site.minDistanceFromPath(path, c.lat, c.lng)));
  assert.ok(peopleOn(g, path) < 0.2 * peopleOn(g, [from, to]));   // it went round the south side instead
});

test('keepOutCircles shrinks a zone the start is inside to the start\'s distance', () => {
  const circles = site.keepOutCircles([{ lat: 32.0, lng: 34.801, clearance: 2000, radius: 60 }], from, to);
  assert.equal(circles.length, 1);
  assert.ok(circles[0].r < 100 && circles[0].r > 60, String(circles[0].r));   // ~94 m away; both ends aren't inside, so not the site's own size
});

test('pickFewerPeople: enough people saved for a modest detour, the best trade wins', () => {
  const base = { distance: 3000, people: 1000 };
  assert.equal(site.pickFewerPeople(base, [{ distance: 4500, people: 100 }]), null);   // +50%: too long
  assert.equal(site.pickFewerPeople(base, [{ distance: 3100, people: 900 }]), null);   // only 10% fewer
  assert.equal(site.pickFewerPeople({ distance: 3000, people: 60 }, [{ distance: 3100, people: 45 }]), null);   // 15 people: too few
  const a = { distance: 3150, people: 400 }, b = { distance: 3900, people: 300 };
  assert.equal(site.pickFewerPeople(base, [a, b]), a);   // 60% fewer for +5% beats 70% fewer for +30%
});
