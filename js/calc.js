// calcHeight(): the main calculation that ties everything together,
// plus the steps it's broken into - reading the forecast and the
// drone settings, per-height wind checks, buildings on the route,
// per-leg profiles/timings/battery, the result panels, and the two
// plans.

import { track } from './analytics.js';
import { BATTERY_RESERVE_PCT, DESCENT_POWER_FACTOR, SPEC_FLIGHT_TIME_FACTOR, batteryPct, climbEfficiency, coldCapacityFactor, energyPctAbove, gaugeUsedPct, fmtPct, legEnergyFromTiming, profileTiming, readBatteryFields } from './battery.js';
import { ENGINE_URL, remoteComputePlan } from './engine-client.js';
import { decodeResult, encodeResult } from './engine-codec.js';
import { MIN_GROUND_SPEED_MS, airspeedFor, formatDuration, getDistanceFromLatLon, groundSpeed, interpDir, lat1, lat2, lng1, lng2, marker, trueBearing } from './core.js';
import { markUnsafe, payloadCheck, payloadFactors } from './drone.js';
import { renderHazardsAndRoute } from './map-view.js';
import { currentMission } from './mission.js';
import { hideNotice, showNotice } from './notice.js';
import { BUILDING_AVOID_MAX_COUNT, BUILDING_HEIGHT_SAFETY_MARGIN_M, BUILDING_LATERAL_SAFETY_MARGIN_M, HAZARD_TYPE_LABEL, getBuildingsNearPath } from './osm.js';
import { renderPeopleView } from './people.js';
import { currentCalc, renderPlan, renderPlanTabs, selectedPlan, setCurrentCalc } from './plans.js';
import { renderRange } from './range.js';
import { Progress, estimateLookupSeconds } from './progress.js';
import { buildingsCrossingPath, minDistanceFromPath } from './routing.js';
import { MILE_M, altitudePermitChecked, formatDistance, renderRulesInfo } from './rules.js';
import { updateUrlForRoute } from './share.js';
import { skippedSiteTypes } from './sites.js';
import { MAX_AGL_M, buildAltitudeProfile, buildingAltitudeRequirements, flatTerrainProfile, getTerrainProfile, renderTerrainProfile, reverseSamples, setMaxAglM } from './terrain.js';
import { chooseUnits, escapeHtml, fmtDist, fmtLen, fmtSpeed, unitsImperial } from './units.js';
import { urbanFactorFor } from './urbanwind.js';
import { legSegmentSpeeds, routeSegments } from './windfield.js';
import { renderCompassRose } from './visuals.js';
import { forecastOffsetH, renderForecastStrip } from './weather.js';

// Heights (m above ground) every route is checked at.
export var CANDIDATE_HEIGHTS_M = [30, 40, 50, 60, 70, 80, 90, 100, 110, 120];

// Forecast values for one hour, wind in m/s.
export function forecastAt(json, hour){
  var h = json.hourly;
  var wx = {
    ws10: h.wind_speed_10m[hour] / 3.6,
    ws80: h.wind_speed_80m[hour] / 3.6,
    ws120: h.wind_speed_120m[hour] / 3.6,
    wd10: h.wind_direction_10m[hour],
    wd80: h.wind_direction_80m[hour],
    wd120: h.wind_direction_120m[hour],
    gust10: h.wind_gusts_10m[hour] / 3.6,
    precipitation_probability: h.precipitation_probability[hour],
    precipitation: h.precipitation[hour],
    visibility: h.visibility[hour],
    temperatureC: h.temperature_2m ? h.temperature_2m[hour] : null
  };
  // Gusts are only forecast at 10m. We estimate gusts at other heights
  // by applying the same gustiness ratio (gust/average at 10m) to the
  // average wind there - clamped so a near-calm 10m reading (division
  // by ~0) can't blow the ratio up unrealistically.
  var gustFactor = (wx.ws10 > 0.1) ? (wx.gust10 / wx.ws10) : 1;
  wx.gustFactor = Math.min(Math.max(gustFactor, 1), 3);
  return wx;
}

// The drone and mission settings from the form. Speeds are divided by
// the payload coefficient for each leg. The plans fly at the mission
// speed (no faster than the top speed; the top speed if it's blank),
// the most a waypoint mission flies.
export function readFlightInputs(mission){
  function val(id){ return document.getElementById(id).value; }
  // The payload as a weight factor (drone + payload) / drone; photo
  // missions carry the same load both ways.
  var payload = payloadFactors(mission);
  var payloadOutCoef = payload.out, payloadBackCoef = payload.back;
  var top = parseFloat(val('hor')), cruise = parseFloat(val('cruise'));
  var horiz = cruise > 0 ? Math.min(cruise, top) : top;
  return {
    dwellS: Math.max(0, parseFloat(val('dwell')) || 0),
    payloadOutCoef: payloadOutCoef,
    payloadBackCoef: payloadBackCoef,
    speedup: val('asc') / payloadOutCoef,
    speeddown: val('des') / payloadOutCoef,
    speedhorizontal: horiz / payloadOutCoef,
    speedupback: val('asc') / payloadBackCoef,
    speeddownback: val('des') / payloadBackCoef,
    speedhorizontalback: horiz / payloadBackCoef,
    drag: val('drag'),
    windResistance: parseFloat(val('windres')),
    speedMode: val('speedMode') === 'air' ? 'air' : 'ground'
  };
}

// Per-height wind figures (average speed/direction, estimated gust,
// crosswind component, ground speed and airspeed for each leg, and
// whether that height is flyable on wind grounds alone).
//
// Two ways a drone can fly a leg (inp.speedMode):
//  - 'ground' (default): it holds the set speed over the ground, like
//    DJI waypoint missions and most multirotors in GPS mode. A
//    tailwind doesn't make it faster - it flies slower through the air
//    and saves battery instead. Into a headwind it's already flying
//    flat out, so it slows down just as in 'air' mode.
//  - 'air': it holds the set speed through the air, like a fixed-wing
//    drone, or a multirotor flown flat out. Ground speed is airspeed
//    plus or minus the wind, so a tailwind makes it faster.
// The set speed (hor / payload) is also the most it can do through
// the air. These only depend on the
// forecast and the drone's own speeds - not on the route distance -
// so they can be worked out before the final (possibly detoured)
// route length is known. dronedegrees is the REVERSE bearing
// (destination -> start); the formulas below rely on that convention.
export function windByHeight(heights, wx, dronedegrees, inp){
  var w = { ws: [], wsOpen: [], urbanFactor: [], wd: [], estgust: [], crosswind: [], windResOk: [], crosswindOkOut: [], crosswindOkBack: [],
            gsOut: [], gsBack: [], airOut: [], airBack: [], headwindOkOut: [], headwindOkBack: [] };
  var holdGround = inp.speedMode !== 'air';
  var dragF = parseFloat(inp.drag) || 1;
  for (var i = 0; i < heights.length; i++){
    if (heights[i] < 80){
      w.ws[i] = wx.ws10 * (80 - heights[i]) / 70 + wx.ws80 * (heights[i] - 10) / 70;
      w.wd[i] = interpDir(wx.wd10, wx.wd80, (heights[i] - 10) / 70);
    } else if (heights[i] == 80){
      w.ws[i] = wx.ws80;
      w.wd[i] = wx.wd80;
    } else if (heights[i] == 120){
      w.ws[i] = wx.ws120;
      w.wd[i] = wx.wd120;
    } else {
      w.ws[i] = wx.ws80 * (120 - heights[i]) / 40 + wx.ws120 * (heights[i] - 80) / 40;
      w.wd[i] = interpDir(wx.wd80, wx.wd120, (heights[i] - 80) / 40);
    }
    var diffangle = (w.wd[i] - dronedegrees) / 180 * Math.PI;
    // Buildings along the route (wx.urban, see urbanwind.js) change the
    // average wind the drone flies in, so its times and battery. The
    // gust and crosswind checks keep the forecast wind (never less):
    // the building model is an estimate, and buildings make the wind
    // gustier even where they slow it down.
    var f = urbanFactorFor(wx.urban, heights[i]);
    w.wsOpen[i] = w.ws[i];
    w.urbanFactor[i] = f;
    var wsCheck = Math.max(w.ws[i], w.ws[i] * f);
    w.ws[i] = w.ws[i] * f;
    // Gust extrapolated from the 10m gust/average ratio, and the
    // crosswind component (perpendicular to heading) of the average
    // wind - used as separate flyability checks.
    w.estgust[i] = wsCheck * wx.gustFactor;
    w.crosswind[i] = wsCheck * Math.abs(Math.sin(diffangle));
    w.windResOk[i] = w.estgust[i] < inp.windResistance;
    w.crosswindOkOut[i] = inp.speedhorizontal > w.crosswind[i];
    w.crosswindOkBack[i] = inp.speedhorizontalback > w.crosswind[i];
    // Wind-triangle ground speed for each leg (drag scales how strongly
    // the wind acts on the drone; 1.0 = plain vector addition). The
    // return leg flies the opposite track, so its relative angle is +180.
    var windF = w.ws[i] * dragF;
    var gsMaxOut = groundSpeed(inp.speedhorizontal, windF, diffangle);
    var gsMaxBack = groundSpeed(inp.speedhorizontalback, windF, diffangle + Math.PI);
    if (holdGround){
      w.gsOut[i] = Math.min(inp.speedhorizontal, gsMaxOut);
      w.gsBack[i] = Math.min(inp.speedhorizontalback, gsMaxBack);
      w.airOut[i] = airspeedFor(w.gsOut[i], windF, diffangle);
      w.airBack[i] = airspeedFor(w.gsBack[i], windF, diffangle + Math.PI);
    } else {
      w.gsOut[i] = gsMaxOut;
      w.gsBack[i] = gsMaxBack;
      w.airOut[i] = inp.speedhorizontal;
      w.airBack[i] = inp.speedhorizontalback;
    }
    w.headwindOkOut[i] = !w.crosswindOkOut[i] || w.gsOut[i] > MIN_GROUND_SPEED_MS;
    w.headwindOkBack[i] = !w.crosswindOkBack[i] || w.gsBack[i] > MIN_GROUND_SPEED_MS;
  }
  return w;
}

