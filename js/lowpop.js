// A route over fewer people: a least-cost path across a population
// density grid (GHS-POP, see people.js) between the start and the
// destination, weighing extra distance against the people living under
// the route, and steering clear of the keep-out zones the main route
// avoids. Several weightings are tried; the best one that saves enough
// people for a modest detour is offered next to the normal route.

import { getDistanceFromLatLon } from './core.js';
import { GHSL_POP_URL, ghslCells } from './ghsl.js';
import { PEOPLE_CORRIDOR_HALF_WIDTH_M, peopleUnderRoute } from './people.js';

export var LOWPOP_MAX_GRID = 150;          // cells along the longer side, at most
export var LOWPOP_MAX_ROUTE_M = 25000;     // longer routes aren't searched
export var LOWPOP_MAX_EXTRA = 0.35;        // offer at most 35% extra distance...
export var LOWPOP_MIN_SAVING = 0.15;       // ...for at least 15% fewer people
export var LOWPOP_MIN_PEOPLE_SAVED = 20;
// Metres of extra flight worth one person fewer under the route.
export var LOWPOP_WEIGHTS = [1, 3, 10, 30];

var M_PER_DEG_LAT = 110574;
function mPerDegLng(lat){ return 111320 * Math.cos(lat * Math.PI / 180); }

// Grid covering the start, the destination and a margin around them.
// grid.dens[i] = people per m2 in cell i (row-major, row 0 = south).
export function gridFrame(from, to, cellM){
  var dist = getDistanceFromLatLon(from.lat, from.lng, to.lat, to.lng);
  var margin = Math.max(800, 0.35 * dist);
  var lat0 = Math.min(from.lat, to.lat) - margin / M_PER_DEG_LAT;
  var lat1 = Math.max(from.lat, to.lat) + margin / M_PER_DEG_LAT;
  var midLat = (from.lat + to.lat) / 2, kx = mPerDegLng(midLat);
  var lng0 = Math.min(from.lng, to.lng) - margin / kx;
  var lng1 = Math.max(from.lng, to.lng) + margin / kx;
  var w = (lng1 - lng0) * kx, h = (lat1 - lat0) * M_PER_DEG_LAT;
  var step = Math.max(cellM, Math.max(w, h) / LOWPOP_MAX_GRID);
  var nx = Math.max(2, Math.ceil(w / step)), ny = Math.max(2, Math.ceil(h / step));
  return { lat0: lat0, lng0: lng0, nx: nx, ny: ny, dLat: step / M_PER_DEG_LAT, dLng: step / kx, stepM: step, kx: kx };
}

export function cellOf(g, p){
  var cx = Math.min(g.nx - 1, Math.max(0, Math.floor((p.lng - g.lng0) / g.dLng)));
  var cy = Math.min(g.ny - 1, Math.max(0, Math.floor((p.lat - g.lat0) / g.dLat)));
  return cy * g.nx + cx;
}
export function cellCenter(g, i){
  var cx = i % g.nx, cy = Math.floor(i / g.nx);
  return { lat: g.lat0 + (cy + 0.5) * g.dLat, lng: g.lng0 + (cx + 0.5) * g.dLng };
}

// Fills g.dens from the population file: each grid cell is the average
// of up to 3 x 3 samples of the ~90 m population cells inside it.
export async function fillDensity(g){
  var sub = Math.min(3, Math.max(1, Math.round(g.stepM / 90)));
  var pts = [];
  for (var i = 0; i < g.nx * g.ny; i++){
    var c = cellCenter(g, i);
    for (var a = 0; a < sub; a++){
      for (var b = 0; b < sub; b++){
        pts.push({ lat: c.lat + ((a + 0.5) / sub - 0.5) * g.dLat, lng: c.lng + ((b + 0.5) / sub - 0.5) * g.dLng });
      }
    }
  }
  var cells = await ghslCells(GHSL_POP_URL, pts, false);
  var popCellM2 = (cells.dx * mPerDegLng((g.lat0 + g.ny * g.dLat / 2))) * (cells.dy * M_PER_DEG_LAT);
  var per = sub * sub;
  g.dens = new Float64Array(g.nx * g.ny);
  for (var j = 0; j < g.nx * g.ny; j++){
    var s = 0;
    for (var k = 0; k < per; k++) s += cells.values[j * per + k] || 0;
    g.dens[j] = s / per / popCellM2;
  }
  return g;
}

