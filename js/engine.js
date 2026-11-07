// The calculation engine: everything calcHeight() needs worked out for
// a route - the lookups (forecast, rules, restricted sites, buildings,
// terrain, building wind, people) and the plans - with no page in sight.
// It takes a plain request and gives back plain data (encodeResult /
// decodeResult carry it as JSON), so it can run in the browser or on a
// server; calc.js turns the result into the page.
//
// computePlan(req, hooks) resolves to the main result. The route over
// fewer people comes later, through hooks.onPeople (people.js's updates,
// plus { type: 'plan', plan, altPath } when it has a plan of its own);
// hooks.done is called once that's finished too (only for a route:
// with points 1 nothing comes after the result).
//
// req: { start: {lat, lng}, dest: {lat, lng}, points (1: hover at the
//        start, 2: a route), mission, inp (readFlightInputs), battery
//        (readBatteryFields), altPermit, urbanWind, skippedSites,
//        forecastOffsetH }
// hooks: { stage(key), stale() (true once a newer calculation replaced
//          this one), onPeople(update), done() }

import { batteryModelFrom, gaugeUsedPct } from './battery.js';
import { getDistanceFromLatLon, hourIndexNow, trueBearing } from './core.js';
import { BUILDING_CORRIDOR_HALF_WIDTH_M, BUILDING_HEIGHT_SAFETY_MARGIN_M, BUILDING_LATERAL_SAFETY_MARGIN_M, HAZARD_CORRIDOR_HALF_WIDTH_M, MAX_FLIGHT_ALTITUDE_M, getBuildingsNearPath, getHazardsNearRoute } from './osm.js';
import { peoplePhase } from './people.js';
import { buildingsCrossingPath, computeAvoidanceRoute, maxLateralDeviationM, maxPathDeviationM } from './routing.js';
import { rangeExtremes } from './range.js';
import { rulesForLocation } from './rules.js';
import { splitHazards } from './sites.js';
import { buildingAltitudeRequirements, flatTerrainProfile, getTerrainProfile, reverseSamples, setMaxAglM } from './terrain.js';
import { loadUrbanArea, routeUrbanFactors } from './urbanwind.js';
import { loadFineArea } from './urbanfine.js';
import { endpointWinds, makeWindField, routeSegments } from './windfield.js';
import { getForecasts, routeForecastPoints } from './weather.js';
import {
  CANDIDATE_HEIGHTS_M, ECO_SPEED_FACTORS, LOWPOP_TALL_BUILDING_ROUNDS, baselineSavings, buildPlans, fastestFlyableIdx,
  flyableCeilingM, forecastAt, legBattery, legProfiles, legTimings, legWind, legsAtSpeed, planAlongPath, planSavings,
  roundTripRange, sortRouteBuildings, windByHeight
} from './calc.js';