// Round-trip range from the start in every direction: how far the
// drone can fly out and back on one charge, keeping the battery
// reserve, at whichever allowed and wind-flyable height reaches
// farthest that way. Flat ground and a straight line each way - no
// terrain, buildings or restricted areas, which need a real route.
// Per height and direction the energy is a fixed part (takeoff,
// landing, the time at the destination) plus a cost per metre for
// each leg, so the distance comes straight out of the budget.
// c: { heights, legalOk, wx, inp, battModel, payloadOut, payloadBack,
//      temperatureC, mission, stepDeg }
// Returns [{ bearing, distM, heightM }] (distM 0 where the drone
// can't get anywhere and back), or null without a battery model.
export var RANGE_STEP_DEG = 5;
export function roundTripRange(c){
  var m = c.battModel, inp = c.inp;
  if (!m) return null;
  var step = c.stepDeg || RANGE_STEP_DEG;
  // The energy above the reserve on the gauge (its last percents hold less).
  var budgetWh = m.wh * m.usableFraction * coldCapacityFactor(c.temperatureC) * energyPctAbove(m, BATTERY_RESERVE_PCT) / 100;
  var dwellWh = m.hoverW * Math.pow(c.payloadOut, 1.5) * inp.dwellS / 3600;
  // Delivery lands at the destination; photo turns around in the air.
  var lands = c.mission !== 'photo';
  function timing(cruise, climb, desc){ return { total: cruise + climb + desc, cruise: cruise, climb: climb, desc: desc }; }
  var out = [];
  for (var b = 0; b < 360; b += step){
    // windByHeight takes the reverse bearing (destination -> start).
    var w = windByHeight(c.heights, c.wx, (b + 180) % 360, inp);
    var best = { bearing: b, distM: 0, heightM: null };
    for (var i = 0; i < c.heights.length; i++){
      if (!(c.legalOk[i] && w.windResOk[i] && w.crosswindOkOut[i] && w.crosswindOkBack[i] && w.headwindOkOut[i] && w.headwindOkBack[i])) continue;
      var h = c.heights[i];
      var fixedWh = dwellWh +
        legEnergyFromTiming(m, c.payloadOut, w.airOut[i], timing(0, h / inp.speedup, lands ? h / inp.speeddown : 0), inp.speedup) +
        legEnergyFromTiming(m, c.payloadBack, w.airBack[i], timing(0, lands ? h / inp.speedupback : 0, h / inp.speeddownback), inp.speedupback);
      var perMWh =
        legEnergyFromTiming(m, c.payloadOut, w.airOut[i], timing(1 / w.gsOut[i], 0, 0), inp.speedup) +
        legEnergyFromTiming(m, c.payloadBack, w.airBack[i], timing(1 / w.gsBack[i], 0, 0), inp.speedupback);
      var d = (budgetWh - fixedWh) / perMWh;
      if (d > best.distM) best = { bearing: b, distM: d, heightM: h };
    }
    out.push(best);
  }
  return out;
}

// Wind alone can put a lower ceiling on today's flight than the
// drone's altitude limit - e.g. gusts might only stay under the
// drone's rating up to 80 m even though we normally check as high as
// 120 m. A building only counts as "too tall to climb over" once it's
// taller than whichever ceiling is actually flyable right now (wind
// included), not a flat 120 m - otherwise we'd recommend climbing to
// a height that the wind rules out anyway.
export function flyableCeilingM(heights, legalOk, w){
  var ceiling = 0;
  for (var i = 0; i < heights.length; i++){
    if (legalOk[i] && w.windResOk[i] && w.crosswindOkOut[i] && w.crosswindOkBack[i] && w.headwindOkOut[i] && w.headwindOkBack[i] && heights[i] > ceiling){
      ceiling = heights[i];
    }
  }
  return ceiling;
}

// Splits the buildings on the route into the ones to climb over and
// the ones to detour around.
export function sortRouteBuildings(buildingList, path, ceilingM){
  // Only buildings that actually sit on (within a safety margin of)
  // the route matter here. This checks against the *actual*
  // hazard-avoidance path, not the straight line - otherwise a route
  // that swings wide around a cluster of hazards could carry building
  // height/detour requirements from a building nowhere near where the
  // drone will really fly, or miss one that the swing brings it close to.
  var onRoute = buildingsCrossingPath(buildingList, path, BUILDING_LATERAL_SAFETY_MARGIN_M);
  var tooTall = onRoute.filter(function(b){
    return b.height + BUILDING_HEIGHT_SAFETY_MARGIN_M > ceilingM;
  });
  var climbable = onRoute.filter(function(b){
    return b.height + BUILDING_HEIGHT_SAFETY_MARGIN_M <= ceilingM;
  });
  // A handful of buildings actually on the route are simpler (and
  // often lets us fly lower) to just detour around at ground level
  // than to climb over all of them - detouring around every single
  // one only risks an impractical zigzag once there are enough of
  // them clustered on the direct line, so past that count we fall
  // back to climbing over the tallest of the climbable ones, and
  // only detour around the ones that are too tall to climb over
  // regardless (which happens no matter how many there are).
  var avoidAll = onRoute.length > 0 && onRoute.length <= BUILDING_AVOID_MAX_COUNT;
  var avoidedForSimplicity = avoidAll ? climbable : [];
  var climbedOver = avoidAll ? [] : climbable;
  return {
    onRoute: onRoute,
    tooTall: tooTall,
    avoidedForSimplicity: avoidedForSimplicity,
    toAvoid: tooTall.concat(avoidedForSimplicity),
    maxClimbedHeight: climbedOver.reduce(function(m, b){ return Math.max(m, b.height); }, 0)
  };
}

// Terrain-following altitude profile for one leg at every height.
export function legProfiles(heights, samples, req, hs, up, down){
  var prof = [], ok = [];
  for (var i = 0; i < heights.length; i++){
    prof[i] = buildAltitudeProfile(samples, heights[i], req, hs / up, hs / down);
    ok[i] = prof[i].ok;
  }
  return { prof: prof, ok: ok };
}

// How long one leg takes at every height: timeH = time to cover the
// distance; timeV = everything the climbs and descents add on top
// (takeoff, landing, and any stretch where the height change is
// slower than the distance).
// gs[i]: one ground speed for the leg, or one per stretch (windfield.js).
export function legTimings(heights, prof, samples, gs, up, down, opts, routeDist){
  var t = { timing: [], timeH: [], timeV: [] };
  for (var i = 0; i < heights.length; i++){
    t.timing[i] = gsFlyable(gs[i]) ? profileTiming(prof[i], samples, gs[i], up, down, opts) : null;
    t.timeH[i] = t.timing[i] ? flatTime(gs[i], samples, routeDist) : Infinity;
    t.timeV[i] = t.timing[i] ? t.timing[i].total - t.timeH[i] : 0;
  }
  return t;
}

// The drone makes headway: on every stretch, with per-stretch speeds.
export function gsFlyable(gs){
  if (!Array.isArray(gs)) return gs > MIN_GROUND_SPEED_MS;
  for (var k = 0; k < gs.length; k++) if (!(gs[k] > MIN_GROUND_SPEED_MS)) return false;
  return gs.length > 0;
}

// Time to fly the route level, without climbs.
function flatTime(gs, samples, routeDist){
  if (!Array.isArray(gs)) return routeDist / gs;
  var t = 0;
  for (var k = 0; k < gs.length; k++) t += (samples[k + 1].s - samples[k].s) / gs[k];
  return t;
}

// Battery % for one leg at every height (NaN without a battery model).
// airspeed[i]: the speed through the air at that height, which sets
// the cruise power.
export function legBattery(heights, battModel, payload, airspeed, timing, up, temperatureC){
  var batt = [];
  for (var i = 0; i < heights.length; i++){
    batt[i] = battModel ? batteryPct(battModel, legEnergyFromTiming(battModel, payload, airspeed[i], timing[i], up), temperatureC) : NaN;
  }
  return batt;
}

// Index of the quickest flyable height, or -1 if none is flyable.
export function fastestFlyableIdx(flyable, timeV, timeH){
  var best = -1;
  for (var i = 0; i < flyable.length; i++){
    if (flyable[i] && (best === -1 || timeV[i] + timeH[i] < timeV[best] + timeH[best])) best = i;
  }
  return best;
}