// Keep-out circles in metres around `origin`, shrunk the way the main
// routing shrinks a zone the start or destination is inside of.
export function keepOutCircles(obstacles, from, to){
  var kx = mPerDegLng(from.lat);
  function xy(p){ return { x: (p.lng - from.lng) * kx, y: (p.lat - from.lat) * M_PER_DEG_LAT }; }
  var s = xy(from), d = xy(to);
  return (obstacles || []).map(function(o){
    var c = xy(o), r = o.clearance;
    var ds = Math.hypot(s.x - c.x, s.y - c.y), dd = Math.hypot(d.x - c.x, d.y - c.y);
    if (ds < r && dd < r) r = Math.min(o.radius || 0, r);
    if (ds < r) r = Math.min(r, ds - 1);
    if (dd < r) r = Math.min(r, dd - 1);
    return { x: c.x, y: c.y, r: Math.max(0, r) };
  }).filter(function(c){ return c.r > 0; });
}

function toXY(from, p){ return { x: (p.lng - from.lng) * mPerDegLng(from.lat), y: (p.lat - from.lat) * M_PER_DEG_LAT }; }

function segmentHitsCircle(a, b, c){
  var dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
  var t = L2 ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / L2)) : 0;
  return Math.hypot(a.x + t * dx - c.x, a.y + t * dy - c.y) < c.r - 0.5;
}

// People living within the corridor along a straight segment, from the grid.
function segmentPeople(g, a, b){
  var len = getDistanceFromLatLon(a.lat, a.lng, b.lat, b.lng);
  var n = Math.max(1, Math.ceil(len / (g.stepM / 2)));
  var s = 0;
  for (var i = 0; i < n; i++){
    var t = (i + 0.5) / n;
    s += g.dens[cellOf(g, { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t })];
  }
  return s / n * len * 2 * PEOPLE_CORRIDOR_HALF_WIDTH_M;
}

// Least-cost path over the grid (8 neighbours): cost = metres + weight x
// people under it. Cells inside a keep-out circle are blocked (except the
// start's and destination's own cells). Returns cell indices or null.
export function gridPath(g, from, to, weight, circles){
  var N = g.nx * g.ny, start = cellOf(g, from), goal = cellOf(g, to);
  var blocked = new Uint8Array(N);
  if (circles && circles.length){
    for (var i = 0; i < N; i++){
      var p = toXY(from, cellCenter(g, i));
      for (var k = 0; k < circles.length; k++){
        if (Math.hypot(p.x - circles[k].x, p.y - circles[k].y) < circles[k].r){ blocked[i] = 1; break; }
      }
    }
  }
  blocked[start] = blocked[goal] = 0;
  var dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
  var heap = [];   // binary min-heap of [cost, cell]
  function push(c, v){ heap.push([c, v]); var i = heap.length - 1; while (i > 0){ var p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; var t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p; } }
  function pop(){ var top = heap[0], last = heap.pop(); if (heap.length){ heap[0] = last; var i = 0; for (;;){ var l = 2 * i + 1, r = l + 1, m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; var t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m; } } return top; }
  var cellX = g.stepM, cellY = g.stepM, diag = Math.hypot(cellX, cellY);
  var corridor = 2 * PEOPLE_CORRIDOR_HALF_WIDTH_M;
  dist[start] = 0;
  push(0, start);
  while (heap.length){
    var top = pop(), c = top[0], v = top[1];
    if (c > dist[v]) continue;
    if (v === goal) break;
    var vx = v % g.nx, vy = (v - vx) / g.nx;
    for (var dy = -1; dy <= 1; dy++){
      for (var dx = -1; dx <= 1; dx++){
        if (!dx && !dy) continue;
        var nx = vx + dx, ny = vy + dy;
        if (nx < 0 || ny < 0 || nx >= g.nx || ny >= g.ny) continue;
        var u = ny * g.nx + nx;
        if (blocked[u]) continue;
        var len = dx && dy ? diag : cellX;
        var cost = c + len * (1 + weight * corridor * (g.dens[v] + g.dens[u]) / 2);
        if (cost < dist[u]){ dist[u] = cost; prev[u] = v; push(cost, u); }
      }
    }
  }
  if (!isFinite(dist[goal])) return null;
  var out = [];
  for (var w = goal; w !== -1; w = prev[w]) out.push(w);
  return out.reverse();
}

