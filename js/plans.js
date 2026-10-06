// The two plans (fastest / least battery) and their result panel.

import { BATTERY_RESERVE_PCT, fmtPct } from './battery.js';
import { formatDuration } from './core.js';
import { roundTripWaypoints } from './mission.js';
import { profileWaypoints, renderTerrainProfile } from './terrain.js';
import { fmtLen, lenNum, lenUnit } from './units.js';

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
// cheapest flyable one wins, separately for each leg.
// ---------------------------------------------------------------
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

export function planLegLabel(leg){
  if (!leg) return '—';
  return leg.mode === 'level' ? 'holds altitude' : 'follows terrain';
}

export function renderPlanTabs(){
  var c = currentCalc;
  var tabs = document.getElementById('planTabs');
  if (!tabs || !c) return;
  var eco = c.plans.eco;
  tabs.style.display = eco ? '' : 'none';
  ['fast', 'eco'].forEach(function(key){
    var btn = document.getElementById(key === 'fast' ? 'planFastBtn' : 'planEcoBtn');
    var plan = c.plans[key];
    if (!btn) return;
    btn.classList.toggle('active', selectedPlan === key);
    btn.setAttribute('aria-selected', selectedPlan === key ? 'true' : 'false');
    var title = key === 'fast' ? 'Fastest' : 'Least battery';
    var detail = '';
    if (plan && plan.out && plan.back && isFinite(plan.totalTime)){
      detail = formatDuration(plan.totalTime) + (isFinite(plan.totalBatt) ? ' · ' + fmtPct(plan.totalBatt) : '');
    }
    btn.innerHTML = '<span class="plan-title">' + title + '</span><span class="plan-detail">' + (detail || 'no safe option') + '</span>';
  });
  var note = document.getElementById('planNote');
  if (note){
    var same = eco && c.plans.fast.out && eco.out && c.plans.fast.back && eco.back &&
      c.plans.fast.out.i === eco.out.i && c.plans.fast.out.mode === eco.out.mode &&
      c.plans.fast.back.i === eco.back.i && c.plans.fast.back.mode === eco.back.mode;
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

  document.getElementById('heightfore').innerHTML = out ? lenNum(c.heights[out.i]) : '&mdash;';
  document.getElementById('heightback').innerHTML = back ? lenNum(c.heights[back.i]) : '&mdash;';
  document.getElementById('unitFore').textContent = lenUnit();
  document.getElementById('unitBack').textContent = lenUnit();
  document.getElementById('styleFore').textContent = out ? 'min. above ground, ' + planLegLabel(out) : '';
  document.getElementById('styleBack').textContent = back ? 'min. above ground, ' + planLegLabel(back) : '';
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

  // Terrain sentence + side view (outbound leg).
  var terrainInfo = document.getElementById('terrainInfo');
  if (c.terrainAvailable){
    var text = c.terrainBaseText;
    if (out){
      var po = out.prof;
      var peakRel = -Infinity;
      po.pts.forEach(function(p){ peakRel = Math.max(peakRel, p.alt - c.terrainSamples[0].g); });
      text += ' Outbound (' + planLegLabel(out) + '): climbs ' + fmtLen(po.climbUp) + ' and descends ' + fmtLen(po.climbDown) +
        ' in total, peaking about ' + fmtLen(peakRel) + ' above the takeoff point, between ' + fmtLen(Math.max(0, po.minAGL)) +
        ' and ' + fmtLen(po.maxAGL) + ' above the ground.';
      renderTerrainProfile(c.terrainSamples, po, c.heights[out.i]);
    } else {
      renderTerrainProfile(null);
    }
    terrainInfo.innerHTML = text + ' Elevation: Copernicus GLO-90 (~90 m cells), which smooths out narrow cliffs — keep visual line of sight.';
  }

  // Flight-plan exports for this plan: delivery = one mission each
  // way, landing at the end of each; photo = one round trip.
  var missions = [];
  if (out && c.terrainAvailable){
    if (c.mission === 'photo'){
      missions.push({
        label: back ? 'Download flight plan (round trip)' : 'Download flight plan (outbound)',
        filename: back ? 'flytimizer-round-trip.kmz' : 'flytimizer-outbound.kmz',
        waypoints: back ? roundTripWaypoints(c.terrainSamples, out.prof, c.terrainBack, back.prof) : profileWaypoints(c.terrainSamples, out.prof),
        speedMS: c.speedOut,
        finishAction: 'goHome'
      });
    } else {
      missions.push({ label: 'Download outbound mission', filename: 'flytimizer-outbound.kmz', waypoints: profileWaypoints(c.terrainSamples, out.prof), speedMS: c.speedOut, finishAction: 'autoLand' });
      if (back) missions.push({ label: 'Download return mission', filename: 'flytimizer-return.kmz', waypoints: profileWaypoints(c.terrainBack, back.prof), speedMS: c.speedBack, finishAction: 'autoLand' });
    }
  }
  lastRoute = missions.length ? { missions: missions, droneModel: c.droneModel } : null;
  var wpmlBox = document.getElementById('wpmlButtons');
  if (wpmlBox){
    wpmlBox.innerHTML = missions.map(function(m, k){
      return '<button class="btn btn-ghost" data-action="download" data-arg="' + k + '">' + m.label + '</button>';
    }).join('');
  }

  renderPlanTabs();
}