// Airports, military sites, prisons and embassies aren't just "risky
// to overfly" like a school - flying near them can be flatly illegal
// or need special authorization, no matter how wide a berth the route
// gives them. The routing avoidance only ever detours around a capped
// radius (so one huge site can't break the pathfinding), so that alone
// isn't enough of a check - this looks at actual distance to the real
// site instead and raises a hard, unmissable warning when the route
// comes anywhere close.
export function renderNoFlyWarning(hazards, rules, path){
  var noFlyWarningEl = document.getElementById('noFlyWarning');
  var noFlyItems = hazards.filter(function(h){
    if (!h.noFly) return false;
    return minDistanceFromPath(path, h.lat, h.lng) < (h.radius + h.warnM);
  }).map(function(h){
    var label = HAZARD_TYPE_LABEL[h.type] || 'restricted site';
    if (h.name) label += ' (' + escapeHtml(h.name) + ')';
    var note = rules.profile.noFlyNote[h.type];
    return label + ' — ' + (note || ('keep-out distance around ' + formatDistance(h.buffer)));
  });
  var zoneNotes = [];
  rules.profile.specialZones.forEach(function(z){
    if (minDistanceFromPath(path, z.lat, z.lng) >= z.radiusM) return;
    if (z.noFly) noFlyItems.push(z.name + ' — ' + z.text);
    else zoneNotes.push(z.name + ': ' + z.text + '.');
  });
  // An inner no-fly zone already covers the outer ring's message.
  if (noFlyItems.length > 0) zoneNotes = [];
  if (noFlyItems.length > 0 || zoneNotes.length > 0){
    var lead = noFlyItems.length > 0
      ? '⚠️ This route passes near: ' + noFlyItems.join('; ') + '. Flying here may be illegal or require authorization, regardless of the altitude or path shown above.'
      : '⚠️ ' + zoneNotes.join(' ');
    noFlyWarningEl.innerHTML = lead +
      '<span class="no-fly-detail">Applying ' + (rules.fallback ? 'Israel’s rules (the default for this country)' : 'the rules for ' + rules.profile.country) +
      '. Distances come from published rule summaries and OpenStreetMap’s map data — a starting point, not a guarantee. Check <a href="' + rules.profile.checkUrl + '" target="_blank" rel="noopener" style="color:inherit">' + rules.profile.checkLabel + '</a> before flying.</span>';
    noFlyWarningEl.style.display = 'block';
  } else {
    noFlyWarningEl.style.display = 'none';
  }
}

export function renderBatteryNote(battModel, temperatureC){
  var battNote = document.getElementById('batteryNote');
  if (!battNote) return;
  battNote.innerHTML = (battModel && battModel.measured
      ? 'Battery figures are estimates from this drone’s measured flight logs, payload, climbs and wind (roughly ±20%)'
      : 'Battery figures are estimates from the drone’s rated flight time, cut by ' + Math.round((1 - SPEC_FLIGHT_TIME_FACTOR) * 100) +
        '% since makers measure it in a lab, and from payload, climbs and wind (roughly ±20%)') +
    (typeof temperatureC === 'number' && coldCapacityFactor(temperatureC) < 1 ? ', reduced for the cold (' + (unitsImperial ? (temperatureC * 9 / 5 + 32).toFixed(0) + '°F' : temperatureC.toFixed(0) + '°C') + ')' : '') +
    '. Older packs hold less — set battery health in the drone settings.';
  battNote.style.display = battModel ? 'block' : 'none';
}

// Route length (with any detour) and outbound heading.
export function renderRouteSummary(routeDist, straightDistM, avoidance, outboundHeading){
  document.getElementById('distance').innerHTML = fmtDist(routeDist);
  var detourNote = document.getElementById('detourNote');
  var detourExtra = routeDist - straightDistM;
  var totalAvoided = avoidance.buildingsAvoided + avoidance.hazardsAvoided;
  if (totalAvoided > 0 && detourExtra > 1){
    var avoidedParts = [];
    if (avoidance.buildingsAvoided > 0) avoidedParts.push(avoidance.buildingsAvoided + ' building' + (avoidance.buildingsAvoided===1?'':'s'));
    if (avoidance.hazardsAvoided > 0) avoidedParts.push(avoidance.hazardsAvoided + ' restricted area' + (avoidance.hazardsAvoided===1?'':'s'));
    detourNote.textContent = ' (+' + fmtDist(detourExtra) + ' detour around ' + avoidedParts.join(' and ') + ')';
  } else {
    detourNote.textContent = '';
  }
  document.getElementById('dronedir').innerHTML = outboundHeading.toFixed(0);
}

// The 30 / 80 / 120 m comparison table, with unsafe cells marked and
// the reason each one is unsafe.
// r: { heights, w, legalOk, buildingOk, terrainOkOut, terrainOkBack,
//      flyableOut, flyableBack, tOut, tBack, battPair, minSafeAltitude,
//      windResistance, rules }
// battPair: the gauge % a full battery drops by for the round trip.
export function renderHeightTable(r){
  var w = r.w;
  var cols = [[0, '30'], [5, '80'], [9, '120']];
  cols.forEach(function(c){
    var i = c[0], s = c[1];
    document.getElementById('ws' + s).innerHTML = fmtSpeed(w.ws[i]);
    document.getElementById('alt' + s).innerHTML = fmtLen(r.heights[i]);
    document.getElementById('batt' + s).innerHTML = fmtPct(r.battPair[i]);
    document.getElementById('gust' + s).innerHTML = fmtSpeed(w.estgust[i]);
    document.getElementById('wd' + s).innerHTML = (w.wd[i]).toFixed(0);
    document.getElementById('timefore' + s).innerHTML = formatDuration(r.tOut.timeV[i] + r.tOut.timeH[i]);
    document.getElementById('timeback' + s).innerHTML = formatDuration(r.tBack.timeV[i] + r.tBack.timeH[i]);
  });

  var rules = r.rules;
  var unsafeReasonBuilding = "Below the minimum safe height above buildings on this route (min " + fmtLen(r.minSafeAltitude) + ").";
  var unsafeReasonGust = "Estimated gust here is at or above this drone's rated wind resistance (" + fmtSpeed(r.windResistance) + ").";
  var unsafeReasonCrossOut = "The crosswind component here is at or above this drone's outbound speed - it couldn't hold this course.";
  var unsafeReasonCrossBack = "The crosswind component here is at or above this drone's return speed - it couldn't hold this course.";
  var unsafeReasonHead = "The headwind here is at or above this drone's speed for this leg - it would barely move forward, if at all.";
  var unsafeReasonTerrain = "Holding this height above the terrain would take the drone more than " + fmtLen(MAX_AGL_M) + " above the ground somewhere on this route (the ground drops away faster than it can descend).";
  var unsafeReasonLegal = "Above the legal height limit here (" + rules.profile.maxAglLabel + " above ground in " + (rules.fallback ? "Israel's rules, used as the default" : rules.profile.country) + "). Tick \"I have authorization to fly higher\" in the drone settings if you have a permit.";
  function cellReason(idx, crosswindOk, crossMsg, headwindOk, terrainOk){
    if (!r.legalOk[idx]) return unsafeReasonLegal;
    if (!r.buildingOk[idx]) return unsafeReasonBuilding;
    if (!w.windResOk[idx]) return unsafeReasonGust;
    if (!crosswindOk) return crossMsg;
    if (headwindOk === false) return unsafeReasonHead;
    if (terrainOk === false) return unsafeReasonTerrain;
    return '';
  }
  var unsafeNoteEl = document.getElementById('unsafeReasonNote');
  if (unsafeNoteEl) unsafeNoteEl.style.display = 'none';
  cols.forEach(function(c){
    var i = c[0], s = c[1];
    markUnsafe('timefore' + s, !r.flyableOut[i], cellReason(i, w.crosswindOkOut[i], unsafeReasonCrossOut, w.headwindOkOut[i], r.terrainOkOut[i]));
    markUnsafe('timeback' + s, !r.flyableBack[i], cellReason(i, w.crosswindOkBack[i], unsafeReasonCrossBack, w.headwindOkBack[i], r.terrainOkBack[i]));
  });
  cols.forEach(function(c){
    var i = c[0], s = c[1];
    markUnsafe('ws' + s, !w.crosswindOkOut[i] || !w.crosswindOkBack[i], "The crosswind component here is at or above this drone's speed for at least one leg.");
  });
  cols.forEach(function(c){
    markUnsafe('gust' + c[1], !w.windResOk[c[0]], unsafeReasonGust);
  });
}

// Terrain summary; returns the base sentence that renderPlan() builds
// on (undefined when terrain didn't load).
export function renderTerrainInfo(terrainAvailable, terrainSamples){
  var terrainBaseText;
  var terrainInfo = document.getElementById('terrainInfo');
  terrainInfo.classList.remove('warning-hint');
  if (!terrainAvailable){
    terrainInfo.innerHTML = "⚠️ Couldn't load terrain elevation for this route, so hills and valleys along the way aren't being checked &mdash; the heights shown are above the takeoff point only, which is not safe over rising ground. The flight-plan download is disabled until terrain loads. <button class=\"btn btn-ghost btn-inline\" data-action=\"calculate\">Try again</button>";
    terrainInfo.classList.add('warning-hint');
    renderTerrainProfile(null);
  } else {
    var gMin = Infinity, gMax = -Infinity;
    terrainSamples.forEach(function(p){ gMin = Math.min(gMin, p.g); gMax = Math.max(gMax, p.g); });
    var gStart = terrainSamples[0].g, gEnd = terrainSamples[terrainSamples.length - 1].g;
    // The plan-specific sentence and the side view are added by
    // renderPlan(), so switching plans doesn't need a recalculation.
    terrainBaseText = "Ground along the route: " + fmtLen(gMin) + "–" + fmtLen(gMax) + " above sea level (start " + fmtLen(gStart) + ", destination " + fmtLen(gEnd) + "). Heights are above the ground: the drone always stays at least that high above it and never more than " + fmtLen(MAX_AGL_M) + " above it.";
  }
  terrainInfo.style.display = 'block';
  return terrainBaseText;
}

