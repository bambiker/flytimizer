// calcHeight(): the main calculation that ties everything together,
// plus the steps it's broken into - reading the forecast and the
// drone settings, per-height wind checks, buildings on the route,
// per-leg profiles/timings/battery, the result panels, and the two
// plans.

import { track } from './analytics.js';
import { CLIMB_EFFICIENCY, DESCENT_POWER_FACTOR, batteryPct, coldCapacityFactor, fmtPct, legEnergyFromTiming, profileTiming, readBatteryModel } from './battery.js';
import { MIN_GROUND_SPEED_MS, airspeedFor, formatDuration, getDistanceFromLatLon, groundSpeed, hourIndexNow, interpDir, lat1, lat2, lng1, lng2, marker, trueBearing } from './core.js';
import { markUnsafe } from './drone.js';
import { renderHazardsAndRoute } from './map-view.js';
import { currentMission } from './mission.js';
import { hideNotice, showNotice } from './notice.js';
import { BUILDING_AVOID_MAX_COUNT, BUILDING_CORRIDOR_HALF_WIDTH_M, BUILDING_HEIGHT_SAFETY_MARGIN_M, BUILDING_LATERAL_SAFETY_MARGIN_M, HAZARD_CORRIDOR_HALF_WIDTH_M, HAZARD_TYPE_LABEL, MAX_FLIGHT_ALTITUDE_M, getBuildingsNearPath, getHazardsNearRoute } from './osm.js';
import { renderPlan, setCurrentCalc } from './plans.js';
import { Progress, estimateLookupSeconds } from './progress.js';
import { buildingsCrossingPath, computeAvoidanceRoute, maxLateralDeviationM, maxPathDeviationM, minDistanceFromPath } from './routing.js';
import { MILE_M, altitudePermitChecked, formatDistance, renderRulesInfo, rulesForLocation } from './rules.js';
import { updateUrlForRoute } from './share.js';
import { MAX_AGL_M, buildAltitudeProfile, buildingAltitudeRequirements, flatTerrainProfile, getTerrainProfile, renderTerrainProfile, reverseSamples, setMaxAglM } from './terrain.js';
import { chooseUnits, escapeHtml, fmtDist, fmtLen, fmtSpeed, unitsImperial } from './units.js';
import { renderCompassRose } from './visuals.js';
import { forecastOffsetH, getJSON, renderForecastStrip } from './weather.js';

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
// the payload coefficient for each leg.
export function readFlightInputs(mission){
  function val(id){ return document.getElementById(id).value; }
  // Photo missions carry the same load both ways.
  var payloadBackCoef = mission === 'photo' ? val('payload') : val('payloadback');
  return {
    dwellS: Math.max(0, parseFloat(val('dwell')) || 0),
    payloadBackCoef: payloadBackCoef,
    speedup: val('asc') / val('payload'),
    speeddown: val('des') / val('payload'),
    speedhorizontal: val('hor') / val('payload'),
    speedupback: val('asc') / payloadBackCoef,
    speeddownback: val('des') / payloadBackCoef,
    speedhorizontalback: val('hor') / payloadBackCoef,
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
  var w = { ws: [], wd: [], estgust: [], crosswind: [], windResOk: [], crosswindOkOut: [], crosswindOkBack: [],
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
    // Gust extrapolated from the 10m gust/average ratio, and the
    // crosswind component (perpendicular to heading) of the average
    // wind - used as separate flyability checks.
    w.estgust[i] = w.ws[i] * wx.gustFactor;
    w.crosswind[i] = w.ws[i] * Math.abs(Math.sin(diffangle));
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
export function legTimings(heights, prof, samples, gs, up, down, opts, routeDist){
  var t = { timing: [], timeH: [], timeV: [] };
  for (var i = 0; i < heights.length; i++){
    t.timing[i] = gs[i] > MIN_GROUND_SPEED_MS ? profileTiming(prof[i], samples, gs[i], up, down, opts) : null;
    t.timeH[i] = t.timing[i] ? routeDist / gs[i] : Infinity;
    t.timeV[i] = t.timing[i] ? t.timing[i].total - t.timeH[i] : 0;
  }
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
  battNote.innerHTML = 'Battery figures are estimates from the drone’s rated flight time, payload, climbs and wind (roughly ±20%)' +
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
//      flyableOut, flyableBack, tOut, tBack, battOut, battBack,
//      minSafeAltitude, windResistance, rules }
export function renderHeightTable(r){
  var w = r.w;
  var cols = [[0, '30'], [5, '80'], [9, '120']];
  cols.forEach(function(c){
    var i = c[0], s = c[1];
    document.getElementById('ws' + s).innerHTML = fmtSpeed(w.ws[i]);
    document.getElementById('alt' + s).innerHTML = fmtLen(r.heights[i]);
    document.getElementById('batt' + s).innerHTML = fmtPct(r.battOut[i] + r.battBack[i]);
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
      tooTallNote.innerHTML = ' ' + tooTallOnRoute.length + ' building' + (tooTallOnRoute.length===1?' is':'s are') + ' taller than' + ceilingNote + ' (up to about ' + fmtLen(tallestTooTall) + ') — climbing over ' + (tooTallOnRoute.length===1?'it':'them') + " isn't possible within that limit, so the route is detoured sideways around " + (tooTallOnRoute.length===1?'it':'them') + ' instead, with a ' + fmtLen(BUILDING_LATERAL_SAFETY_MARGIN_M) + ' clearance.';
      buildingInfo.appendChild(tooTallNote);
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

// r: { hazardData, hazards, avoidance, leftCheckedArea, deviationM, halfWidthUsed }
export function renderHazardInfo(r){
  var hazards = r.hazards, avoidance = r.avoidance;
  var hazardInfo = document.getElementById('hazardInfo');
  hazardInfo.classList.remove('warning-hint');
  if (r.hazardData === null){
    hazardInfo.innerHTML = "Couldn't load restricted-area data from OpenStreetMap, so schools, hospitals, power infrastructure, airports and other restricted sites along this route aren't being checked right now. The map servers may be busy - trying again in a minute usually works. <button class=\"btn btn-ghost btn-inline\" data-action=\"calculate\">Try again</button>";
    hazardInfo.classList.add('warning-hint');
  } else if (hazards.length === 0){
    hazardInfo.innerHTML = "No schools, hospitals, power infrastructure, airports or other restricted sites found near this route in OpenStreetMap.";
  } else {
    var detourText = avoidance.hazardsAvoided > 0
      ? "The route on the map now detours around " + avoidance.hazardsAvoided + " of them."
      : "The straight-line route already clears all of them.";
    hazardInfo.innerHTML = "Found " + hazards.length + " restricted area" + (hazards.length===1?'':'s') + " (schools, hospitals, power infrastructure, airports and more) near this route, marked in red on the map. " + detourText;

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
      trappedWarning.innerHTML = ' Your ' + trappedNames.join(', and your ') + ' is within its normal clearance distance — taking off or landing there is fine, but the route can only steer clear of it once it\'s away from that point.';
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

// When both legs have a flyable height: the savings line against the
// baseline (the highest height that's legal and flyable on both legs -
// the "just go high" choice most pilots would make). Returns that
// baseline's index and round-trip time for the plans' savings line.
// r: { heights, flyableOut, flyableBack, tOut, tBack, battOut, battBack,
//      minhor, minhorb, routeDist, speedhorizontal, speedhorizontalback }
export function renderBaselineSavings(r){
  var tOut = r.tOut, tBack = r.tBack, minhor = r.minhor, minhorb = r.minhorb;
  var baseIdx = -1;
  for (var i = 0; i < r.heights.length; i++) if (r.flyableOut[i] && r.flyableBack[i]) baseIdx = i;
  var travel120 = baseIdx === -1 ? Infinity : tOut.timeV[baseIdx] + tBack.timeV[baseIdx] + tOut.timeH[baseIdx] + tBack.timeH[baseIdx];
  var travelopt = tOut.timeV[minhor] + tOut.timeH[minhor] + tBack.timeV[minhorb] + tBack.timeH[minhorb];
  document.getElementById('savingsText').style.display = isFinite(travel120) ? '' : 'none';
  if (baseIdx !== -1){
    document.getElementById('baselineHeight').textContent = fmtLen(r.heights[baseIdx]);
    var battSave = (r.battOut[baseIdx] + r.battBack[baseIdx]) - (r.battOut[minhor] + r.battBack[minhorb]);
    document.getElementById('battSaving').textContent = (isFinite(battSave) && battSave >= 0.5) ? ' and about ' + battSave.toFixed(0) + '% of a battery' : '';
    document.getElementById('timenowind').innerHTML = formatDuration(tOut.timeV[baseIdx] + tBack.timeV[baseIdx] + (r.routeDist / r.speedhorizontal) + (r.routeDist / r.speedhorizontalback));
  }
  document.getElementById('savesec').innerHTML = formatDuration(travel120 - travelopt, 1);
  document.getElementById('totaltime120').innerHTML = formatDuration(travel120);
  document.getElementById('savepercent').innerHTML = "(" + ((travel120 - travelopt) / travel120 * 100).toFixed(2) + "%)";
  return { baseIdx: baseIdx, travel120: travel120 };
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
    for (var j = idx; j <= top; j++) if (!(c.w.windResOk[j] && L.cross[j] && L.head[j])) windOk = false;
    var w = nearestHeightIdx(prof.meanAGL);
    var timing = L.gs[w] > MIN_GROUND_SPEED_MS ? profileTiming(prof, L.samples, L.gs[w], L.up, L.down, L.timingOpts) : null;
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
    return list.filter(function(cand){ return cand.ok && isFinite(cand.time); });
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
        if (battModel) wh += (baseBackW + battModel.massKg * c.payloadBack * 9.81 * c.speedupback / CLIMB_EFFICIENCY) * tc / 3600;
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
  function pickPair(primary, secondary){
    var best = null;
    var tol = primary === 'batt' ? 0.05 : 0.5;
    candOut.forEach(function(co){
      candBack.forEach(function(cb){
        var x = pairExtras(co, cb);
        var tot = { time: co.time + cb.time + x.time, batt: co.batt + cb.batt + x.batt };
        if (!isFinite(tot[primary])) return;
        if (!best || tot[primary] < best[primary] - tol || (Math.abs(tot[primary] - best[primary]) <= tol && tot[secondary] < best[secondary])){
          best = { out: co, back: cb, time: tot.time, batt: tot.batt, totalTime: tot.time, totalBatt: tot.batt };
        }
      });
    });
    // One leg unflyable: still show the other one.
    return best || { out: pickBest(candOut, primary, secondary), back: pickBest(candBack, primary, secondary), totalTime: NaN, totalBatt: NaN };
  }
  var plans = { fast: pickPair('time', 'batt'), eco: null };
  if (battModel){
    plans.eco = pickPair('batt', 'time');
  }
  return { plans: plans, evalLeg: evalLeg, pairExtras: pairExtras };
}

// Savings line: fastest plan vs simply flying at the highest allowed,
// flyable height (terrain following), including the time and battery
// spent at the destination.
export function renderPlanSavings(planner, legs, baseline, battOut, battBack){
  var plans = planner.plans, baseIdx = baseline.baseIdx;
  if (!(plans.fast.out && plans.fast.back && baseIdx !== -1 && isFinite(baseline.travel120))) return;
  var baseX = planner.pairExtras(planner.evalLeg(legs.out, baseIdx, 'follow'), planner.evalLeg(legs.back, baseIdx, 'follow'));
  var travelBase = baseline.travel120 + baseX.time;
  var fastTotal = plans.fast.totalTime;
  document.getElementById('savesec').innerHTML = formatDuration(travelBase - fastTotal, 1);
  document.getElementById('totaltime120').innerHTML = formatDuration(travelBase);
  document.getElementById('savepercent').innerHTML = "(" + ((travelBase - fastTotal) / travelBase * 100).toFixed(1) + "%)";
  var battSaveFast = (battOut[baseIdx] + battBack[baseIdx] + baseX.batt) - plans.fast.totalBatt;
  document.getElementById('battSaving').textContent = (isFinite(battSaveFast) && battSaveFast >= 0.5) ? ' and about ' + battSaveFast.toFixed(0) + '% of a battery' : '';
  document.getElementById('savingsText').style.display = (travelBase - fastTotal) > 0.5 ? '' : 'none';
}

export async function calcHeight() {

    if (marker==0){
       showNotice('calcNotice', 'Choose a start point first: click the map or search for a place.');
       track('calculate', { result: 'no_start' });
       return false;
    }

    // With only a start point, plan a hover there.
    var startlat=lat1, startlng=lng1;
    var destlat = marker==1 ? lat1 : lat2, destlng = marker==1 ? lng1 : lng2;
    // dronedegrees is the REVERSE bearing (destination -> start); the
    // wind formulas rely on that convention.
    var dronedegrees = (trueBearing(startlat, startlng, destlat, destlng) + 180) % 360;
    // For anything shown to the person, "heading" should mean the
    // outbound direction of travel, which is the opposite bearing.
    var outboundHeading = (dronedegrees + 180) % 360;

    var lookupEst = estimateLookupSeconds(startlat, startlng, destlat, destlng, dronedegrees);
    Progress.start([
      { key: 'hazards', label: 'Checking restricted areas (schools, airports…)', est: lookupEst.hazards },
      { key: 'buildings', label: 'Checking buildings and terrain along the route', est: lookupEst.buildings },
      { key: 'compute', label: 'Calculating optimal heights', est: 0.5 }
    ]);
    Progress.stage('hazards');

    // Wind and hazards can be looked up together - hazards only need
    // the straight start->destination line. Buildings come later,
    // once we know the hazard-avoidance path, so a route that swings
    // wide around a cluster of hazards still gets building data along
    // that swing (see getBuildingsNearPath below).
    // Settled straight away, so a failed forecast is reported below
    // rather than as an unhandled rejection while the other lookups run.
    const windPromise = getJSON().then(function(json){ return { json: json }; }, function(err){ return { error: err }; });
    // Country rules for the start point - looked up alongside the
    // hazards (never fails: falls back to approximate boxes, then to
    // Israel's rules).
    const rulesPromise = rulesForLocation(startlat, startlng);
    const hazardsPromise = getHazardsNearRoute(startlat, startlng, destlat, destlng, dronedegrees, rulesPromise)
        .catch(function(err){ console.warn('Hazard lookup failed:', err); return null; });

    const hazardData = await hazardsPromise;
    const rules = await rulesPromise;
    const altPermit = altitudePermitChecked();
    // Legal height limit above ground for this route (the app never
    // checks above MAX_FLIGHT_ALTITUDE_M, even with a permit).
    const legalCapM = altPermit ? MAX_FLIGHT_ALTITUDE_M : Math.min(MAX_FLIGHT_ALTITUDE_M, rules.profile.maxAglM);
    setMaxAglM(legalCapM);
    chooseUnits(rules);
    const hazards = hazardData ? hazardData.hazards : [];
    const hazardHalfWidthUsed = hazardData ? hazardData.hazardHalfWidthUsed : HAZARD_CORRIDOR_HALF_WIDTH_M;

    const hazardObstacles = hazards.map(function(h){
      return { lat: h.lat, lng: h.lng, clearance: h.clearance, kind: 'hazard', type: h.type, name: h.name };
    });
    // First pass: route around hazards only. This is also the final
    // route if no buildings end up needing a detour of their own.
    var avoidance = computeAvoidanceRoute(startlat, startlng, destlat, destlng, hazardObstacles);

    const straightDistM = getDistanceFromLatLon(startlat, startlng, destlat, destlng);
    Progress.stage('buildings');
    const buildingPromise = getBuildingsNearPath(avoidance.path, straightDistM)
        .catch(function(err){ console.warn('Building lookup failed:', err); return null; });
    // Terrain along the hazard-avoiding path, fetched alongside the
    // buildings. Reused as-is unless buildings force a further detour.
    const firstTerrainPromise = getTerrainProfile(avoidance.path)
        .catch(function(err){ console.warn('Terrain lookup failed:', err); return null; });

    const wind = await windPromise;
    if (wind.error){
      console.warn('Forecast lookup failed:', wind.error);
      showNotice('calcNotice', "Couldn't load the wind forecast from Open-Meteo, so no heights can be worked out right now. The weather service may be busy - trying again in a minute usually works.",
        { action: { label: 'Try again', name: 'calculate' } });
      Progress.finish(false);
      track('calculate', { result: 'forecast_error' });
      return false;
    }
    const json = wind.json;
    const buildingData = await buildingPromise;
    const buildings = buildingData ? buildingData.buildings : null;
    const buildingList = buildings ? buildings.list : [];
    const buildingHalfWidthUsed = buildingData ? buildingData.buildingHalfWidthUsed : BUILDING_CORRIDOR_HALF_WIDTH_M;
    Progress.stage('compute');

    const nowHourIdx = hourIndexNow(json.hourly.time);
    const hour = Math.min(nowHourIdx + forecastOffsetH, json.hourly.time.length - 1);
    const wx = forecastAt(json, hour);
    const temperatureC = wx.temperatureC;

    const mission = currentMission();
    const inp = readFlightInputs(mission);
    const speedup = inp.speedup, speeddown = inp.speeddown, speedhorizontal = inp.speedhorizontal;
    const speedupback = inp.speedupback, speeddownback = inp.speeddownback, speedhorizontalback = inp.speedhorizontalback;

    const heights = CANDIDATE_HEIGHTS_M.slice();
    const w = windByHeight(heights, wx, dronedegrees, inp);
    const legalOk = heights.map(function(h){ return h <= legalCapM + 0.01; });
    const effectiveCeilingM = flyableCeilingM(heights, legalOk, w);

    const sortedBuildings = sortRouteBuildings(buildingList, avoidance.path, effectiveCeilingM);

    // Second pass: only re-run the avoidance routing if a building
    // actually needs to be routed around - otherwise the hazard-only
    // route from above is already final, and re-running it would
    // just recompute the same path.
    const hazardOnlyPath = avoidance.path;
    if (sortedBuildings.toAvoid.length > 0){
      const combinedObstacles = hazardObstacles.concat(sortedBuildings.toAvoid.map(function(b){
        return { lat: b.lat, lng: b.lng, clearance: b.radius + BUILDING_LATERAL_SAFETY_MARGIN_M, kind: 'building', type: 'building', name: null, height: b.height };
      }));
      avoidance = computeAvoidanceRoute(startlat, startlng, destlat, destlng, combinedObstacles);
    }
    const routeDist = avoidance.distance;
    renderHazardsAndRoute(hazards, buildingList, avoidance.path);

    var terrainSamples = await firstTerrainPromise;
    if (avoidance.path !== hazardOnlyPath){
        terrainSamples = await getTerrainProfile(avoidance.path)
            .catch(function(err){ console.warn('Terrain lookup failed:', err); return null; });
    }
    const terrainAvailable = terrainSamples !== null;
    if (!terrainAvailable) terrainSamples = flatTerrainProfile(avoidance.path);

    // Buildings still on the final route are the ones we climb over
    // (detoured ones sit just outside their clearance circle, hence
    // the 1 m slack).
    const buildingsUnderRoute = buildingsCrossingPath(buildingList, avoidance.path, BUILDING_LATERAL_SAFETY_MARGIN_M - 1);
    const reqOut = buildingAltitudeRequirements(terrainSamples, buildingsUnderRoute);
    const terrainBack = reverseSamples(terrainSamples);
    const reqBack = reqOut.slice().reverse();
    const pOut = legProfiles(heights, terrainSamples, reqOut, speedhorizontal, speedup, speeddown);
    const pBack = legProfiles(heights, terrainBack, reqBack, speedhorizontalback, speedupback, speeddownback);

    renderNoFlyWarning(hazards, rules, avoidance.path);

    // The corridor width actually queried grows with route distance
    // (see corridorHalfWidth), but the avoidance routing itself can
    // still occasionally swing past it while dodging a cluster of
    // obstacles - flag that so the person knows that stretch wasn't
    // fully checked, rather than silently trusting it. Hazards were
    // checked around the straight line, so that comparison is
    // against the final path directly; buildings were checked around
    // the hazard-only path, so that comparison is against how far the
    // *second* pass (adding building avoidance) swung from the first.
    const routeDeviationM = maxLateralDeviationM(avoidance.path, startlat, startlng, destlat, destlng);
    const routeLeftCheckedArea = hazardData !== null && routeDeviationM > hazardHalfWidthUsed;
    const buildingRouteDeviationM = maxPathDeviationM(avoidance.path, hazardOnlyPath);
    const routeLeftCheckedBuildingArea = buildingData !== null && buildingRouteDeviationM > buildingHalfWidthUsed;

    // Now that we know the actual (possibly detoured) route length,
    // work out how long each leg takes, and the battery it uses, at
    // every height.
    const timingOptsOut = { skipLanding: mission === 'photo' };
    const timingOptsBack = { skipTakeoff: mission === 'photo' };
    const tOut = legTimings(heights, pOut.prof, terrainSamples, w.gsOut, speedup, speeddown, timingOptsOut, routeDist);
    const tBack = legTimings(heights, pBack.prof, terrainBack, w.gsBack, speedupback, speeddownback, timingOptsBack, routeDist);

    const battModel = readBatteryModel();
    const payloadOut = parseFloat(document.getElementById('payload').value) || 1;
    const payloadBack = parseFloat(inp.payloadBackCoef) || 1;
    const battOut = legBattery(heights, battModel, payloadOut, w.airOut, tOut.timing, speedup, temperatureC);
    const battBack = legBattery(heights, battModel, payloadBack, w.airBack, tBack.timing, speedupback, temperatureC);

    // A height isn't flyable if:
    //  - it's above the legal height limit, or
    //  - it's below the minimum clearance above the tallest *climbable*
    //    building OSM knows about near this route (buildings too tall
    //    to clear within today's effective ceiling were already
    //    routed around above and don't factor in here), or
    //  - the estimated gust there meets or exceeds the drone's rated
    //    max wind resistance (an airframe limit, same for both legs), or
    //  - the crosswind component of the average wind meets or exceeds
    //    the drone's horizontal speed for that leg - beyond that point
    //    the drone can't hold its course at all, regardless of speed, or
    //  - the headwind stops it making headway, or the terrain can't be
    //    followed within the height limit.
    const maxBuildingHeight = sortedBuildings.maxClimbedHeight;
    const minSafeAltitude = maxBuildingHeight > 0 ? (maxBuildingHeight + BUILDING_HEIGHT_SAFETY_MARGIN_M) : 30;
    const buildingOk = heights.map(function(h){ return h >= minSafeAltitude; });
    const flyableOut = heights.map(function(h, i){
      return legalOk[i] && buildingOk[i] && w.windResOk[i] && w.crosswindOkOut[i] && w.headwindOkOut[i] && pOut.ok[i];
    });
    const flyableBack = heights.map(function(h, i){
      return legalOk[i] && buildingOk[i] && w.windResOk[i] && w.crosswindOkBack[i] && w.headwindOkBack[i] && pBack.ok[i];
    });
    const minhor = fastestFlyableIdx(flyableOut, tOut.timeV, tOut.timeH);
    const minhorb = fastestFlyableIdx(flyableBack, tBack.timeV, tBack.timeH);

    renderBatteryNote(battModel, temperatureC);
    renderRouteSummary(routeDist, straightDistM, avoidance, outboundHeading);
    renderHeightTable({
      heights: heights, w: w, legalOk: legalOk, buildingOk: buildingOk,
      terrainOkOut: pOut.ok, terrainOkBack: pBack.ok, flyableOut: flyableOut, flyableBack: flyableBack,
      tOut: tOut, tBack: tBack, battOut: battOut, battBack: battBack,
      minSafeAltitude: minSafeAltitude, windResistance: inp.windResistance, rules: rules
    });
    renderRulesInfo(rules, legalCapM, altPermit);
    const terrainBaseText = renderTerrainInfo(terrainAvailable, terrainSamples);
    renderBuildingInfo({
      buildings: buildings, sorted: sortedBuildings, minSafeAltitude: minSafeAltitude,
      effectiveCeilingM: effectiveCeilingM, legalCapM: legalCapM,
      leftCheckedArea: routeLeftCheckedBuildingArea, deviationM: buildingRouteDeviationM, halfWidthUsed: buildingHalfWidthUsed
    });
    renderHazardInfo({
      hazardData: hazardData, hazards: hazards, avoidance: avoidance,
      leftCheckedArea: routeLeftCheckedArea, deviationM: routeDeviationM, halfWidthUsed: hazardHalfWidthUsed
    });

    var baseline = { baseIdx: -1, travel120: Infinity };
    if (minhor !== -1 && minhorb !== -1){
        document.getElementById('flyWarning').style.display = 'none';
        baseline = renderBaselineSavings({
          heights: heights, flyableOut: flyableOut, flyableBack: flyableBack, tOut: tOut, tBack: tBack,
          battOut: battOut, battBack: battBack, minhor: minhor, minhorb: minhorb,
          routeDist: routeDist, speedhorizontal: speedhorizontal, speedhorizontalback: speedhorizontalback
        });
    } else {
        renderNoSafeHeightWarning({
          heights: heights, w: w, terrainOkOut: pOut.ok, terrainOkBack: pBack.ok, minhor: minhor, minhorb: minhorb,
          minSafeAltitude: minSafeAltitude, legalCapM: legalCapM, windResistance: inp.windResistance
        });
    }

    renderConditions(wx);

    renderCompassRose(outboundHeading, [
        {h: 20, wd: w.wd[0]},
        {h: 80, wd: w.wd[5]},
        {h: 120, wd: w.wd[9]}
    ]);

    // ---- Plans: fastest (above) and least battery.
    const legs = {
      out: { prof: pOut.prof, flyable: flyableOut, timeV: tOut.timeV, timeH: tOut.timeH, batt: battOut, gs: w.gsOut, air: w.airOut, cross: w.crosswindOkOut, head: w.headwindOkOut,
             payload: payloadOut, hs: speedhorizontal, up: speedup, down: speeddown, samples: terrainSamples, req: reqOut,
             climbRun: speedhorizontal / speedup, descRun: speedhorizontal / speeddown, timingOpts: timingOptsOut },
      back: { prof: pBack.prof, flyable: flyableBack, timeV: tBack.timeV, timeH: tBack.timeH, batt: battBack, gs: w.gsBack, air: w.airBack, cross: w.crosswindOkBack, head: w.headwindOkBack,
             payload: payloadBack, hs: speedhorizontalback, up: speedupback, down: speeddownback, samples: terrainBack, req: reqBack,
             climbRun: speedhorizontalback / speedupback, descRun: speedhorizontalback / speeddownback, timingOpts: timingOptsBack }
    };
    const planner = buildPlans({
      heights: heights, legs: legs, w: w, legalOk: legalOk, buildingOk: buildingOk, terrainAvailable: terrainAvailable,
      battModel: battModel, temperatureC: temperatureC, mission: mission, dwellS: inp.dwellS,
      payloadOut: payloadOut, payloadBack: payloadBack, speedupback: speedupback, speeddownback: speeddownback
    });
    const plans = planner.plans;
    // A hold-altitude profile can rescue a leg that terrain following
    // couldn't fly; don't leave the "can't recommend" warning up then.
    if (plans.fast.out && plans.fast.back) document.getElementById('flyWarning').style.display = 'none';
    track('calculate', {
      result: plans.fast.out && plans.fast.back ? 'ok' : (plans.fast.out || plans.fast.back) ? 'one_leg' : 'no_safe_height',
      drone: document.getElementById('droneModel').value,
      mission: mission,
      speed_mode: inp.speedMode,
      country: rules.detected.code || 'unknown',
      points: marker,
      distance_km: Math.round(routeDist / 100) / 10
    });
    renderPlanSavings(planner, legs, baseline, battOut, battBack);

    setCurrentCalc({
      plans: plans,
      heights: heights,
      terrainSamples: terrainSamples,
      terrainAvailable: terrainAvailable,
      terrainBaseText: terrainAvailable ? terrainBaseText : '',
      path: avoidance.path,
      terrainBack: terrainBack,
      mission: mission,
      speedOut: speedhorizontal,
      speedBack: speedhorizontalback,
      droneModel: document.getElementById('droneModel').value
    });
    renderPlan();
    renderForecastStrip(json, nowHourIdx);

    updateUrlForRoute();

    // Only learn timings from fully successful lookups.
    Progress.finish(hazardData !== null && buildingData !== null && terrainAvailable);
}

// The Calculate button (and the "Try again" links): runs calcHeight()
// with the button disabled, then scrolls to the result.
export async function getHeight() {
  var btn = document.getElementById('calcBtn');
  var originalLabel = btn.textContent;

  var resetBtn = document.getElementById('resetBtn');

  btn.disabled = true;
  btn.textContent = 'Calculating\u2026';
  if (resetBtn) resetBtn.disabled = true;  // the result would land after the reset
  hideNotice('calcNotice');

  try {
    if (await calcHeight() === false) return;
    var x = document.getElementById("result");
    x.style.display = "block";
    x.scrollIntoView({behavior: "smooth", block: "start"});
  } catch (err) {
    console.error(err);
    track('calculate', { result: 'error' });
    showNotice('calcNotice', 'Something went wrong while calculating - please try again.');
  } finally {
    Progress.finish(false); // no-op if it already finished
    if (resetBtn) resetBtn.disabled = false;
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}
