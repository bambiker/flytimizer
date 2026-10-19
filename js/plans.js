// The plans (fastest / least battery / fewer people) and their result panel.

import { BATTERY_RESERVE_PCT, fmtPct } from './battery.js';
import { formatDuration } from './core.js';
import { roundTripWaypoints } from './mission.js';
import { profileWaypoints, renderTerrainProfile } from './terrain.js';
import { showRouteLines } from './map-view.js';
import { fmtDist, fmtLen, fmtSpeed, lenNum, lenUnit } from './units.js';
import { loadJSZip } from './wpml.js';

// ---------------------------------------------------------------
// Two plans: fastest and least battery
//
// "Fastest" follows the terrain at the height that gets there
// soonest. "Least battery" also considers a second profile style for
// every height - "hold altitude": climb only when the ground (or a
// building) forces it, descend only when the legal height limit
// forces it, otherwise stay level. Over rolling terrain that avoids
// the up-and-down of terrain following, and climbing is the expensive
// part. It isn't always better - holding altitude over a valley puts
// the drone higher, where the wind is usually stronger - so each
// candidate (height x style) is scored with the battery model and the
// cheapest flyable one wins, separately for each leg. It may also fly a
// leg slower than the mission speed, or faster (up to the Sport-mode
// top speed, flown by hand) into a headwind, when that saves battery.
//
// "Fewer people" (when people.js finds a route over fewer people) is the
// fastest plan along that other route; it carries its own route
// (plan.route: terrain, path, distance).
// ---------------------------------------------------------------
var PLAN_KEYS = ['fast', 'eco', 'people'];
var PLAN_TITLES = { fast: 'Fastest', eco: 'Least battery', people: 'Fewer people' };
var PLAN_BUTTONS = { fast: 'planFastBtn', eco: 'planEcoBtn', people: 'planPeopleBtn' };
// File names: the fastest plan keeps the plain names.
var PLAN_FILE_PREFIX = { fast: 'flytimizer-', eco: 'flytimizer-least-battery-', people: 'flytimizer-fewer-people-' };
export var selectedPlan = 'fast';
export var currentCalc = null;

// Snapshot of the current outbound recommendation - path, altitude,
// speed, drone model - set by renderPlan() after a successful
// calcHeight() run, and read by downloadWPML() when the person clicks
// "Download flight plan". null whenever there's no flyable outbound
// height to build a mission from.
export var lastRoute = null;

export function setCurrentCalc(c){
  currentCalc = c;
}

// Start over: forget the last result (and its flight plans).
export function clearPlans(){
  currentCalc = null;
  lastRoute = null;
}

export function planLegLabel(leg){
  if (!leg) return '—';
  return leg.mode === 'level' ? 'holds altitude' : 'follows terrain';
}

export function renderPlanTabs(){
  var c = currentCalc;
  var tabs = document.getElementById('planTabs');
  if (!tabs || !c) return;
  var eco = c.plans.eco;
  tabs.style.display = eco || c.plans.people ? '' : 'none';
  PLAN_KEYS.forEach(function(key){
    var btn = document.getElementById(PLAN_BUTTONS[key]);
    var plan = c.plans[key];
    if (!btn) return;
    btn.hidden = !plan;
    if (!plan) return;
    btn.classList.toggle('active', selectedPlan === key);
    btn.setAttribute('aria-selected', selectedPlan === key ? 'true' : 'false');
    var detail = '';
    if (plan.out && plan.back && isFinite(plan.totalTime)){
      detail = formatDuration(plan.totalTime) + (isFinite(plan.totalBatt) ? ' · ' + fmtPct(plan.totalBatt) : '');
    }
    btn.innerHTML = '<span class="plan-title">' + PLAN_TITLES[key] + '</span><span class="plan-detail">' + (detail || 'no safe option') + '</span>';
  });
  var note = document.getElementById('planNote');
  if (note){
    var same = eco && c.plans.fast.out && eco.out && c.plans.fast.back && eco.back &&
      c.plans.fast.out.i === eco.out.i && c.plans.fast.out.mode === eco.out.mode && eco.out.speedFactor === 1 &&
      c.plans.fast.back.i === eco.back.i && c.plans.fast.back.mode === eco.back.mode && eco.back.speedFactor === 1;
    note.textContent = same ? 'On this route the fastest plan is also the most battery-efficient.' : '';
    note.style.display = same ? 'block' : 'none';
  }
}