// Whether to use the building effect on the wind (the setting is on
// unless switched off).
export function urbanWindChecked(){
  var el = typeof document !== 'undefined' && document.getElementById('urbanWind');
  return !el || el.checked;
}

function pctLabel(f){
  var p = Math.round((1 - f) * 100);
  return p >= 0 ? p + '% weaker' : (-p) + '% stronger';
}

// Takeoff and landing: the wind low down at the start and (for a
// delivery) the destination, among the buildings there, and a warning
// when the gusts there may be too much for the drone.
export function renderGroundWind(start, dest, windResistance){
  var info = document.getElementById('groundWindInfo');
  var warn = document.getElementById('groundWindWarning');
  if (!info || !warn) return;
  function range(g){
    var lo = Math.min.apply(null, g.map(function(x){ return x.ws; })), hi = Math.max.apply(null, g.map(function(x){ return x.ws; }));
    return (Math.abs(hi - lo) < 0.5 ? 'about ' + fmtSpeed(hi) : fmtSpeed(lo) + '–' + fmtSpeed(hi));
  }
  function effect(g){
    var f = g[0].factor, around = g[0].source === 'buildings' ? ' right there' : '';
    return f > 1.15 ? ', funnelled by the buildings' + around : f < 0.85 ? ', sheltered by the buildings' + around : '';
  }
  function gust(g){ return Math.max.apply(null, g.map(function(x){ return x.gust; })); }
  var places = [{ name: 'the start', g: start }];
  if (dest) places.push({ name: 'the destination', g: dest });
  info.textContent = 'Takeoff and landing (' + fmtLen(start[0].h) + '–' + fmtLen(start[start.length - 1].h) + ' up): wind ' +
    places.map(function(p){ return range(p.g) + ' at ' + p.name + ' (gusts ~' + fmtSpeed(gust(p.g)) + effect(p.g) + ')'; }).join(', ') + '.';
  info.hidden = false;
  var bad = places.filter(function(p){ return p.g.some(function(x){ return x.gustCheck >= windResistance; }); });
  warn.hidden = !bad.length;
  warn.textContent = bad.length ? '⚠️ Gusts low down at ' + bad.map(function(p){ return p.name; }).join(' and ') +
    ' may reach ~' + fmtSpeed(Math.max.apply(null, bad.map(function(p){ return Math.max.apply(null, p.g.map(function(x){ return x.gustCheck; })); }))) +
    ', at or over this drone’s ' + fmtSpeed(windResistance) + ' rating: take off and land somewhere more open, or wait for calmer wind.' : '';
}

// One line on what the buildings along the route do to the wind.
export function renderUrbanWindInfo(urban, on){
  var el = document.getElementById('urbanWindInfo');
  if (!el) return;
  if (!on || !urban){
    el.style.display = 'none';
    return;
  }
  if (urban.maxW < 0.05){
    el.textContent = 'No built-up area along the route, so the forecast wind is used as it is.';
  } else {
    var i30 = urban.heights.indexOf(30), iTop = urban.heights.length - 1;
    el.textContent = 'Buildings along the route: the wind is about ' + pctLabel(urban.factor[i30 >= 0 ? i30 : 0]) +
      ' than over open ground at ' + fmtLen(urban.heights[i30 >= 0 ? i30 : 0]) + ' and ' + pctLabel(urban.factor[iTop]) +
      ' at ' + fmtLen(urban.heights[iTop]) + ' (worked out stretch by stretch). Used for the flight times and battery; ' +
      'the gust and crosswind checks keep the forecast wind. An estimate from building data (beta).';
  }
  el.style.display = 'block';
}

// r: { buildings, sorted, minSafeAltitude, effectiveCeilingM, legalCapM,
//      leftCheckedArea, deviationM, halfWidthUsed }
export function renderBuildingInfo(r){
  var buildings = r.buildings, onRoute = r.sorted.onRoute;
  var avoidedForSimplicity = r.sorted.avoidedForSimplicity, tooTallOnRoute = r.sorted.tooTall;
  var maxBuildingHeight = r.sorted.maxClimbedHeight;
  var buildingInfo = document.getElementById('buildingInfo');
  buildingInfo.classList.remove('warning-hint');
  if (buildings === null){
    buildingInfo.innerHTML = "Couldn't load building data from OpenStreetMap for this route, so only wind is being checked right now &mdash; heights below 30 m above nearby buildings might not actually be safe. <button class=\"btn btn-ghost btn-inline\" data-action=\"calculate\">Try again</button>";
    buildingInfo.classList.add('warning-hint');
  } else if (buildings.count === 0){
    buildingInfo.innerHTML = "No buildings found near this route in OpenStreetMap, so no extra height is needed for obstacle clearance.";
  } else if (onRoute.length === 0){
    buildingInfo.innerHTML = "Checked " + buildings.count + " building" + (buildings.count===1?'':'s') + " from OpenStreetMap near this route, but none of them are actually on the direct line, so none affect this route's altitude or path. Buildings are shown in faint orange on the map for reference.";
  } else {
    if (maxBuildingHeight > 0){
      buildingInfo.innerHTML = "Checked " + buildings.count + " building" + (buildings.count===1?'':'s') + " from OpenStreetMap near this route, " + onRoute.length + " of which " + (onRoute.length===1?'sits':'sit') + " on the direct line &mdash; the tallest one we still climb over is about " + fmtLen(maxBuildingHeight) + ", so we won't recommend flying below " + fmtLen(r.minSafeAltitude) + ". Buildings are shown in faint orange on the map for reference.";
    } else {
      buildingInfo.innerHTML = "Checked " + buildings.count + " building" + (buildings.count===1?'':'s') + " from OpenStreetMap near this route, " + onRoute.length + " of which " + (onRoute.length===1?'sits':'sit') + " on the direct line &mdash; none of them need extra height, since the route detours around " + (onRoute.length===1?'it':'them') + " instead. Buildings are shown in faint orange on the map for reference.";
    }

    if (avoidedForSimplicity.length > 0){
      var simplicityNote = document.createElement('span');
      simplicityNote.innerHTML = ' ' + avoidedForSimplicity.length + ' building' + (avoidedForSimplicity.length===1?' is':'s are') + ' directly on the route and could be climbed over, but with only ' + onRoute.length + ' on the direct line it\'s simpler (and lets you fly lower) to detour sideways around ' + (avoidedForSimplicity.length===1?'it':'them') + " instead, with a " + fmtLen(BUILDING_LATERAL_SAFETY_MARGIN_M) + ' clearance.';
      buildingInfo.appendChild(simplicityNote);
    }

    if (tooTallOnRoute.length > 0){
      var tallestTooTall = tooTallOnRoute.reduce(function(m, b){ return Math.max(m, b.height); }, 0);
      var ceilingNote = (r.effectiveCeilingM < r.legalCapM)
        ? (' the ' + fmtLen(r.effectiveCeilingM) + ' ceiling that today\'s wind allows (below the ' + fmtLen(r.legalCapM) + ' height limit)')
        : (' the ' + fmtLen(r.legalCapM) + ' height limit');
      var tooTallNote = document.createElement('span');
      tooTallNote.innerHTML = ' ' + tooTallOnRoute.length + ' building' + (tooTallOnRoute.length===1?' is':'s are') + ' too tall to clear by ' + fmtLen(BUILDING_HEIGHT_SAFETY_MARGIN_M) + ' within' + ceilingNote + ' (up to about ' + fmtLen(tallestTooTall) + ') — climbing over ' + (tooTallOnRoute.length===1?'it':'them') + " isn't possible within that limit, so the route is detoured sideways around " + (tooTallOnRoute.length===1?'it':'them') + ' instead, with a ' + fmtLen(BUILDING_LATERAL_SAFETY_MARGIN_M) + ' clearance.';
      buildingInfo.appendChild(tooTallNote);
    }

    var ghsl = buildings.ghsl;
    if (ghsl && ghsl.raised > 0){
      var ghslNote = document.createElement('span');
      ghslNote.innerHTML = ' OpenStreetMap has no height for ' + ghsl.checked + ' of these buildings; ' + ghsl.raised + (ghsl.raised===1?' was':' were') + ' raised to the average building height around ' + (ghsl.raised===1?'it':'them') + ' from the EU\u2019s Global Human Settlement Layer (2018) — an estimate, which can be well below a single tall tower.';
      buildingInfo.appendChild(ghslNote);
    } else if (ghsl && ghsl.failed){
      var ghslFail = document.createElement('span');
      ghslFail.innerHTML = ' OpenStreetMap has no height for some of these buildings, and the backup height data couldn\u2019t be loaded, so their heights are rough guesses from the building type.';
      buildingInfo.appendChild(ghslFail);
    }

    if (r.leftCheckedArea){
      var buildingCorridorWarning = document.createElement('span');
      buildingCorridorWarning.className = 'warning-hint';
      buildingCorridorWarning.innerHTML = ' Routing around a tall building swings the route about ' + fmtLen(r.deviationM) + ' from the hazard-avoidance path — further than the ' + fmtLen(r.halfWidthUsed) + ' either side that was actually checked for buildings around it, so the recommended height may not account for a taller building further out along that swing.';
      buildingInfo.appendChild(buildingCorridorWarning);
    }
  }
  buildingInfo.style.display = 'block';
}

