// The "People under the route" line: how many people live under the
// route (from the EU's GHS-POP population grid, worked out by the
// engine) and the route over fewer people.
//
// It's where people LIVE (homes), which is what a population census
// counts - in the daytime schools, offices, shops and streets can be
// busier than this, and homes emptier. Good for comparing routes and
// for a first look at ground risk, not a head count.

import { showAltRoute } from './map-view.js';
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

function altText(alt, people, distance){
  return ' A route over fewer people (dashed purple on the map): ' + fmtDist(alt.distance) + ' (+' +
    Math.round((alt.distance / distance - 1) * 100) + '%), about ' + roundPeople(alt.people).toLocaleString('en') + ' people under it (' +
    Math.round((1 - alt.people / people) * 100) + '% fewer) \u2014 see the Fewer people plan.';
}

// The "People under the route" line, kept up to date from peoplePhase's
// updates. Returns update(u); a newer view makes older ones do nothing.
var viewSeq = 0;
export function renderPeopleView(distance){
  var el = document.getElementById('peopleInfo');
  var seq = ++viewSeq, people = 0, note = null;
  if (el){
    el.textContent = 'Counting the people who live under the route…';
    el.style.display = 'block';
  }
  return function update(u){
    if (!el || seq !== viewSeq) return;
    if (u.type === 'countError'){
      el.style.display = 'none';
    } else if (u.type === 'count'){
      people = u.people;
      el.textContent = peopleText(roundPeople(u.people), u.peakPerKm2) +
        '. That’s where people live (EU GHS-POP 2025): in the daytime schools, offices and streets can be busier.';
    } else if (u.type === 'noAlt'){
      note = document.createElement('span');
      note.textContent = ' No way round passes over clearly fewer people for a modest detour here.';
      el.appendChild(note);
    } else if (u.type === 'alt'){
      showAltRoute(u.alt.path);
      note = document.createElement('span');
      note.textContent = altText(u.alt, people, distance);
      el.appendChild(note);
    } else if (u.type === 'altResult' && note){
      if (u.ok){
        showAltRoute(u.alt.path);
        note.textContent = altText(u.alt, people, distance);
      } else {
        showAltRoute(null);
        note.textContent = u.error ? ' A route over fewer people was found, but it couldn’t be planned.'
          : ' A route over fewer people was found, but ' + u.reason + ', so it isn’t offered.';
      }
    }
  };
}