export async function computePlan(req, hooks){
  hooks = hooks || {};
  var stale = hooks.stale || function(){ return false; };
  var stage = hooks.stage || function(){};
  var onPeople = hooks.onPeople || function(){};
  var finished = hooks.done || function(){};

  var startlat = req.start.lat, startlng = req.start.lng;
  var destlat = req.dest.lat, destlng = req.dest.lng;
  var mission = req.mission, inp = req.inp;
  // dronedegrees is the REVERSE bearing (destination -> start); the
  // wind formulas rely on that convention.
  var dronedegrees = (trueBearing(startlat, startlng, destlat, destlng) + 180) % 360;
  // For anything shown to the person, "heading" should mean the
  // outbound direction of travel, which is the opposite bearing.
  var outboundHeading = (dronedegrees + 180) % 360;
  var straightDistM = getDistanceFromLatLon(startlat, startlng, destlat, destlng);

  // Wind and hazards can be looked up together - hazards only need the
  // straight start->destination line. Buildings come later, once we
  // know the hazard-avoidance path, so a route that swings wide around a
  // cluster of hazards still gets building data along that swing.
  // Settled straight away, so a failed forecast is reported rather than
  // left as an unhandled rejection while the other lookups run.
  // The start, and on a long route a few more places along it.
  var windPromise = getForecasts(routeForecastPoints(startlat, startlng, destlat, destlng, straightDistM))
      .then(function(list){ return { json: list[0], along: list }; }, function(err){ return { error: err }; });
  // Country rules for the start point (never fails: falls back to
  // approximate boxes, then to Israel's rules).
  var rulesPromise = rulesForLocation(startlat, startlng);
  var hazardsPromise = getHazardsNearRoute(startlat, startlng, destlat, destlng, dronedegrees, rulesPromise)
      .catch(function(err){ console.warn('Hazard lookup failed:', err); return null; });

  var hazardData = await hazardsPromise;
  var rules = await rulesPromise;
  if (stale()) return { stale: true };
  // Legal height limit above ground for this route (never checked above
  // MAX_FLIGHT_ALTITUDE_M, even with a permit).
  var legalCapM = req.altPermit ? MAX_FLIGHT_ALTITUDE_M : Math.min(MAX_FLIGHT_ALTITUDE_M, rules.profile.maxAglM);
  setMaxAglM(legalCapM);
  // The height limit is the terrain module's setting: on a server other
  // calculations may have changed it while this one waited, so it's put
  // back every time this one carries on.
  function resumeStale(){ setMaxAglM(legalCapM); return stale(); }
  // Site types the person chose not to avoid are left out of the
  // routing (a country's no-fly sites never are), but still drawn.
  var siteSplit = splitHazards(hazardData ? hazardData.hazards : [], req.skippedSites || []);
  var hazards = siteSplit.avoided, ignoredHazards = siteSplit.ignored;
  var hazardHalfWidthUsed = hazardData ? hazardData.hazardHalfWidthUsed : HAZARD_CORRIDOR_HALF_WIDTH_M;
  var hazardObstacles = hazards.map(function(h){
    return { lat: h.lat, lng: h.lng, clearance: h.clearance, radius: h.radius, kind: 'hazard', type: h.type, name: h.name };
  });
  // First pass: route around hazards only. This is also the final route
  // if no buildings end up needing a detour of their own.
  var avoidance = computeAvoidanceRoute(startlat, startlng, destlat, destlng, hazardObstacles);

  stage('buildings');
  var buildingPromise = getBuildingsNearPath(avoidance.path, straightDistM)
      .catch(function(err){ console.warn('Building lookup failed:', err); return null; });
  // Terrain along the hazard-avoiding path, fetched alongside the
  // buildings. Reused as-is unless buildings force a further detour.
  var firstTerrainPromise = getTerrainProfile(avoidance.path)
      .catch(function(err){ console.warn('Terrain lookup failed:', err); return null; });
  // Building data and model for the building effect on the wind
  // (optional: without it the forecast is used as it is).
  var urbanPromise = req.urbanWind
      ? loadUrbanArea(avoidance.path).catch(function(err){ console.warn('Building wind lookup failed:', err); return null; })
      : Promise.resolve(null);
  // The buildings right at the takeoff and landing points, for the wind
  // among them (urbanfine.js; optional, like the above).
  var landsAtDest = req.points === 2 && mission !== 'photo';
  var finePromise = req.urbanWind
      ? Promise.all([startlat, landsAtDest ? destlat : null].map(function(la, k){
          if (la === null) return null;
          return loadFineArea(la, k ? destlng : startlng).catch(function(err){ console.warn('Fine building wind unavailable:', err.message || err); return null; });
        }))
      : Promise.resolve([null, null]);

  var wind = await windPromise;
  if (resumeStale()) return { stale: true };
  if (wind.error){
    console.warn('Forecast lookup failed:', wind.error);
    return { error: 'forecast' };
  }
  var json = wind.json;
  var buildingData = await buildingPromise;
  if (resumeStale()) return { stale: true };
  var buildings = buildingData ? buildingData.buildings : null;
  var buildingList = buildings ? buildings.list : [];
  var buildingHalfWidthUsed = buildingData ? buildingData.buildingHalfWidthUsed : BUILDING_CORRIDOR_HALF_WIDTH_M;
  stage('compute');

  var nowHourIdx = hourIndexNow(json.hourly.time);
  var hour = Math.min(nowHourIdx + (req.forecastOffsetH || 0), json.hourly.time.length - 1);
  var wx = forecastAt(json, hour);
  var temperatureC = wx.temperatureC;
  var forecastPoints = routeForecastPoints(startlat, startlng, destlat, destlng, straightDistM)
    .map(function(p, k){ return { lat: p.lat, lng: p.lng, wx: k === 0 ? wx : forecastAt(wind.along[k], hour) }; });

  var speedup = inp.speedup, speeddown = inp.speeddown, speedhorizontal = inp.speedhorizontal;
  var speedupback = inp.speedupback, speeddownback = inp.speeddownback, speedhorizontalback = inp.speedhorizontalback;
  var heights = CANDIDATE_HEIGHTS_M.slice();
  var urbanArea = await urbanPromise;
  if (resumeStale()) return { stale: true };
  if (urbanArea){
    var wdH = windByHeight(heights, wx, dronedegrees, inp).wd;
    wx.urban = routeUrbanFactors(urbanArea, heights, wdH, wx.wd10);
  }
  var w = windByHeight(heights, wx, dronedegrees, inp);
  var legalOk = heights.map(function(h){ return h <= legalCapM + 0.01; });
  var effectiveCeilingM = flyableCeilingM(heights, legalOk, w);
  var sortedBuildings = sortRouteBuildings(buildingList, avoidance.path, effectiveCeilingM);

  // Second pass: only re-run the avoidance routing if a building
  // actually needs to be routed around.
  var hazardOnlyPath = avoidance.path;
  if (sortedBuildings.toAvoid.length > 0){
    var combinedObstacles = hazardObstacles.concat(sortedBuildings.toAvoid.map(function(b){
      return { lat: b.lat, lng: b.lng, clearance: b.radius + BUILDING_LATERAL_SAFETY_MARGIN_M, kind: 'building', type: 'building', name: null, height: b.height };
    }));
    avoidance = computeAvoidanceRoute(startlat, startlng, destlat, destlng, combinedObstacles);
  }
  var routeDist = avoidance.distance;

  var terrainSamples = await firstTerrainPromise;
  if (avoidance.path !== hazardOnlyPath){
    terrainSamples = await getTerrainProfile(avoidance.path)
        .catch(function(err){ console.warn('Terrain lookup failed:', err); return null; });
  }
  if (resumeStale()) return { stale: true };
  var terrainAvailable = terrainSamples !== null;
  if (!terrainAvailable) terrainSamples = flatTerrainProfile(avoidance.path);

  // Buildings still on the final route are the ones we climb over
  // (detoured ones sit just outside their clearance circle, hence the
  // 1 m slack).
  var buildingsUnderRoute = buildingsCrossingPath(buildingList, avoidance.path, BUILDING_LATERAL_SAFETY_MARGIN_M - 1);
  var reqOut = buildingAltitudeRequirements(terrainSamples, buildingsUnderRoute);
  var terrainBack = reverseSamples(terrainSamples);
  var reqBack = reqOut.slice().reverse();
  var pOut = legProfiles(heights, terrainSamples, reqOut, speedhorizontal, speedup, speeddown);
  var pBack = legProfiles(heights, terrainBack, reqBack, speedhorizontalback, speedupback, speeddownback);

  // The avoidance routing can occasionally swing past the corridor that
  // was checked: flag it so the person knows that stretch wasn't fully
  // checked. Hazards were checked around the straight line; buildings
  // around the hazard-only path.
  var routeDeviationM = maxLateralDeviationM(avoidance.path, startlat, startlng, destlat, destlng);
  var routeLeftCheckedArea = hazardData !== null && routeDeviationM > hazardHalfWidthUsed;
  var buildingRouteDeviationM = maxPathDeviationM(avoidance.path, hazardOnlyPath);
  var routeLeftCheckedBuildingArea = buildingData !== null && buildingRouteDeviationM > buildingHalfWidthUsed;

  // Now that we know the actual (possibly detoured) route length, how
  // long each leg takes, and the battery it uses, at every height.
  var timingOptsOut = { skipLanding: mission === 'photo' };
  var timingOptsBack = { skipTakeoff: mission === 'photo' };
  // Every stretch of each leg with its own wind and heading (windfield.js).
  var windField = makeWindField(forecastPoints, urbanArea, heights);
  // The wind where the drone takes off and lands (a photo mission turns
  // round in the air at the destination).
  var fineAreas = await finePromise;
  if (resumeStale()) return { stale: true };
  var groundWind = {
    start: endpointWinds(forecastPoints, urbanArea, startlat, startlng, null, fineAreas[0]),
    dest: landsAtDest ? endpointWinds(forecastPoints, urbanArea, destlat, destlng, null, fineAreas[1]) : null
  };
  var segOut = routeSegments(terrainSamples, heights, windField, inp.windResistance);
  var segBack = routeSegments(terrainBack, heights, windField, inp.windResistance);
  var lwOut = legWind(w, segOut, speedhorizontal, inp, 'Out', heights);
  var lwBack = legWind(w, segBack, speedhorizontalback, inp, 'Back', heights);
  var tOut = legTimings(heights, pOut.prof, terrainSamples, lwOut.gs, speedup, speeddown, timingOptsOut, routeDist);
  var tBack = legTimings(heights, pBack.prof, terrainBack, lwBack.gs, speedupback, speeddownback, timingOptsBack, routeDist);

  var battModel = batteryModelFrom(req.battery);
  var payloadOut = inp.payloadOutCoef, payloadBack = inp.payloadBackCoef;
  var battOut = legBattery(heights, battModel, payloadOut, lwOut.air, tOut.timing, speedup, temperatureC);
  var battBack = legBattery(heights, battModel, payloadBack, lwBack.air, tBack.timing, speedupback, temperatureC);

  // A height isn't flyable if it's above the legal limit, below the
  // clearance over the tallest building we climb over, the gust there
  // meets the drone's rated wind resistance, the crosswind or headwind
  // is too much for the leg's speed, or the terrain can't be followed
  // within the height limit.
  var maxBuildingHeight = sortedBuildings.maxClimbedHeight;
  var minSafeAltitude = maxBuildingHeight > 0 ? (maxBuildingHeight + BUILDING_HEIGHT_SAFETY_MARGIN_M) : 30;
  var buildingOk = heights.map(function(h){ return h >= minSafeAltitude; });
  var flyableOut = heights.map(function(h, i){
    return legalOk[i] && buildingOk[i] && lwOut.gustOk[i] && lwOut.cross[i] && lwOut.head[i] && pOut.ok[i];
  });
  var flyableBack = heights.map(function(h, i){
    return legalOk[i] && buildingOk[i] && lwBack.gustOk[i] && lwBack.cross[i] && lwBack.head[i] && pBack.ok[i];
  });
  var minhor = fastestFlyableIdx(flyableOut, tOut.timeV, tOut.timeH);
  var minhorb = fastestFlyableIdx(flyableBack, tBack.timeV, tBack.timeH);
  var baseline = (minhor !== -1 && minhorb !== -1) ? baselineSavings({
    heights: heights, flyableOut: flyableOut, flyableBack: flyableBack, tOut: tOut, tBack: tBack,
    battOut: battOut, battBack: battBack, battModel: battModel, minhor: minhor, minhorb: minhorb,
    routeDist: routeDist, speedhorizontal: speedhorizontal, speedhorizontalback: speedhorizontalback
  }) : null;

  // ---- Plans: fastest and least battery.
  var legs = {
    out: { prof: pOut.prof, flyable: flyableOut, timeV: tOut.timeV, timeH: tOut.timeH, batt: battOut, gs: lwOut.gs, air: lwOut.air, cross: lwOut.cross, head: lwOut.head, gustOk: lwOut.gustOk,
           payload: payloadOut, hs: speedhorizontal, up: speedup, down: speeddown, samples: terrainSamples, req: reqOut,
           climbRun: speedhorizontal / speedup, descRun: speedhorizontal / speeddown, timingOpts: timingOptsOut },
    back: { prof: pBack.prof, flyable: flyableBack, timeV: tBack.timeV, timeH: tBack.timeH, batt: battBack, gs: lwBack.gs, air: lwBack.air, cross: lwBack.cross, head: lwBack.head, gustOk: lwBack.gustOk,
           payload: payloadBack, hs: speedhorizontalback, up: speedupback, down: speeddownback, samples: terrainBack, req: reqBack,
           climbRun: speedhorizontalback / speedupback, descRun: speedhorizontalback / speeddownback, timingOpts: timingOptsBack }
  };
  // Everything needed to plan a route, for the slower-speed options and
  // for the route over fewer people (planAlongPath).
  var planCtx = {
    heights: heights, wx: wx, dronedegrees: dronedegrees, inp: inp, legalOk: legalOk, battModel: battModel,
    temperatureC: temperatureC, payloadOut: payloadOut, payloadBack: payloadBack, mission: mission,
    timingOptsOut: timingOptsOut, timingOptsBack: timingOptsBack, effectiveCeilingM: effectiveCeilingM,
    straightDistM: straightDistM, w: w, terrainAvailable: terrainAvailable, windField: windField, legalCapM: legalCapM
  };
  var mainRoute = { samples: terrainSamples, back: terrainBack, reqOut: reqOut, reqBack: reqBack, pOut: pOut, pBack: pBack,
                    buildingOk: buildingOk, distance: routeDist, segOut: segOut, segBack: segBack };
  var speedLegs = ECO_SPEED_FACTORS.map(function(f){ return legsAtSpeed(planCtx, mainRoute, f); });
  var planner = buildPlans({
    heights: heights, legs: legs, speedLegs: speedLegs, w: w, legalOk: legalOk, buildingOk: buildingOk, terrainAvailable: terrainAvailable,
    battModel: battModel, temperatureC: temperatureC, mission: mission, dwellS: inp.dwellS,
    payloadOut: payloadOut, payloadBack: payloadBack, speedupback: speedupback, speeddownback: speeddownback
  });
  var plans = planner.plans;

  // How far the drone can get and back from the start, every way (every
  // direction from the start, so not the building factor of this route).
  var ranges = roundTripRange({
    heights: heights, legalOk: legalOk, wx: Object.assign({}, wx, { urban: null }), inp: inp, battModel: battModel,
    payloadOut: payloadOut, payloadBack: payloadBack, temperatureC: temperatureC, mission: mission
  });
  var rangeExt = rangeExtremes(ranges);

  // The people under the route and the route over fewer people come
  // after the result: they don't hold it up.
  var result = {
    rules: rules, legalCapM: legalCapM,
    hazards: hazards, ignoredHazards: ignoredHazards, hazardFound: hazardData !== null, buildingList: buildingList,
    path: avoidance.path,
    avoidance: { path: avoidance.path, distance: avoidance.distance, buildingsAvoided: avoidance.buildingsAvoided,
                 hazardsAvoided: avoidance.hazardsAvoided, trapped: avoidance.trapped },
    routeDist: routeDist, straightDistM: straightDistM, outboundHeading: outboundHeading,
    battery: battModel ? { measured: battModel.measured } : null, temperatureC: temperatureC,
    heights: heights, w: w, legalOk: legalOk, buildingOk: buildingOk, minSafeAltitude: minSafeAltitude,
    terrainOkOut: pOut.ok, terrainOkBack: pBack.ok, flyableOut: flyableOut, flyableBack: flyableBack,
    tOut: { timeV: tOut.timeV, timeH: tOut.timeH }, tBack: { timeV: tBack.timeV, timeH: tBack.timeH },
    battPair: heights.map(function(h, i){ return gaugeUsedPct(battModel, battOut[i] + battBack[i]); }),
    minhor: minhor, minhorb: minhorb, baseline: baseline,
    planSavings: baseline ? planSavings(planner, legs, baseline, battOut, battBack) : null,
    terrainAvailable: terrainAvailable, terrainSamples: terrainSamples, terrainBack: terrainBack,
    urban: wx.urban || null, groundWind: groundWind,
    buildings: buildings, sortedBuildings: { onRoute: sortedBuildings.onRoute, avoidedForSimplicity: sortedBuildings.avoidedForSimplicity,
      tooTall: sortedBuildings.tooTall, maxClimbedHeight: sortedBuildings.maxClimbedHeight },
    effectiveCeilingM: effectiveCeilingM,
    buildingCheck: { leftCheckedArea: routeLeftCheckedBuildingArea, deviationM: buildingRouteDeviationM, halfWidthUsed: buildingHalfWidthUsed },
    hazardCheck: { leftCheckedArea: routeLeftCheckedArea, deviationM: routeDeviationM, halfWidthUsed: hazardHalfWidthUsed },
    wx: { visibility: wx.visibility, precipitation: wx.precipitation, precipitation_probability: wx.precipitation_probability, temperatureC: wx.temperatureC },
    plans: plans, ranges: ranges, rangeFarM: rangeExt ? rangeExt.far.distM : 0,
    forecast: { json: json, nowHourIdx: nowHourIdx },
    mission: mission, speedOut: speedhorizontal, speedBack: speedhorizontalback,
    lookupsOk: hazardData !== null && buildingData !== null && terrainAvailable
  };

  // Not awaited by the result: the people under the route, then a route
  // over fewer people - planned as a whole plan of its own (the "Fewer
  // people" tab). It isn't detoured round buildings, so when it passes
  // ones too tall to climb over, it's looked for again keeping clear of
  // them (a few rounds, as the new route can meet others).
  var people = req.points === 2 ? peoplePhase(avoidance.path, {
    from: { lat: startlat, lng: startlng }, to: { lat: destlat, lng: destlng },
    // Buildings too tall to climb over today are kept out of the way too.
    distance: routeDist, obstacles: hazardObstacles.concat(buildingList.filter(function(b){
      return b.height + BUILDING_HEIGHT_SAFETY_MARGIN_M > effectiveCeilingM;
    }).map(function(b){
      return { lat: b.lat, lng: b.lng, clearance: b.radius + BUILDING_LATERAL_SAFETY_MARGIN_M, radius: b.radius };
    })),
    planAlt: async function(alt, research){
      var avoid = [];
      for (var round = 0; ; round++){
        var res = await planAlongPath(planCtx, alt.path);
        if (resumeStale()) return null;
        var plan = res.plans.fast;
        if (res.tooTall.length === 0 && plan.out && plan.back){
          onPeople({ type: 'plan', plan: Object.assign({}, plan, { route: res.route, people: alt.people }), altPath: alt.path });
          return { ok: true, alt: alt };
        }
        if (res.tooTall.length === 0) return { ok: false, reason: 'no height is safe along it today' };
        avoid = avoid.concat(res.tooTall.map(function(b){
          return { lat: b.lat, lng: b.lng, clearance: b.radius + BUILDING_LATERAL_SAFETY_MARGIN_M, radius: b.radius };
        }));
        alt = round < LOWPOP_TALL_BUILDING_ROUNDS - 1 ? await research(avoid) : null;
        if (!alt) return { ok: false, reason: 'it passes buildings too tall to fly over at the heights allowed today, and no way round them saves enough people' };
      }
    }
  }, function(u){ if (!stale()) onPeople(u); }) : Promise.resolve(null);
  if (req.points === 2){
    people.then(function(r){ if (!stale()) finished(r ? { people: r.people } : null); },
                function(err){ console.warn('People under the route failed:', err); if (!stale()) finished(null); });
  }
  return result;
}

// JSON can't carry Infinity or NaN, which the plans use for "can't".
export function encodeResult(x){
  return JSON.stringify(x, function(k, v){
    if (typeof v === 'number' && !isFinite(v)) return { $n: String(v) };
    return v;
  });
}
export function decodeResult(s){
  return JSON.parse(s, function(k, v){
    if (v && typeof v === 'object' && typeof v.$n === 'string' && Object.keys(v).length === 1) return Number(v.$n);
    return v;
  });
}