// " 3 more (schools, playgrounds) in grey aren't avoided - your settings."
function ignoredNote(ignored){
  if (!ignored || ignored.length === 0) return '';
  var kinds = [];
  ignored.forEach(function(h){
    var k = (HAZARD_TYPE_LABEL[h.type] || h.type).toLowerCase();
    if (kinds.indexOf(k) === -1) kinds.push(k);
  });
  return ' ' + ignored.length + ' more (' + kinds.join(', ') + '), shown in grey, ' + (ignored.length === 1 ? 'isn\u2019t' : 'aren\u2019t') +
    ' avoided because of your Restricted areas settings.';
}

// r: { hazardData, hazards, ignored, avoidance, leftCheckedArea, deviationM, halfWidthUsed }
export function renderHazardInfo(r){
  var hazards = r.hazards, avoidance = r.avoidance;
  var hazardInfo = document.getElementById('hazardInfo');
  hazardInfo.classList.remove('warning-hint');
  if (r.hazardData === null){
    hazardInfo.innerHTML = "Couldn't load restricted-area data from OpenStreetMap, so schools, hospitals, power infrastructure, airports and other restricted sites along this route aren't being checked right now. The map servers may be busy - trying again in a minute usually works. <button class=\"btn btn-ghost btn-inline\" data-action=\"calculate\">Try again</button>";
    hazardInfo.classList.add('warning-hint');
  } else if (hazards.length === 0){
    hazardInfo.innerHTML = (r.ignored && r.ignored.length)
      ? "No restricted sites to avoid near this route." + ignoredNote(r.ignored)
      : "No schools, hospitals, power infrastructure, airports or other restricted sites found near this route in OpenStreetMap.";
  } else {
    var detourText = avoidance.hazardsAvoided > 0
      ? "The route on the map now detours around " + avoidance.hazardsAvoided + " of them."
      : "The straight-line route already clears all of them.";
    hazardInfo.innerHTML = "Found " + hazards.length + " restricted area" + (hazards.length===1?'':'s') + " (schools, hospitals, power infrastructure, airports and more) near this route, marked in red on the map, with a dashed ring for the keep-out distance the route stays outside. " + detourText + ignoredNote(r.ignored);

    var trappedList = avoidance.trapped || [];
    if (trappedList.length > 0){
      var trappedNames = trappedList.map(function(t){
        var label = HAZARD_TYPE_LABEL[t.type] || 'restricted area';
        if (t.name) label += ' (' + escapeHtml(t.name) + ')';
        var where = (t.atStart && t.atDest) ? 'start and destination' : (t.atStart ? 'start point' : 'destination point');
        return label + ' at the ' + where;
      });
      var trappedWarning = document.createElement('span');
      trappedWarning.className = 'warning-hint';
      trappedWarning.innerHTML = ' Your ' + trappedNames.join(', and your ') + ' is inside its keep-out distance, so the route can\'t stay outside it — it just doesn\'t get any closer to the site than it has to.';
      hazardInfo.appendChild(trappedWarning);
    }

    if (r.leftCheckedArea){
      var corridorWarning = document.createElement('span');
      corridorWarning.className = 'warning-hint';
      corridorWarning.innerHTML = ' To dodge these, the route swings about ' + fmtLen(r.deviationM) + ' from the straight line — further than the ' + fmtLen(r.halfWidthUsed) + ' either side that was actually checked, so schools/hospitals/etc. further out along that swing may not be accounted for. Double-check that stretch of the route yourself before flying it.';
      hazardInfo.appendChild(corridorWarning);
    }
  }
  hazardInfo.style.display = 'block';
}

// When both legs have a flyable height: the savings against the
// baseline (the highest height that's legal and flyable on both legs -
// the "just go high" choice most pilots would make): { baseIdx,
// travel120, travelopt, battSave, timeNoWind } for renderBaselineSavings
// and the plans' savings line.
// r: { heights, flyableOut, flyableBack, tOut, tBack, battOut, battBack,
//      battModel, minhor, minhorb, routeDist, speedhorizontal, speedhorizontalback }
export function baselineSavings(r){
  var tOut = r.tOut, tBack = r.tBack, minhor = r.minhor, minhorb = r.minhorb;
  var baseIdx = -1;
  for (var i = 0; i < r.heights.length; i++) if (r.flyableOut[i] && r.flyableBack[i]) baseIdx = i;
  var travel120 = baseIdx === -1 ? Infinity : tOut.timeV[baseIdx] + tBack.timeV[baseIdx] + tOut.timeH[baseIdx] + tBack.timeH[baseIdx];
  var travelopt = tOut.timeV[minhor] + tOut.timeH[minhor] + tBack.timeV[minhorb] + tBack.timeH[minhorb];
  var out = { baseIdx: baseIdx, travel120: travel120, travelopt: travelopt, battSave: NaN, timeNoWind: NaN, baseHeight: NaN };
  if (baseIdx !== -1){
    out.baseHeight = r.heights[baseIdx];
    out.battSave = gaugeUsedPct(r.battModel, r.battOut[baseIdx] + r.battBack[baseIdx]) - gaugeUsedPct(r.battModel, r.battOut[minhor] + r.battBack[minhorb]);
    out.timeNoWind = tOut.timeV[baseIdx] + tBack.timeV[baseIdx] + (r.routeDist / r.speedhorizontal) + (r.routeDist / r.speedhorizontalback);
  }
  return out;
}

export function renderBaselineSavings(s){
  var travel120 = s.travel120, travelopt = s.travelopt;
  document.getElementById('savingsText').style.display = isFinite(travel120) ? '' : 'none';
  if (s.baseIdx !== -1){
    document.getElementById('baselineHeight').textContent = fmtLen(s.baseHeight);
    document.getElementById('battSaving').textContent = (isFinite(s.battSave) && s.battSave >= 0.5) ? ' and about ' + s.battSave.toFixed(0) + '% of a battery' : '';
    document.getElementById('timenowind').innerHTML = formatDuration(s.timeNoWind);
  }
  document.getElementById('savesec').innerHTML = formatDuration(travel120 - travelopt, 1);
  document.getElementById('totaltime120').innerHTML = formatDuration(travel120);
  document.getElementById('savepercent').innerHTML = "(" + ((travel120 - travelopt) / travel120 * 100).toFixed(2) + "%)";
}

// When a leg has no flyable height: say which leg(s) and why.
// r: { heights, w, terrainOkOut, terrainOkBack, minhor, minhorb,
//      minSafeAltitude, legalCapM, windResistance }
export function renderNoSafeHeightWarning(r){
  var w = r.w;
  var legs = [];
  if (r.minhor === -1) legs.push('outbound');
  if (r.minhorb === -1) legs.push('return');
  function blocksAll(okList){ return okList.every(function(ok){ return !ok; }); }
  function blocksALeg(okOut, okBack){
    return (legs.indexOf('outbound') > -1 && blocksAll(okOut)) || (legs.indexOf('return') > -1 && blocksAll(okBack));
  }

  var reasonBits = [];
  if (r.minSafeAltitude > r.legalCapM){
    reasonBits.push("buildings along the route need about " + fmtLen(r.minSafeAltitude) + " of clearance, above the " + fmtLen(r.legalCapM) + " height limit");
  }
  if (blocksAll(w.windResOk)){
    reasonBits.push("estimated gusts meet or beat this drone's " + fmtSpeed(r.windResistance) + " wind resistance at every height we can still check");
  }
  if (blocksALeg(w.crosswindOkOut, w.crosswindOkBack)){
    reasonBits.push("the crosswind meets or beats the drone's speed at every height we can still check, so it couldn't hold course");
  }
  if (blocksALeg(w.headwindOkOut, w.headwindOkBack)){
    reasonBits.push("the headwind meets or beats the drone's speed at every height we can still check, so it wouldn't make headway");
  }
  if (blocksALeg(r.terrainOkOut, r.terrainOkBack)){
    reasonBits.push("the terrain changes too steeply to stay between the minimum clearance and " + fmtLen(MAX_AGL_M) + " above ground");
  }
  if (reasonBits.length === 0){
    reasonBits.push("no height between 30 and 120 m clears the buildings, the gusts, and the crosswind on this route");
  }

  document.getElementById('savingsText').style.display = 'none';
  var flyWarning = document.getElementById('flyWarning');
  flyWarning.innerHTML = "We can't recommend a safe height for the " + legs.join(' and ') + " leg: " + reasonBits.join(' and ') + ". Consider a faster drone, a different time, or don't fly.";
  flyWarning.style.display = 'block';
}

