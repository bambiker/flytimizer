// How many people live under a route: the EU's GHS-POP population grid
// (people per ~90 m cell, 2025 estimate) read along the route, turned
// into a density and counted over a corridor either side of it.
//
// It's where people LIVE (homes), which is what a population census
// counts - in the daytime schools, offices, shops and streets can be
// busier than this, and homes emptier. Good for comparing routes and
// for a first look at ground risk, not a head count.

import { GHSL_POP_URL, ghslCells } from './ghsl.js';
import { rememberSuggestion, suggestFewerPeopleRoute } from './lowpop.js';
import { showAltRoute } from './map-view.js';
import { densifyPath } from './terrain.js';
import { fmtDist } from './units.js';

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

function peopleText(n, peakPerKm2){
  return n === 0
    ? 'Almost no one lives within ' + PEOPLE_CORRIDOR_HALF_WIDTH_M + ' m of this route'
    : 'About ' + n.toLocaleString('en') + ' people live within ' + PEOPLE_CORRIDOR_HALF_WIDTH_M + ' m either side of this route; the most crowded stretch is ' +
      densityLabel(peakPerKm2) + ' (~' + roundPeople(peakPerKm2).toLocaleString('en') + ' per km²)';
}

// Fills the "People under the route" line in the result, then looks for
// a route over fewer people (lowpop.js) and offers it. Runs after the
// rest of the result is shown, so a slow download doesn't hold it up.
// opts: { from, to, distance, obstacles, chosen } - chosen: this route
// already is the one over fewer people.
var renderSeq = 0;
export async function renderPeopleInfo(path, opts){
  var el = document.getElementById('peopleInfo');
  if (!el) return null;
  opts = opts || {};
  var seq = ++renderSeq;   // a newer calculation wins over a slow older one
  el.textContent = 'Counting the people who live under the route…';
  el.style.display = 'block';
  rememberSuggestion(null);
  var r;
  try {
    r = await peopleUnderRoute(path);
  } catch (err){
    console.warn('Population data unavailable:', err);
    if (seq === renderSeq) el.style.display = 'none';
    return null;
  }
  if (seq !== renderSeq) return null;
  var base = peopleText(roundPeople(r.people), r.peakPerKm2) +
    '. That’s where people live (EU GHS-POP 2025): in the daytime schools, offices and streets can be busier.';
  el.textContent = base;
  if (opts.chosen){
    el.appendChild(document.createTextNode(' This route was chosen to pass over fewer people. '));
    el.appendChild(actionButton('Plan the shortest route', 'lowpopOff'));
    return r;
  }
  if (!opts.from || !opts.to) return r;
  try {
    var alt = await suggestFewerPeopleRoute(opts.from, opts.to, { distance: opts.distance, people: r.people }, opts.obstacles);
    if (seq !== renderSeq) return r;
    var note = document.createElement('span');
    if (alt){
      rememberSuggestion(opts.from, opts.to, alt.path);
      showAltRoute(alt.path);
      note.textContent = ' A route over fewer people (dashed purple on the map): ' + fmtDist(alt.distance) + ' (+' +
        Math.round((alt.distance / opts.distance - 1) * 100) + '%), about ' + roundPeople(alt.people).toLocaleString('en') + ' people under it (' +
        Math.round((1 - alt.people / r.people) * 100) + '% fewer). ';
      el.appendChild(note);
      el.appendChild(actionButton('Plan this route', 'lowpop'));
    } else if (r.people >= 20){
      note.textContent = ' No way round passes over clearly fewer people for a modest detour here.';
      el.appendChild(note);
    }
    r.alternative = alt;
  } catch (err){
    console.warn('Fewer-people route search failed:', err);
  }
  return r;
}

function actionButton(label, action){
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-ghost btn-inline';
  b.dataset.action = action;
  b.textContent = label;
  return b;
}
