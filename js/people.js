// How many people live under a route: the EU's GHS-POP population grid
// (people per ~90 m cell, 2025 estimate) read along the route, turned
// into a density and counted over a corridor either side of it.
//
// It's where people LIVE (homes), which is what a population census
// counts - in the daytime schools, offices, shops and streets can be
// busier than this, and homes emptier. Good for comparing routes and
// for a first look at ground risk, not a head count.

import { GHSL_POP_URL, ghslCells } from './ghsl.js';
import { densifyPath } from './terrain.js';

export var PEOPLE_CORRIDOR_HALF_WIDTH_M = 50;

// How built-up a population density (people per km2) is.
export function densityLabel(perKm2){
  if (perKm2 < 50) return 'almost no one lives there';
  if (perKm2 < 500) return 'sparsely populated';
  if (perKm2 < 5000) return 'suburban';
  if (perKm2 < 20000) return 'city';
  return 'dense city';
}

// samples: [{ s (m along the route), lat, lng }]; perCell: people in the
// grid cell under each sample; dx/dy: cell size in degrees.
// { people, peakPerKm2, lengthM, kmByLabel }
export function countPeople(samples, perCell, dx, dy, halfWidthM){
  var hw = halfWidthM === undefined ? PEOPLE_CORRIDOR_HALF_WIDTH_M : halfWidthM;
  var people = 0, peak = 0;
  for (var i = 0; i < samples.length; i++){
    var p = samples[i];
    var cellM2 = (dx * 111320 * Math.cos(p.lat * Math.PI / 180)) * (dy * 110574);
    var density = (perCell[i] || 0) / cellM2;   // people per m2
    peak = Math.max(peak, density);
    // Each sample stands for half the stretch to its neighbours.
    var before = i > 0 ? p.s - samples[i - 1].s : 0;
    var after = i < samples.length - 1 ? samples[i + 1].s - p.s : 0;
    people += density * (before + after) / 2 * 2 * hw;
  }
  return { people: people, peakPerKm2: peak * 1e6, lengthM: samples.length ? samples[samples.length - 1].s : 0 };
}

export async function peopleUnderRoute(path){
  var samples = densifyPath(path);
  var cells = await ghslCells(GHSL_POP_URL, samples, false);
  return countPeople(samples, cells.values, cells.dx, cells.dy);
}

function roundPeople(n){
  if (n < 10) return Math.round(n);
  var mag = Math.pow(10, Math.floor(Math.log10(n)) - 1);
  return Math.round(n / mag) * mag;
}

// Fills the "People under the route" line in the result. Runs after the
// rest of the result is shown, so a slow download doesn't hold it up.
var renderSeq = 0;
export async function renderPeopleInfo(path){
  var el = document.getElementById('peopleInfo');
  if (!el) return null;
  var seq = ++renderSeq;   // a newer calculation wins over a slow older one
  el.textContent = 'Counting the people who live under the route…';
  el.style.display = 'block';
  try {
    var r = await peopleUnderRoute(path);
    if (seq !== renderSeq) return null;
    var n = roundPeople(r.people);
    el.textContent = (n === 0
      ? 'Almost no one lives within ' + PEOPLE_CORRIDOR_HALF_WIDTH_M + ' m of this route'
      : 'About ' + n.toLocaleString('en') + ' people live within ' + PEOPLE_CORRIDOR_HALF_WIDTH_M + ' m either side of this route; the most crowded stretch is ' +
        densityLabel(r.peakPerKm2) + ' (~' + roundPeople(r.peakPerKm2).toLocaleString('en') + ' per km²)') +
      '. That’s where people live (EU GHS-POP 2025): in the daytime schools, offices and streets can be busier.';
    return r;
  } catch (err){
    console.warn('Population data unavailable:', err);
    if (seq === renderSeq) el.style.display = 'none';
    return null;
  }
}