// Visibility, rain and temperature for the chosen hour.
export function renderConditions(wx){
  var visibility = wx.visibility, precipitation = wx.precipitation;
  var precipitation_probability = wx.precipitation_probability, temperatureC = wx.temperatureC;
  document.getElementById('visibility').innerHTML = unitsImperial ? (visibility / MILE_M).toFixed(0) + ' mi' : (visibility/1000).toFixed(0) + ' km';
  document.getElementById('precipitation').innerHTML = unitsImperial ? (precipitation / 25.4).toFixed(2) + ' in' : precipitation.toFixed(1) + ' mm';
  document.getElementById('temperature').innerHTML = (typeof temperatureC === 'number') ? (unitsImperial ? (temperatureC * 9 / 5 + 32).toFixed(0) + '°F' : temperatureC.toFixed(0) + '°C') : '—';
  document.getElementById('precipitation_probability').innerHTML = precipitation_probability.toFixed(0);

  var rainWarning = document.getElementById('rainWarning');
  if (precipitation > 0.2 || precipitation_probability >= 50){
    rainWarning.innerHTML = "⚠️ Rain is likely on this route (" + precipitation_probability.toFixed(0) + "% chance, " + precipitation.toFixed(1) + " mm) &mdash; flying in rain can be dangerous: it can short-circuit electronics, reduce visibility and control, and make surfaces slippery on landing. Consider waiting for drier conditions.";
    rainWarning.style.display = 'block';
  } else if (precipitation > 0 || precipitation_probability >= 20){
    rainWarning.innerHTML = "⚠️ There's some chance of rain on this route (" + precipitation_probability.toFixed(0) + "% chance) &mdash; keep an eye on conditions before flying.";
    rainWarning.style.display = 'block';
  } else {
    rainWarning.style.display = 'none';
  }
}

// The two plans - fastest and least battery - built from every
// flyable (height x profile style) candidate for each leg.
// Speeds "Least battery" also tries, as a share of the mission speed:
// flying slower can use less battery per kilometre (above all with a
// tailwind, or holding airspeed), at the cost of time. Never faster:
// every plan stays a waypoint mission (Normal mode), so it can be
// downloaded and flown as it is - Sport mode is by hand only.
export var ECO_SPEED_FACTORS = [0.5, 0.6, 0.7, 0.8, 0.9];

// The legs (as buildPlans takes them) for a route flown at `factor` x
// the set speed. ctx: { heights, wx, dronedegrees, inp, legalOk,
// battModel, temperatureC, payloadOut, payloadBack, timingOptsOut,
// timingOptsBack }. route: { samples, back, reqOut, reqBack, pOut,
// pBack, buildingOk, distance }. Profiles keep their full-speed shape.
export function legsAtSpeed(ctx, route, factor){
  var inp = ctx.inp, h = ctx.heights;
  var hsOut = inp.speedhorizontal * factor, hsBack = inp.speedhorizontalback * factor;
  var w = windByHeight(h, ctx.wx, ctx.dronedegrees, Object.assign({}, inp, { speedhorizontal: hsOut, speedhorizontalback: hsBack }));
  // Each stretch's own wind and heading (route.segOut/segBack, see
  // windfield.js) when there are; else the route's one wind.
  var out = legWind(w, route.segOut, hsOut, inp, 'Out', h), back = legWind(w, route.segBack, hsBack, inp, 'Back', h);
  var tOut = legTimings(h, route.pOut.prof, route.samples, out.gs, inp.speedup, inp.speeddown, ctx.timingOptsOut, route.distance);
  var tBack = legTimings(h, route.pBack.prof, route.back, back.gs, inp.speedupback, inp.speeddownback, ctx.timingOptsBack, route.distance);
  function flyable(ok, L){
    return h.map(function(x, i){ return ctx.legalOk[i] && route.buildingOk[i] && L.gustOk[i] && L.cross[i] && L.head[i] && ok[i]; });
  }
  return {
    w: w,
    out: { prof: route.pOut.prof, flyable: flyable(route.pOut.ok, out), timeV: tOut.timeV, timeH: tOut.timeH,
           batt: legBattery(h, ctx.battModel, ctx.payloadOut, out.air, tOut.timing, inp.speedup, ctx.temperatureC),
           gs: out.gs, air: out.air, cross: out.cross, head: out.head, gustOk: out.gustOk, payload: ctx.payloadOut, hs: hsOut, speedFactor: factor,
           up: inp.speedup, down: inp.speeddown, samples: route.samples, req: route.reqOut,
           climbRun: inp.speedhorizontal / inp.speedup, descRun: inp.speedhorizontal / inp.speeddown, timingOpts: ctx.timingOptsOut },
    back: { prof: route.pBack.prof, flyable: flyable(route.pBack.ok, back), timeV: tBack.timeV, timeH: tBack.timeH,
            batt: legBattery(h, ctx.battModel, ctx.payloadBack, back.air, tBack.timing, inp.speedupback, ctx.temperatureC),
            gs: back.gs, air: back.air, cross: back.cross, head: back.head, gustOk: back.gustOk, payload: ctx.payloadBack, hs: hsBack, speedFactor: factor,
            up: inp.speedupback, down: inp.speeddownback, samples: route.back, req: route.reqBack,
            climbRun: inp.speedhorizontalback / inp.speedupback, descRun: inp.speedhorizontalback / inp.speeddownback, timingOpts: ctx.timingOptsBack }
  };
}

// One leg's ground speeds, airspeeds and wind checks per height: per
// stretch from seg (windfield.js), or the route's one wind from w.
// side: 'Out' or 'Back'.
export function legWind(w, seg, hs, inp, side, heights){
  if (!seg || !seg.len.length){   // no route (a hover): the one wind
    return { gs: w['gs' + side], air: w['air' + side], cross: w['crosswindOk' + side], head: w['headwindOk' + side], gustOk: w.windResOk };
  }
  var sp = legSegmentSpeeds(seg, hs, inp);
  return {
    gs: sp.gs, air: sp.air,
    // A stretch with too much crosswind has no ground speed, so the
    // headway check covers it.
    cross: heights.map(function(){ return true; }),
    head: sp.gs.map(gsFlyable),
    gustOk: heights.map(function(x, i){ return w.windResOk[i] && seg.gustOk[i]; })
  };
}

// Returns the plans plus evalLeg/pairExtras, which the savings line
// reuses for the baseline.
// c: { heights, legs: {out, back}, w, legalOk, buildingOk, terrainAvailable,
//      battModel, temperatureC, mission, dwellS, payloadOut, payloadBack,
//      speedupback, speeddownback }
export function buildPlans(c){
  var heights = c.heights, battModel = c.battModel, temperatureC = c.temperatureC;
  function nearestHeightIdx(m){
    var best = 0;
    for (var j = 0; j < heights.length; j++) if (Math.abs(heights[j] - m) < Math.abs(heights[best] - m)) best = j;
    return best;
  }
  function evalLeg(L, idx, mode){
    if (mode === 'follow'){
      return { i: idx, mode: 'follow', prof: L.prof[idx], time: L.timeV[idx] + L.timeH[idx], batt: L.batt[idx], ok: L.flyable[idx] };
    }
    var prof = buildAltitudeProfile(L.samples, heights[idx], L.req, L.climbRun, L.descRun, 'level');
    // Holding altitude puts the drone higher above lower ground, so
    // wind limits are checked at every height it reaches, and the
    // leg's speed uses the wind at its average height.
    var top = nearestHeightIdx(Math.min(prof.maxAGL, heights[heights.length - 1]));
    if (heights[top] < prof.maxAGL - 0.5 && top < heights.length - 1) top++;
    var windOk = true;
    for (var j = idx; j <= top; j++) if (!((L.gustOk ? L.gustOk[j] : c.w.windResOk[j]) && L.cross[j] && L.head[j])) windOk = false;
    var w = nearestHeightIdx(prof.meanAGL);
    var timing = gsFlyable(L.gs[w]) ? profileTiming(prof, L.samples, L.gs[w], L.up, L.down, L.timingOpts) : null;
    var batt = (battModel && timing) ? batteryPct(battModel, legEnergyFromTiming(battModel, L.payload, L.air[w], timing, L.up), temperatureC) : NaN;
    return { i: idx, mode: 'level', prof: prof, time: timing ? timing.total : Infinity, batt: batt, ok: c.legalOk[idx] && c.buildingOk[idx] && prof.ok && windOk && !!timing };
  }
  // Every flyable (height x style) candidate per leg, scored once.
  function legCandidates(L){
    var list = [];
    for (var j = 0; j < heights.length; j++){
      list.push(evalLeg(L, j, 'follow'));
      if (c.terrainAvailable) list.push(evalLeg(L, j, 'level'));
    }
    return list.filter(function(cand){ return cand.ok && isFinite(cand.time); }).map(function(cand){
      cand.speed = L.hs;
      cand.speedFactor = L.speedFactor || 1;
      return cand;
    });
  }
  function pickBest(list, primary, secondary){
    var best = null;
    list.forEach(function(cand){
      if (!isFinite(cand[primary])) return;
      var tol = primary === 'batt' ? 0.05 : 0.5;
      if (!best || cand[primary] < best[primary] - tol || (Math.abs(cand[primary] - best[primary]) <= tol && cand[secondary] < best[secondary])) best = cand;
    });
    return best;
  }
  var candOut = legCandidates(c.legs.out), candBack = legCandidates(c.legs.back);
  // What a pair of legs adds at the destination: the time spent
  // there (hovering, at the outbound weight), and for photo missions
  // the climb or descent between the two legs' heights.
  function pairExtras(co, cb){
    var t = c.dwellS;
    var wh = battModel ? battModel.hoverW * Math.pow(c.payloadOut, 1.5) * c.dwellS / 3600 : NaN;
    if (c.mission === 'photo'){
      var dz = cb.prof.pts[0].alt - co.prof.pts[co.prof.pts.length - 1].alt;
      var baseBackW = battModel ? battModel.hoverW * Math.pow(c.payloadBack, 1.5) : NaN;
      if (dz > 0){
        var tc = dz / c.speedupback;
        t += tc;
        if (battModel) wh += (baseBackW + battModel.massKg * c.payloadBack * 9.81 * c.speedupback / climbEfficiency(battModel)) * tc / 3600;
      } else if (dz < 0){
        var td = -dz / c.speeddownback;
        t += td;
        if (battModel) wh += baseBackW * DESCENT_POWER_FACTOR * td / 3600;
      }
    }
    return { time: t, batt: battModel ? batteryPct(battModel, wh, temperatureC) : NaN };
  }
  // Both legs are chosen together, since the turnaround depends on
  // the pair.
  function pickPair(primary, secondary, outs, backs){
    outs = outs || candOut;
    backs = backs || candBack;
    var best = null;
    var tol = primary === 'batt' ? 0.05 : 0.5;
    outs.forEach(function(co){
      backs.forEach(function(cb){
        var x = pairExtras(co, cb);
        var tot = { time: co.time + cb.time + x.time, batt: co.batt + cb.batt + x.batt };
        if (!isFinite(tot[primary])) return;
        if (!best || tot[primary] < best[primary] - tol || (Math.abs(tot[primary] - best[primary]) <= tol && tot[secondary] < best[secondary])){
          // batt: % of the battery's energy (adds up across legs);
          // totalBatt: the gauge % a full battery drops by.
          best = { out: co, back: cb, time: tot.time, batt: tot.batt, totalTime: tot.time,
                   totalBatt: battModel ? gaugeUsedPct(battModel, tot.batt) : tot.batt };
        }
      });
    });
    // One leg unflyable: still show the other one.
    return best || { out: pickBest(outs, primary, secondary), back: pickBest(backs, primary, secondary), totalTime: NaN, totalBatt: NaN };
  }
  // The same legs at slower speeds (c.speedLegs), each leg on its
  // own: they only ever save battery, so only least battery takes them.
  var ecoOut = candOut, ecoBack = candBack;
  (c.speedLegs || []).forEach(function(v){
    ecoOut = ecoOut.concat(legCandidates(v.out));
    ecoBack = ecoBack.concat(legCandidates(v.back));
  });
  var plans = { fast: pickPair('time', 'batt'), eco: null };
  if (battModel) plans.eco = pickPair('batt', 'time', ecoOut, ecoBack);
  return { plans: plans, evalLeg: evalLeg, pairExtras: pairExtras, battModel: battModel };
}