export function selectPlan(key){
  if (!currentCalc || !currentCalc.plans[key]) return;
  selectedPlan = key;
  renderPlan();
}

// Everything that depends on which plan is shown: headline heights,
// battery, the side view, the terrain sentence and the WPML export.
export function renderPlan(){
  var c = currentCalc;
  if (!c) return;
  if (!c.plans[selectedPlan]) selectedPlan = 'fast';
  var plan = c.plans[selectedPlan];
  var out = plan.out, back = plan.back;
  // The route this plan flies: its own for "Fewer people", else the main one.
  var r = plan.route || { terrainSamples: c.terrainSamples, terrainBack: c.terrainBack, terrainAvailable: c.terrainAvailable, path: c.path, distance: c.distance };
  // Swap the solid and dashed lines once there's a second route (the
  // suggestion line may already be on the map before it's planned).
  if (plan.route || c.altPath) showRouteLines(r.path, plan.route ? c.path : c.altPath);
  var distEl = document.getElementById('distance'), detourEl = document.getElementById('detourNote');
  if (c.detourText === undefined) c.detourText = detourEl ? detourEl.textContent : '';
  if (distEl && isFinite(r.distance)) distEl.textContent = fmtDist(r.distance);
  if (detourEl) detourEl.textContent = plan.route ? ' (the route over fewer people)' : c.detourText;

  document.getElementById('heightfore').innerHTML = out ? lenNum(c.heights[out.i]) : '&mdash;';
  document.getElementById('heightback').innerHTML = back ? lenNum(c.heights[back.i]) : '&mdash;';
  document.getElementById('unitFore').textContent = lenUnit();
  document.getElementById('unitBack').textContent = lenUnit();
  // A leg flown at another speed than the mission speed (least
  // battery) says how fast; faster means Sport mode, by hand.
  function legStyle(leg){
    var f = leg.speedFactor || 1;
    return 'min. above ground, ' + planLegLabel(leg) +
      (f < 1 ? ', at ' + fmtSpeed(leg.speed) : f > 1 ? ', at ' + fmtSpeed(leg.speed) + ' (Sport mode, by hand)' : '');
  }
  document.getElementById('styleFore').textContent = out ? legStyle(out) : '';
  document.getElementById('styleBack').textContent = back ? legStyle(back) : '';
  document.getElementById('readoutFore').classList.toggle('unsafe', !out);
  document.getElementById('readoutBack').classList.toggle('unsafe', !back);

  // Round-trip battery for this plan.
  var battReadout = document.getElementById('readoutBatt');
  var battWarning = document.getElementById('batteryWarning');
  var battUsed = (out && back) ? plan.totalBatt : NaN;
  if (isFinite(battUsed)){
    var battLeft = 100 - battUsed;
    document.getElementById('battUsed').textContent = fmtPct(battUsed);
    document.getElementById('battLeft').textContent = battLeft > 0 ? fmtPct(battLeft) + ' left' : 'not enough';
    battReadout.classList.toggle('unsafe', battLeft < BATTERY_RESERVE_PCT);
    battReadout.style.display = '';
    if (battLeft < BATTERY_RESERVE_PCT){
      battWarning.innerHTML = '⚠️ This round trip needs about ' + fmtPct(battUsed) + ' of a full battery' +
        (battLeft > 0 ? ', leaving less than a ' + BATTERY_RESERVE_PCT + '% reserve' : ' — more than one charge') +
        '. Shorten the route, lighten the payload, or wait for calmer wind.';
      battWarning.style.display = 'block';
    } else {
      battWarning.style.display = 'none';
    }
  } else {
    battReadout.style.display = 'none';
    battWarning.style.display = 'none';
  }

  // Terrain sentence + side view (both legs).
  var terrainInfo = document.getElementById('terrainInfo');
  if (r.terrainAvailable){
    var text = c.terrainBaseText;
    if (out){
      var po = out.prof;
      var peakRel = -Infinity;
      po.pts.forEach(function(p){ peakRel = Math.max(peakRel, p.alt - r.terrainSamples[0].g); });
      // A photo mission doesn't land at the destination, so its outbound
      // leg doesn't make that last descent.
      var lastS = r.terrainSamples[r.terrainSamples.length - 1];
      var descends = c.mission === 'photo' ? po.climbDown - Math.max(0, po.pts[po.pts.length - 1].alt - lastS.g) : po.climbDown;
      text += ' Outbound (' + planLegLabel(out) + '): climbs ' + fmtLen(po.climbUp) + ' and descends ' + fmtLen(Math.max(0, descends)) +
        ' in total, peaking about ' + fmtLen(peakRel) + ' above the takeoff point, between ' + fmtLen(Math.max(0, po.minAGL)) +
        ' and ' + fmtLen(po.maxAGL) + ' above the ground.';
      renderTerrainProfile(r.terrainSamples, po, c.heights[out.i], back ? { prof: back.prof, h: c.heights[back.i] } : null,
        { turnInAir: c.mission === 'photo' });
    } else {
      renderTerrainProfile(null);
    }
    terrainInfo.innerHTML = text + ' Elevation: Copernicus GLO-90 (~90 m cells), which smooths out narrow cliffs — keep visual line of sight.';
  }

  // Flight-plan exports for this plan: delivery = one mission each
  // way, landing at the end of each; photo = one round trip.
  var missions = [];
  var prefix = PLAN_FILE_PREFIX[selectedPlan] || 'flytimizer-';
  // A mission can't fly faster than the mission speed: a leg planned
  // faster (Sport mode) is saved at the mission speed.
  var speedOut = out && out.speed ? Math.min(out.speed, c.speedOut) : c.speedOut, speedBack = back && back.speed ? Math.min(back.speed, c.speedBack) : c.speedBack;
  var byHand = [out, back].some(function(leg){ return leg && leg.speedFactor > 1; });
  if (out && r.terrainAvailable){
    if (c.mission === 'photo'){
      // One mission for the whole round trip, at the outbound leg's speed.
      missions.push({
        label: back ? 'Download flight plan (round trip)' : 'Download flight plan (outbound)',
        filename: prefix + (back ? 'round-trip.kmz' : 'outbound.kmz'),
        waypoints: back ? roundTripWaypoints(r.terrainSamples, out.prof, r.terrainBack, back.prof) : profileWaypoints(r.terrainSamples, out.prof),
        speedMS: speedOut,
        finishAction: 'goHome'
      });
    } else {
      missions.push({ label: 'Download outbound mission', filename: prefix + 'outbound.kmz', waypoints: profileWaypoints(r.terrainSamples, out.prof), speedMS: speedOut, finishAction: 'autoLand' });
      if (back) missions.push({ label: 'Download return mission', filename: prefix + 'return.kmz', waypoints: profileWaypoints(r.terrainBack, back.prof), speedMS: speedBack, finishAction: 'autoLand' });
    }
  }
  lastRoute = missions.length ? { missions: missions, droneModel: c.droneModel } : null;
  // Fetch the zip library now, so the download is instant when clicked.
  if (missions.length) loadJSZip().catch(function(){});
  var wpmlBox = document.getElementById('wpmlButtons');
  if (wpmlBox){
    wpmlBox.innerHTML = missions.map(function(m, k){
      return '<button class="btn btn-ghost" data-action="download" data-arg="' + k + '">' + m.label + '</button>';
    }).join('') + (missions.length && byHand
      ? '<span class="wpml-note" id="sportNote">This plan flies a leg into the wind in Sport mode, faster than a mission can (' + fmtSpeed(c.speedOut) +
        '). The download flies it at the mission speed, which takes a little more battery — fly that leg by hand for the figures above. Sport mode turns obstacle sensing off.</span>'
      : '');
  }

  renderPlanTabs();
}
