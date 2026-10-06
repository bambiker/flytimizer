// Progress bar for the route calculation.

import { getDistanceFromLatLon } from './core.js';
import { BUILDING_CORRIDOR_DISTANCE_FRACTION, BUILDING_CORRIDOR_HALF_WIDTH_M, BUILDING_CORRIDOR_MAX_HALF_WIDTH_M, HAZARD_CORRIDOR_DISTANCE_FRACTION, HAZARD_CORRIDOR_HALF_WIDTH_M, HAZARD_CORRIDOR_MAX_HALF_WIDTH_M, bboxAreaKm2, corridorHalfWidth, polygonBBox, routeCorridorPolygon } from './osm.js';

// ---------------------------------------------------------------
// Progress bar
//
// Each calculation is split into stages with an estimated duration
// (restricted areas, buildings, the calculation itself). The bar
// moves steadily through a stage's estimate, then slows to a crawl
// instead of stopping or jumping to 100%, so it never claims to be
// done before it is. After every successful run, the real duration
// of each stage is compared to its estimate and a per-stage
// correction factor is kept in localStorage, so estimates adapt to
// how fast the map servers actually are for this person.
// ---------------------------------------------------------------
export var PROGRESS_FACTORS_KEY = 'flytimizerTimingFactors';

export function loadTimingFactors(){
  try {
    var raw = localStorage.getItem(PROGRESS_FACTORS_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch (e){ return {}; }
}

export function saveTimingFactors(f){
  try { localStorage.setItem(PROGRESS_FACTORS_KEY, JSON.stringify(f)); } catch (e){}
}

// Rough first guess, in seconds, before any learning: restricted areas
// scale with the area of the box we query, buildings with the area of
// the corridor around the route (buildings are far more numerous).
export function estimateLookupSeconds(lat1, lng1, lat2, lng2, bearingDeg){
  var distM = getDistanceFromLatLon(lat1, lng1, lat2, lng2);
  var hazHalf = corridorHalfWidth(distM, HAZARD_CORRIDOR_HALF_WIDTH_M, HAZARD_CORRIDOR_MAX_HALF_WIDTH_M, HAZARD_CORRIDOR_DISTANCE_FRACTION);
  var hazAreaKm2 = bboxAreaKm2(polygonBBox(routeCorridorPolygon(lat1, lng1, lat2, lng2, bearingDeg, hazHalf)));
  var bldHalf = corridorHalfWidth(distM, BUILDING_CORRIDOR_HALF_WIDTH_M, BUILDING_CORRIDOR_MAX_HALF_WIDTH_M, BUILDING_CORRIDOR_DISTANCE_FRACTION);
  var bldAreaKm2 = (2 * bldHalf * Math.max(distM, 2 * bldHalf)) / 1e6;
  return {
    hazards: Math.min(45, 1.5 + 0.6 * hazAreaKm2),
    buildings: Math.min(60, 1.5 + 3 * bldAreaKm2)
  };
}

export var Progress = {
  active: false,
  stages: [],
  idx: -1,
  stageStart: 0,
  frac: 0,
  timer: null,
  factors: {},

  el: function(id){ return document.getElementById(id); },

  start: function(stages){
    this.factors = loadTimingFactors();
    var self = this;
    this.stages = stages.map(function(st){
      var f = self.factors[st.key] || 1;
      return { key: st.key, label: st.label, rawEst: st.est, est: Math.max(0.3, st.est * f), actual: null, retried: false };
    });
    this.idx = -1;
    this.frac = 0;
    this.active = true;
    var box = this.el('calcProgress');
    if (box) box.hidden = false;
    clearInterval(this.timer);
    this.timer = setInterval(function(){ self.render(); }, 200);
  },

  stage: function(key){
    if (!this.active) return;
    var now = performance.now();
    if (this.idx >= 0 && this.stages[this.idx].actual === null){
      this.stages[this.idx].actual = (now - this.stageStart) / 1000;
    }
    for (var i = 0; i < this.stages.length; i++){
      if (this.stages[i].key === key){ this.idx = i; break; }
    }
    this.stageStart = now;
    this.note = null;
    this.render();
  },

  // A retry restarts the current stage's clock (the new server needs
  // its own full estimate) and swaps in an explanatory label. The
  // bar itself never moves backwards.
  retrying: function(text){
    if (!this.active || this.idx < 0) return;
    this.stages[this.idx].retried = true;
    this.stageStart = performance.now();
    this.note = text;
    this.render();
  },

  render: function(){
    if (!this.active || this.idx < 0) return;
    var total = 0, before = 0, after = 0;
    for (var i = 0; i < this.stages.length; i++){
      total += this.stages[i].est;
      if (i < this.idx) before += this.stages[i].est;
      if (i > this.idx) after += this.stages[i].est;
    }
    var cur = this.stages[this.idx];
    var elapsed = (performance.now() - this.stageStart) / 1000;
    var f = elapsed < cur.est
      ? 0.9 * elapsed / cur.est
      : 0.9 + 0.09 * (1 - Math.exp(-(elapsed - cur.est) / cur.est));
    this.frac = Math.max(this.frac, Math.min(0.99, (before + f * cur.est) / total));

    var remaining = Math.max(cur.est - elapsed, 0) + after;
    var eta;
    if (elapsed > cur.est * 1.3) eta = 'taking longer than usual…';
    else if (remaining >= 1.5) eta = '~' + Math.ceil(remaining) + ' s left';
    else eta = 'almost done…';

    var fill = this.el('progressFill');
    var track = this.el('progressTrack');
    var label = this.el('progressLabel');
    var etaEl = this.el('progressEta');
    var pct = Math.round(this.frac * 100);
    if (fill) fill.style.width = pct + '%';
    if (track) track.setAttribute('aria-valuenow', pct);
    if (label) label.textContent = this.note || cur.label;
    if (etaEl) etaEl.textContent = eta;
  },

  // success=true learns from this run's timings; either way the bar
  // completes and hides. Safe to call more than once.
  finish: function(success){
    if (!this.active) return;
    var now = performance.now();
    if (this.idx >= 0 && this.stages[this.idx].actual === null){
      this.stages[this.idx].actual = (now - this.stageStart) / 1000;
    }
    if (success){
      var factors = this.factors;
      this.stages.forEach(function(st){
        // Runs that hit a retry, or came from cache (near-instant),
        // say nothing about normal server speed - skip them.
        if (st.actual === null || st.retried || st.actual < 0.15 || st.rawEst <= 0) return;
        var ratio = Math.min(5, Math.max(0.2, st.actual / st.rawEst));
        var old = factors[st.key] || 1;
        factors[st.key] = 0.7 * old + 0.3 * ratio;
      });
      saveTimingFactors(factors);
    }
    this.active = false;
    clearInterval(this.timer);
    var fill = this.el('progressFill');
    if (fill) fill.style.width = '100%';
    var box = this.el('calcProgress');
    setTimeout(function(){
      if (box && !Progress.active) box.hidden = true;
      if (fill && !Progress.active) fill.style.width = '0%';
    }, 400);
  }
};