// Savings line: fastest plan vs simply flying at the highest allowed,
// flyable height (terrain following), including the time and battery
// spent at the destination: { travelBase, fastTotal, battSaveFast }, or
// null when there's nothing to compare.
export function planSavings(planner, legs, baseline, battOut, battBack){
  var plans = planner.plans, baseIdx = baseline.baseIdx;
  if (!(plans.fast.out && plans.fast.back && baseIdx !== -1 && isFinite(baseline.travel120))) return null;
  var baseX = planner.pairExtras(planner.evalLeg(legs.out, baseIdx, 'follow'), planner.evalLeg(legs.back, baseIdx, 'follow'));
  return { travelBase: baseline.travel120 + baseX.time, fastTotal: plans.fast.totalTime,
           battSaveFast: gaugeUsedPct(planner.battModel, battOut[baseIdx] + battBack[baseIdx] + baseX.batt) - plans.fast.totalBatt };
}

export function renderPlanSavings(s){
  if (!s) return;
  var travelBase = s.travelBase, fastTotal = s.fastTotal, battSaveFast = s.battSaveFast;
  document.getElementById('savesec').innerHTML = formatDuration(travelBase - fastTotal, 1);
  document.getElementById('totaltime120').innerHTML = formatDuration(travelBase);
  document.getElementById('savepercent').innerHTML = "(" + ((travelBase - fastTotal) / travelBase * 100).toFixed(1) + "%)";
  document.getElementById('battSaving').textContent = (isFinite(battSaveFast) && battSaveFast >= 0.5) ? ' and about ' + battSaveFast.toFixed(0) + '% of a battery' : '';
  document.getElementById('savingsText').style.display = (travelBase - fastTotal) > 0.5 ? '' : 'none';
}

// A whole plan along a given path, e.g. the route over fewer people:
// terrain and buildings looked up along it, then the same heights,
// battery and speed choices as the main route (planCtx from
// calcHeight). Buildings on it are climbed over, not detoured. Returns
// { plans, tooTall (the buildings on it too tall to climb over), route: {
// terrainSamples, terrainBack, terrainAvailable, path, distance } }.
// Times the route over fewer people is looked for again, round the
// buildings too tall to fly over that the last one met.
export var LOWPOP_TALL_BUILDING_ROUNDS = 3;

export async function planAlongPath(planCtx, path){
  var c = planCtx, inp = c.inp;
  var distance = 0;
  for (var k = 1; k < path.length; k++) distance += getDistanceFromLatLon(path[k - 1].lat, path[k - 1].lng, path[k].lat, path[k].lng);
  var results = await Promise.all([
    getTerrainProfile(path).catch(function(err){ console.warn('Terrain lookup failed:', err); return null; }),
    getBuildingsNearPath(path, c.straightDistM).catch(function(err){ console.warn('Building lookup failed:', err); return null; })
  ]);
  // The height limit may have been changed by another calculation
  // while this one waited (a server runs several at once).
  if (c.legalCapM !== undefined) setMaxAglM(c.legalCapM);
  var samples = results[0];
  var terrainAvailable = samples !== null;
  if (!terrainAvailable) samples = flatTerrainProfile(path);
  var list = results[1] ? results[1].buildings.list : [];
  var sorted = sortRouteBuildings(list, path, c.effectiveCeilingM);
  var under = buildingsCrossingPath(list, path, BUILDING_LATERAL_SAFETY_MARGIN_M - 1);
  var reqOut = buildingAltitudeRequirements(samples, under);
  var back = reverseSamples(samples), reqBack = reqOut.slice().reverse();
  var minSafe = sorted.maxClimbedHeight > 0 ? sorted.maxClimbedHeight + BUILDING_HEIGHT_SAFETY_MARGIN_M : 30;
  var route = {
    samples: samples, back: back, reqOut: reqOut, reqBack: reqBack, distance: distance,
    pOut: legProfiles(c.heights, samples, reqOut, inp.speedhorizontal, inp.speedup, inp.speeddown),
    pBack: legProfiles(c.heights, back, reqBack, inp.speedhorizontalback, inp.speedupback, inp.speeddownback),
    buildingOk: c.heights.map(function(h){ return h >= minSafe; })
  };
  if (c.windField){
    route.segOut = routeSegments(samples, c.heights, c.windField, inp.windResistance);
    route.segBack = routeSegments(back, c.heights, c.windField, inp.windResistance);
  }
  var full = legsAtSpeed(c, route, 1);
  var planner = buildPlans({
    heights: c.heights, legs: { out: full.out, back: full.back },
    speedLegs: ECO_SPEED_FACTORS.map(function(f){ return legsAtSpeed(c, route, f); }),
    w: full.w, legalOk: c.legalOk, buildingOk: route.buildingOk, terrainAvailable: terrainAvailable,
    battModel: c.battModel, temperatureC: c.temperatureC, mission: c.mission, dwellS: inp.dwellS,
    payloadOut: c.payloadOut, payloadBack: c.payloadBack, speedupback: inp.speedupback, speeddownback: inp.speeddownback
  });
  return { plans: planner.plans, tooTall: sorted.tooTall,
           route: { terrainSamples: samples, terrainBack: back, terrainAvailable: terrainAvailable, path: path, distance: distance } };
}

// Each calculation gets a number; one that's been replaced (Calculate
// pressed again, or Start over) stops at its next pause and draws
// nothing.
var calcGeneration = 0;