// Turns grid cells into a path from `from` to `to` with as few corners
// as possible: a corner is skipped when the straight line past it
// crosses no keep-out circle and doesn't pass over more people.
export function simplifyPath(g, cells, from, to, circles){
  var pts = [from].concat(cells.slice(1, -1).map(function(i){ return cellCenter(g, i); })).concat([to]);
  function clear(a, b){
    var A = toXY(from, a), B = toXY(from, b);
    return !(circles || []).some(function(c){ return segmentHitsCircle(A, B, c); });
  }
  var out = [pts[0]], i = 0;
  while (i < pts.length - 1){
    var j = pts.length - 1;
    for (; j > i + 1; j--){
      if (!clear(pts[i], pts[j])) continue;
      var along = 0;
      for (var k = i; k < j; k++) along += segmentPeople(g, pts[k], pts[k + 1]);
      if (segmentPeople(g, pts[i], pts[j]) <= along * 1.05 + 0.5) break;
    }
    out.push(pts[j]);
    i = j;
  }
  return out;
}

export function pathLengthM(path){
  var s = 0;
  for (var i = 1; i < path.length; i++) s += getDistanceFromLatLon(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng);
  return s;
}

// Picks the best of the candidates: within the distance allowance and
// saving enough people, the best trade - share of people saved minus half
// the share of extra distance - and the shorter of two near-equal ones.
// base: { distance, people }.
export function pickFewerPeople(base, candidates){
  var best = null, bestScore = -Infinity;
  candidates.forEach(function(c){
    if (!c) return;
    var saved = base.people - c.people;
    var extra = c.distance / base.distance - 1;
    if (extra > LOWPOP_MAX_EXTRA) return;
    if (saved < LOWPOP_MIN_PEOPLE_SAVED || saved < LOWPOP_MIN_SAVING * base.people) return;
    var score = saved / base.people - 0.5 * Math.max(0, extra);
    if (score > bestScore + 0.01 || (Math.abs(score - bestScore) <= 0.01 && c.distance < best.distance)){
      best = c;
      bestScore = Math.max(score, bestScore);
    }
  });
  return best;
}

// { path, distance, people } for a route over fewer people, or null when
// there isn't a worthwhile one. base: { distance, people }; obstacles:
// the keep-out zones the main route avoided ({lat, lng, clearance, radius}).
export async function suggestFewerPeopleRoute(from, to, base, obstacles){
  if (base.distance > LOWPOP_MAX_ROUTE_M || base.people < LOWPOP_MIN_PEOPLE_SAVED) return null;
  var g = await fillDensity(gridFrame(from, to, 90));
  var circles = keepOutCircles(obstacles, from, to);
  var candidates = [];
  for (var k = 0; k < LOWPOP_WEIGHTS.length; k++){
    var cells = gridPath(g, from, to, LOWPOP_WEIGHTS[k], circles);
    if (!cells) continue;
    var path = simplifyPath(g, cells, from, to, circles);
    var people = (await peopleUnderRoute(path)).people;
    candidates.push({ path: path, distance: pathLengthM(path), people: people, weight: LOWPOP_WEIGHTS[k] });
  }
  return pickFewerPeople(base, candidates);
}