export async function calcHeight(gen) {
    if (gen === undefined) gen = ++calcGeneration;
    function stale(){ return gen !== calcGeneration; }

    if (marker==0){
       showNotice('calcNotice', 'Choose a start point first: click the map or search for a place.');
       track('calculate', { result: 'no_start' });
       return false;
    }

    // With only a start point, plan a hover there.
    var startlat=lat1, startlng=lng1;
    var destlat = marker==1 ? lat1 : lat2, destlng = marker==1 ? lng1 : lng2;
    var lookupEst = estimateLookupSeconds(startlat, startlng, destlat, destlng, (trueBearing(startlat, startlng, destlat, destlng) + 180) % 360);
    Progress.start([
      { key: 'hazards', label: 'Checking restricted areas (schools, airports…)', est: lookupEst.hazards },
      { key: 'buildings', label: 'Checking buildings and terrain along the route', est: lookupEst.buildings },
      // Terrain along the final route, then the three plans at every height and speed.
      { key: 'compute', label: 'Calculating optimal heights', est: 2 }
    ]);
    Progress.stage('hazards');

    const mission = currentMission();
    const inp = readFlightInputs(mission);
    const altPermit = altitudePermitChecked();
    const req = {
      start: { lat: startlat, lng: startlng }, dest: { lat: destlat, lng: destlng }, points: marker,
      mission: mission, inp: inp, battery: readBatteryFields(), altPermit: altPermit, urbanWind: urbanWindChecked(),
      skippedSites: skippedSiteTypes(), forecastOffsetH: forecastOffsetH
    };
    // The people under the route arrive after the result (onPeople);
    // until the result is drawn they wait here.
    let resolveCalcDone;
    const calcDone = new Promise(function(resolve){ resolveCalcDone = resolve; });
    const hooks = {
      stage: function(key){ if (!stale()) Progress.stage(key); },
      retrying: function(msg){ if (!stale()) Progress.retrying(msg); },
      stale: stale,
      onPeople: function(u){ calcDone.then(function(done){ if (done) done.onPeople(u); }); },
      done: function(r){ if (r) track('people_under_route', { people: Math.round(r.people) }); }
    };
    // On the engine server, or (with no ENGINE_URL: tests, local work)
    // here, through JSON all the same, so nothing the page draws depends
    // on objects that can't travel.
    const R = ENGINE_URL ? await remoteComputePlan(req, hooks)
      : decodeResult(encodeResult(await (await import('./engine.js')).computePlan(req, hooks)));
    if (stale() || R.stale){ resolveCalcDone(null); return 'stale'; }
    if (R.error === 'engine' || R.error === 'busy'){
      resolveCalcDone(null);
      showNotice('calcNotice', R.error === 'busy'
        ? 'Too many calculations from your connection in the last few minutes. Please wait a little and try again.'
        : 'Couldn’t reach Flytimizer’s calculation server. It may be starting up - trying again in a minute usually works.',
        { action: { label: 'Try again', name: 'calculate' } });
      Progress.finish(false);
      track('calculate', { result: R.error === 'busy' ? 'engine_busy' : 'engine_error' });
      return false;
    }
    if (R.error === 'forecast'){
      resolveCalcDone(null);
      showNotice('calcNotice', "Couldn't load the wind forecast from Open-Meteo, so no heights can be worked out right now. The weather service may be busy - trying again in a minute usually works.",
        { action: { label: 'Try again', name: 'calculate' } });
      Progress.finish(false);
      track('calculate', { result: 'forecast_error' });
      return false;
    }
    resolveCalcDone({ onPeople: renderResult(R, { altPermit: altPermit, points: marker, start: req.start, inp: inp, mission: mission, stale: stale }) });

    updateUrlForRoute();
    // Only learn timings from fully successful lookups.
    Progress.finish(R.lookupsOk);
}

// Draws the engine's result (engine.js). Returns the handler for the
// people updates that come after it.
// ctx: { altPermit, points, start, inp, mission, stale }
function renderResult(R, ctx){
    const heights = R.heights, w = R.w, rules = R.rules;
    setMaxAglM(R.legalCapM);
    chooseUnits(rules);
    renderHazardsAndRoute(R.hazards, R.buildingList, R.path, R.ignoredHazards);
    const peopleView = ctx.points === 2 ? renderPeopleView(R.routeDist) : null;
    if (!peopleView){
      const el = document.getElementById('peopleInfo');
      if (el) el.style.display = 'none';
    }
    renderNoFlyWarning(R.hazards, rules, R.path);
    renderGroundWind(R.groundWind.start, R.groundWind.dest, ctx.inp.windResistance);

    // Over the drone's max takeoff weight: say so up front.
    const weight = payloadCheck(payloadFactors(ctx.mission));
    const weightWarning = document.getElementById('weightWarning');
    weightWarning.hidden = !(weight && weight.level === 'over');
    weightWarning.textContent = weight && weight.level === 'over' ? '⚠️ ' + weight.text : '';

    renderBatteryNote(R.battery, R.temperatureC);
    renderRouteSummary(R.routeDist, R.straightDistM, R.avoidance, R.outboundHeading);
    renderHeightTable({
      heights: heights, w: w, legalOk: R.legalOk, buildingOk: R.buildingOk,
      terrainOkOut: R.terrainOkOut, terrainOkBack: R.terrainOkBack, flyableOut: R.flyableOut, flyableBack: R.flyableBack,
      tOut: R.tOut, tBack: R.tBack, battPair: R.battPair,
      minSafeAltitude: R.minSafeAltitude, windResistance: ctx.inp.windResistance, rules: rules
    });
    renderRulesInfo(rules, R.legalCapM, ctx.altPermit);
    const terrainBaseText = renderTerrainInfo(R.terrainAvailable, R.terrainSamples);
    renderUrbanWindInfo(R.urban, urbanWindChecked());
    renderBuildingInfo({
      buildings: R.buildings, sorted: R.sortedBuildings, minSafeAltitude: R.minSafeAltitude,
      effectiveCeilingM: R.effectiveCeilingM, legalCapM: R.legalCapM,
      leftCheckedArea: R.buildingCheck.leftCheckedArea, deviationM: R.buildingCheck.deviationM, halfWidthUsed: R.buildingCheck.halfWidthUsed
    });
    renderHazardInfo({
      hazardData: R.hazardFound ? {} : null, hazards: R.hazards, ignored: R.ignoredHazards, avoidance: R.avoidance,
      leftCheckedArea: R.hazardCheck.leftCheckedArea, deviationM: R.hazardCheck.deviationM, halfWidthUsed: R.hazardCheck.halfWidthUsed
    });

    if (R.baseline){
        document.getElementById('flyWarning').style.display = 'none';
        renderBaselineSavings(R.baseline);
    } else {
        renderNoSafeHeightWarning({
          heights: heights, w: w, terrainOkOut: R.terrainOkOut, terrainOkBack: R.terrainOkBack, minhor: R.minhor, minhorb: R.minhorb,
          minSafeAltitude: R.minSafeAltitude, legalCapM: R.legalCapM, windResistance: ctx.inp.windResistance
        });
    }
    renderConditions(R.wx);
    renderCompassRose(R.outboundHeading, [
        {h: 20, wd: w.wd[0]},
        {h: 80, wd: w.wd[5]},
        {h: 120, wd: w.wd[9]}
    ]);

    const plans = R.plans;
    renderRange(ctx.start.lat, ctx.start.lng, R.ranges, ctx.points == 1);
    // A hold-altitude profile can rescue a leg that terrain following
    // couldn't fly; don't leave the "can't recommend" warning up then.
    if (plans.fast.out && plans.fast.back) document.getElementById('flyWarning').style.display = 'none';
    track('calculate', {
      result: plans.fast.out && plans.fast.back ? 'ok' : (plans.fast.out || plans.fast.back) ? 'one_leg' : 'no_safe_height',
      drone: document.getElementById('droneModel').value,
      mission: ctx.mission,
      speed_mode: ctx.inp.speedMode,
      country: rules.detected.code || 'unknown',
      points: ctx.points,
      distance_km: Math.round(R.routeDist / 100) / 10,
      range_km: Math.round(R.rangeFarM / 100) / 10
    });
    renderPlanSavings(R.planSavings);

    const calcObj = {
      plans: plans,
      heights: heights,
      terrainSamples: R.terrainSamples,
      terrainAvailable: R.terrainAvailable,
      terrainBaseText: R.terrainAvailable ? terrainBaseText : '',
      path: R.path,
      terrainBack: R.terrainBack,
      mission: R.mission,
      speedOut: R.speedOut,
      speedBack: R.speedBack,
      distance: R.routeDist,
      droneModel: document.getElementById('droneModel').value,
      // The Fewer people tab is always there for a route: until (or
      // unless) it has a plan of its own, this says why.
      peopleStatus: ctx.points === 2 ? { state: 'searching', note: 'Looking for a route over fewer people…' } : null
    };
    setCurrentCalc(calcObj);
    renderPlan();
    renderForecastStrip(R.forecast.json, R.forecast.nowHourIdx);

    return function onPeople(u){
      if (ctx.stale() || currentCalc !== calcObj) return;
      if (u.type === 'plan'){
        if (calcObj.plans.people) return;
        calcObj.plans.people = u.plan;
        calcObj.altPath = u.altPath;
        renderPlanTabs();
        return;
      }
      if (u.type === 'status'){
        if (calcObj.plans.people) return;
        calcObj.peopleStatus = u;
        renderPlanTabs();
        if (selectedPlan === 'people') renderPlan();
        return;
      }
      if (peopleView) peopleView(u);
    };
}

// The Calculate button (and the "Try again" links): runs calcHeight(),
// then scrolls to the result. The button stays usable meanwhile:
// pressing it again (say after changing the payload) drops the running
// calculation and starts afresh.
var CALC_LABEL_BUSY = 'Calculating\u2026 (tap to restart)';
function calcButtonIdle(){
  var btn = document.getElementById('calcBtn');
  if (!btn) return;
  btn.textContent = btn.dataset.label || btn.textContent;
  btn.classList.remove('busy');
}

export function cancelCalculation(){
  calcGeneration++;
  Progress.finish(false);
  calcButtonIdle();
}

export async function getHeight() {
  var btn = document.getElementById('calcBtn');
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  var gen = ++calcGeneration;
  btn.textContent = CALC_LABEL_BUSY;
  btn.classList.add('busy');
  hideNotice('calcNotice');

  try {
    var res = await calcHeight(gen);
    if (gen !== calcGeneration || res === false || res === 'stale') return;
    var x = document.getElementById("result");
    x.style.display = "block";
    x.scrollIntoView({behavior: "smooth", block: "start"});
  } catch (err) {
    if (gen !== calcGeneration) return;
    console.error(err);
    track('calculate', { result: 'error' });
    showNotice('calcNotice', 'Something went wrong while calculating - please try again.');
  } finally {
    if (gen === calcGeneration){
      Progress.finish(false); // no-op if it already finished
      calcButtonIdle();
    }
  }
}
