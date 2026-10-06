// calcHeight(): the main calculation that ties everything together.

async function calcHeight() {

    if (marker==0){
       window.alert('please choose location');
       return;
        }

    if (marker==1)
        {lat2=lat1;
         lng2=lng1;
        }
    startlat=lat1;
    startlng=lng1;
    destlat=lat2;
    destlng=lng2;
    difflat=startlat-destlat;
    difflng=startlng-destlng;
    // dronedegrees is the REVERSE bearing (destination -> start); the
    // wind formulas below rely on that convention.
    var dronedegrees = (trueBearing(startlat, startlng, destlat, destlng) + 180) % 360;
    // dronedegrees is used as-is by the headwind/crosswind formulas
    // below; for anything shown to the person, "heading" should mean
    // the outbound direction of travel, which is the opposite bearing.
    var outboundHeading = (dronedegrees + 180) % 360;
    dist=getDistanceFromLatLon(startlat,startlng,destlat, destlng);

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
    const windPromise = this.getJSON();
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
    MAX_AGL_M = legalCapM;
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

    const json = await windPromise;  // command waits until completion
    const buildingData = await buildingPromise;
    const buildings = buildingData ? buildingData.buildings : null;
    const buildingList = buildings ? buildings.list : [];
    const buildingHalfWidthUsed = buildingData ? buildingData.buildingHalfWidthUsed : BUILDING_CORRIDOR_HALF_WIDTH_M;
    Progress.stage('compute');

    const d = new Date();
    const nowHourIdx = hourIndexNow(json.hourly.time);
    let hour = Math.min(nowHourIdx + forecastOffsetH, json.hourly.time.length - 1);
    var mydata = JSON.stringify(json, null, 2);

ws10=json.hourly.wind_speed_10m[hour]/3.6;
ws80=json.hourly.wind_speed_80m[hour]/3.6;
ws120=json.hourly.wind_speed_120m[hour]/3.6;
wd10=json.hourly.wind_direction_10m[hour];
wd80=json.hourly.wind_direction_80m[hour];
wd120=json.hourly.wind_direction_120m[hour];
gust10=json.hourly.wind_gusts_10m[hour]/3.6;
precipitation_probability=json.hourly.precipitation_probability[hour];
precipitation=json.hourly.precipitation[hour];
visibility=json.hourly.visibility[hour];
var temperatureC = json.hourly.temperature_2m ? json.hourly.temperature_2m[hour] : null;

// Gusts are only forecast at 10m. We estimate gusts at other heights
// by applying the same gustiness ratio (gust/average at 10m) to the
// average wind there - clamped so a near-calm 10m reading (division
// by ~0) can't blow the ratio up unrealistically.
gustFactor = (ws10 > 0.1) ? (gust10 / ws10) : 1;
gustFactor = Math.min(Math.max(gustFactor, 1), 3);

//    window.alert(dronedegrees);
//    window.alert(dist);

//// time to go to 20m + time to go horizontaly
//    window.alert(ws80+ ' m/s '+ wd80 + ' de2222grees');

    var mission = currentMission();
    var dwellS = Math.max(0, parseFloat(document.getElementById('dwell').value) || 0);
    // Photo missions carry the same load both ways.
    var payloadBackCoef = mission === 'photo' ? document.getElementById('payload').value : document.getElementById('payloadback').value;
    speedup=document.getElementById('asc').value/document.getElementById('payload').value;
    speeddown=document.getElementById('des').value/document.getElementById('payload').value;
    speedhorizontal=document.getElementById('hor').value/document.getElementById('payload').value;
    speedupback=document.getElementById('asc').value/payloadBackCoef;
    speeddownback=document.getElementById('des').value/payloadBackCoef;
    speedhorizontalback=document.getElementById('hor').value/payloadBackCoef;

    drag=document.getElementById('drag').value
    var windResistance = parseFloat(document.getElementById('windres').value);

    // Per-height wind figures (average speed/direction, estimated
    // gust, crosswind component, and whether that height is flyable
    // on wind grounds alone) only depend on the forecast and the
    // drone's own speeds - not on the route distance - so we can work
    // these out before we know the final (possibly detoured) route
    // length below.
    heights = [30, 40, 50, 60, 70, 80, 90, 100, 110, 120]
    ws = []
    wd = []
    estgust = []
    crosswind = []
    windResOk = []
    crosswindOkOut = []
    crosswindOkBack = []
    gsOut = []
    gsBack = []
    headwindOkOut = []
    headwindOkBack = []
    var dragF = parseFloat(drag) || 1
    for (i=0;i<heights.length; i++) {
    if (heights[i]<80)
            {
            ws[i]=ws10*(80-heights[i])/70+ws80*(heights[i]-10)/70
            wd[i]=interpDir(wd10, wd80, (heights[i]-10)/70)
            }
        else if (heights[i]==80)
            {
            ws[i]=ws80
            wd[i]=wd80
            }
            else if (heights[i]==120)
   {
   ws[i]=ws120
   wd[i]=wd120  
   }
   else
   {
   ws[i]=ws80*(120-heights[i])/40+ws120*(heights[i]-80)/40
   wd[i]=interpDir(wd80, wd120, (heights[i]-80)/40)
   }
diffangle=(wd[i]-dronedegrees)/180*Math.PI
// Gust extrapolated from the 10m gust/average ratio, and the
// crosswind component (perpendicular to heading) of the average
// wind - used below as separate flyability checks.
estgust[i] = ws[i] * gustFactor
crosswind[i] = ws[i] * Math.abs(Math.sin(diffangle))
windResOk[i] = estgust[i] < windResistance
crosswindOkOut[i] = speedhorizontal > crosswind[i]
crosswindOkBack[i] = speedhorizontalback > crosswind[i]
// Wind-triangle ground speed for each leg (drag scales how strongly
// the wind acts on the drone; 1.0 = plain vector addition). The
// return leg flies the opposite track, so its relative angle is +180.
gsOut[i] = groundSpeed(speedhorizontal, ws[i]*dragF, diffangle)
gsBack[i] = groundSpeed(speedhorizontalback, ws[i]*dragF, diffangle + Math.PI)
headwindOkOut[i] = !crosswindOkOut[i] || gsOut[i] > MIN_GROUND_SPEED_MS
headwindOkBack[i] = !crosswindOkBack[i] || gsBack[i] > MIN_GROUND_SPEED_MS
    }

    // Wind alone can put a lower ceiling on today's flight than the
    // drone's altitude limit - e.g. gusts might only stay under the
    // drone's rating up to 80 m even though we normally check as high
    // as 120 m. A building only counts as "too tall to climb over"
    // once it's taller than whichever ceiling is actually flyable
    // right now (wind included), not a flat 120 m - otherwise we'd
    // recommend climbing to a height that the wind rules out anyway.
    legalOk = []
    for (i=0;i<heights.length; i++) legalOk[i] = heights[i] <= legalCapM + 0.01
    var effectiveCeilingM = 0;
    for (i=0;i<heights.length; i++) {
        if (legalOk[i] && windResOk[i] && crosswindOkOut[i] && crosswindOkBack[i] && headwindOkOut[i] && headwindOkBack[i] && heights[i] > effectiveCeilingM){
            effectiveCeilingM = heights[i]
        }
    }

    // Only buildings that actually sit on (within a safety margin of)
    // the route matter here. This checks against the *actual*
    // hazard-avoidance path computed above, not the straight line -
    // otherwise a route that swings wide around a cluster of hazards
    // could carry building height/detour requirements from a
    // building nowhere near where the drone will really fly, or miss
    // one that the swing brings it close to.
    var onRouteBuildings = buildingsCrossingPath(buildingList, avoidance.path, BUILDING_LATERAL_SAFETY_MARGIN_M);

    var tooTallOnRoute = onRouteBuildings.filter(function(b){
      return b.height + BUILDING_HEIGHT_SAFETY_MARGIN_M > effectiveCeilingM;
    });
    var climbableOnRoute = onRouteBuildings.filter(function(b){
      return b.height + BUILDING_HEIGHT_SAFETY_MARGIN_M <= effectiveCeilingM;
    });

    // A handful of buildings actually on the route are simpler (and
    // often lets us fly lower) to just detour around at ground level
    // than to climb over all of them - detouring around every single
    // one only risks an impractical zigzag once there are enough of
    // them clustered on the direct line, so past that count we fall
    // back to climbing over the tallest of the climbable ones, and
    // only detour around the ones that are too tall to climb over
    // regardless (which happens no matter how many there are).
    var avoidAllOnRoute = onRouteBuildings.length > 0 && onRouteBuildings.length <= BUILDING_AVOID_MAX_COUNT;
    var avoidedForSimplicity = avoidAllOnRoute ? climbableOnRoute : [];
    var climbedOver = avoidAllOnRoute ? [] : climbableOnRoute;
    var buildingsToAvoid = tooTallOnRoute.concat(avoidedForSimplicity);
    var maxBuildingHeight = climbedOver.reduce(function(m, b){ return Math.max(m, b.height); }, 0);

    // Second pass: only re-run the avoidance routing if a building
    // actually needs to be routed around - otherwise the hazard-only
    // route from above is already final, and re-running it would
    // just recompute the same path.
    var hazardOnlyPath = avoidance.path;
    if (buildingsToAvoid.length > 0){
      const combinedObstacles = hazardObstacles.concat(buildingsToAvoid.map(function(b){
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
    var buildingsUnderRoute = buildingsCrossingPath(buildingList, avoidance.path, BUILDING_LATERAL_SAFETY_MARGIN_M - 1);
    var reqOut = buildingAltitudeRequirements(terrainSamples, buildingsUnderRoute);
    var terrainBack = reverseSamples(terrainSamples);
    var reqBack = reqOut.slice().reverse();
    profOut = []
    profBack = []
    terrainOkOut = []
    terrainOkBack = []
    for (i=0;i<heights.length; i++) {
        profOut[i] = buildAltitudeProfile(terrainSamples, heights[i], reqOut, speedhorizontal / speedup, speedhorizontal / speeddown)
        profBack[i] = buildAltitudeProfile(terrainBack, heights[i], reqBack, speedhorizontalback / speedupback, speedhorizontalback / speeddownback)
        terrainOkOut[i] = profOut[i].ok
        terrainOkBack[i] = profBack[i].ok
    }

    // Airports, military sites, prisons and embassies aren't just
    // "risky to overfly" like a school - flying near them can be
    // flatly illegal or need special authorization, no matter how
    // wide a berth the route gives them. The routing avoidance above
    // only ever detours around a capped radius (so one huge site
    // can't break the pathfinding), so that alone isn't enough of a
    // check - this looks at actual distance to the real site instead
    // and raises a hard, unmissable warning when the route comes
    // anywhere close.
    var noFlyWarningEl = document.getElementById('noFlyWarning')
    var noFlyItems = hazards.filter(function(h){
      if (!h.noFly) return false;
      return minDistanceFromPath(avoidance.path, h.lat, h.lng) < (h.radius + h.warnM)
    }).map(function(h){
      var label = HAZARD_TYPE_LABEL[h.type] || 'restricted site'
      if (h.name) label += ' (' + escapeHtml(h.name) + ')'
      var note = rules.profile.noFlyNote[h.type]
      return label + ' — ' + (note || ('keep-out distance around ' + formatDistance(h.buffer)))
    })
    var zoneNotes = []
    rules.profile.specialZones.forEach(function(z){
      if (minDistanceFromPath(avoidance.path, z.lat, z.lng) >= z.radiusM) return
      if (z.noFly) noFlyItems.push(z.name + ' — ' + z.text)
      else zoneNotes.push(z.name + ': ' + z.text + '.')
    })
    // An inner no-fly zone already covers the outer ring's message.
    if (noFlyItems.length > 0) zoneNotes = []
    if (noFlyItems.length > 0 || zoneNotes.length > 0){
        var lead = noFlyItems.length > 0
            ? '⚠️ This route passes near: ' + noFlyItems.join('; ') + '. Flying here may be illegal or require authorization, regardless of the altitude or path shown above.'
            : '⚠️ ' + zoneNotes.join(' ')
        noFlyWarningEl.innerHTML = lead +
            '<span class="no-fly-detail">Applying ' + (rules.fallback ? 'Israel’s rules (the default for this country)' : 'the rules for ' + rules.profile.country) +
            '. Distances come from published rule summaries and OpenStreetMap’s map data — a starting point, not a guarantee. Check <a href="' + rules.profile.checkUrl + '" target="_blank" rel="noopener" style="color:inherit">' + rules.profile.checkLabel + '</a> before flying.</span>'
        noFlyWarningEl.style.display = 'block'
    } else {
        noFlyWarningEl.style.display = 'none'
    }

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
    // work out how long each leg takes at every height.
    timeupdown = []
    timeupdownback = []
    timehor = []
    timehorb = []
    timingOut = []
    timingBack = []
    var timingOptsOut = { skipLanding: mission === 'photo' }
    var timingOptsBack = { skipTakeoff: mission === 'photo' }
    for (i=0;i<heights.length; i++) {
        // timehor = time to cover the distance; timeupdown = everything
        // the climbs and descents add on top (takeoff, landing, and any
        // stretch where the height change is slower than the distance).
        timingOut[i] = gsOut[i] > MIN_GROUND_SPEED_MS ? profileTiming(profOut[i], terrainSamples, gsOut[i], speedup, speeddown, timingOptsOut) : null
        timingBack[i] = gsBack[i] > MIN_GROUND_SPEED_MS ? profileTiming(profBack[i], terrainBack, gsBack[i], speedupback, speeddownback, timingOptsBack) : null
        timehor[i] = timingOut[i] ? routeDist / gsOut[i] : Infinity
        timehorb[i] = timingBack[i] ? routeDist / gsBack[i] : Infinity
        timeupdown[i] = timingOut[i] ? timingOut[i].total - timehor[i] : 0
        timeupdownback[i] = timingBack[i] ? timingBack[i].total - timehorb[i] : 0
    }

    // Battery for each leg at every height.
    var battModel = readBatteryModel()
    var payloadOut = parseFloat(document.getElementById('payload').value) || 1
    var payloadBack = parseFloat(payloadBackCoef) || 1
    battOut = []
    battBack = []
    for (i=0;i<heights.length; i++) {
        if (battModel){
            battOut[i] = batteryPct(battModel, legEnergyFromTiming(battModel, payloadOut, speedhorizontal, timingOut[i], speedup), temperatureC)
            battBack[i] = batteryPct(battModel, legEnergyFromTiming(battModel, payloadBack, speedhorizontalback, timingBack[i], speedupback), temperatureC)
        } else {
            battOut[i] = NaN
            battBack[i] = NaN
        }
    }

    // A height isn't flyable if:
    //  - it's below the minimum clearance above the tallest *climbable*
    //    building OSM knows about near this route (buildings too tall
    //    to clear within today's effective ceiling were already
    //    routed around above and don't factor in here), or
    //  - the estimated gust there meets or exceeds the drone's rated
    //    max wind resistance (an airframe limit, same for both legs), or
    //  - the crosswind component of the average wind meets or exceeds
    //    the drone's horizontal speed for that leg - beyond that point
    //    the drone can't hold its course at all, regardless of speed.
    var minSafeAltitude = maxBuildingHeight > 0 ? (maxBuildingHeight + BUILDING_HEIGHT_SAFETY_MARGIN_M) : 30;

    flyableOut = []
    flyableBack = []
    buildingOk = []
    for (i=0;i<heights.length; i++) {
        buildingOk[i] = heights[i] >= minSafeAltitude
        flyableOut[i] = legalOk[i] && buildingOk[i] && windResOk[i] && crosswindOkOut[i] && headwindOkOut[i] && terrainOkOut[i]
        flyableBack[i] = legalOk[i] && buildingOk[i] && windResOk[i] && crosswindOkBack[i] && headwindOkBack[i] && terrainOkBack[i]
    }

    minhor = -1
    minhorb = -1
    for (i=0;i<heights.length; i++) {
        if (flyableOut[i] && (minhor===-1 || timeupdown[i]+timehor[i]<timeupdown[minhor]+timehor[minhor]))
            minhor=i
        if (flyableBack[i] && (minhorb===-1 || timeupdownback[i]+timehorb[i]<timeupdownback[minhorb]+timehorb[minhorb]))
            minhorb=i
    }

    tofixed=0

    var battNote = document.getElementById('batteryNote')
    if (battNote){
        battNote.innerHTML = 'Battery figures are estimates from the drone\u2019s rated flight time, payload, climbs and wind (roughly \u00B120%)' +
            (typeof temperatureC === 'number' && coldCapacityFactor(temperatureC) < 1 ? ', reduced for the cold (' + (unitsImperial ? (temperatureC * 9 / 5 + 32).toFixed(0) + '\u00B0F' : temperatureC.toFixed(0) + '\u00B0C') + ')' : '') +
            '. Older packs hold less \u2014 set battery health in the drone settings.'
        battNote.style.display = battModel ? 'block' : 'none'
    }
    document.getElementById('distance').innerHTML = fmtDist(routeDist)
    var detourNote = document.getElementById('detourNote')
    var detourExtra = routeDist - dist
    var totalAvoided = avoidance.buildingsAvoided + avoidance.hazardsAvoided
    if (totalAvoided > 0 && detourExtra > 1){
        var avoidedParts = []
        if (avoidance.buildingsAvoided > 0) avoidedParts.push(avoidance.buildingsAvoided + ' building' + (avoidance.buildingsAvoided===1?'':'s'))
        if (avoidance.hazardsAvoided > 0) avoidedParts.push(avoidance.hazardsAvoided + ' restricted area' + (avoidance.hazardsAvoided===1?'':'s'))
        detourNote.textContent = ' (+' + fmtDist(detourExtra) + ' detour around ' + avoidedParts.join(' and ') + ')'
    } else {
        detourNote.textContent = ''
    }
    document.getElementById('dronedir').innerHTML = outboundHeading.toFixed(tofixed)
    // document.getElementById('windrose').innerHTML = wd[0].toFixed(tofixed)
    document.getElementById('ws30').innerHTML = fmtSpeed(ws[0])
    document.getElementById('alt30').innerHTML = fmtLen(30)
    document.getElementById('batt30').innerHTML = fmtPct(battOut[0] + battBack[0])
    document.getElementById('ws80').innerHTML = fmtSpeed(ws[5])
    document.getElementById('alt80').innerHTML = fmtLen(80)
    document.getElementById('batt80').innerHTML = fmtPct(battOut[5] + battBack[5])
    document.getElementById('ws120').innerHTML = fmtSpeed(ws[9])
    document.getElementById('alt120').innerHTML = fmtLen(120)
    document.getElementById('batt120').innerHTML = fmtPct(battOut[9] + battBack[9])
    document.getElementById('gust30').innerHTML = fmtSpeed(estgust[0])
    document.getElementById('gust80').innerHTML = fmtSpeed(estgust[5])
    document.getElementById('gust120').innerHTML = fmtSpeed(estgust[9])
    document.getElementById('wd30').innerHTML = (wd[0]).toFixed(0)
    document.getElementById('wd80').innerHTML = (wd[5]).toFixed(0)
    document.getElementById('wd120').innerHTML = (wd[9]).toFixed(0)
    document.getElementById('timefore30').innerHTML = formatDuration(timeupdown[0]+timehor[0])
    document.getElementById('timeback30').innerHTML = formatDuration(timeupdownback[0]+timehorb[0])
    document.getElementById('timefore80').innerHTML = formatDuration(timeupdown[5]+timehor[5])
    document.getElementById('timeback80').innerHTML = formatDuration(timeupdownback[5]+timehorb[5])
    document.getElementById('timefore120').innerHTML = formatDuration(timeupdown[9]+timehor[9])
    document.getElementById('timeback120').innerHTML = formatDuration(timeupdownback[9]+timehorb[9])

    var unsafeReasonBuilding = "Below the minimum safe height above buildings on this route (min " + fmtLen(minSafeAltitude) + ").";
    var unsafeReasonGust = "Estimated gust here is at or above this drone's rated wind resistance (" + fmtSpeed(windResistance) + ").";
    var unsafeReasonCrossOut = "The crosswind component here is at or above this drone's outbound speed - it couldn't hold this course.";
    var unsafeReasonCrossBack = "The crosswind component here is at or above this drone's return speed - it couldn't hold this course.";
    var unsafeReasonHead = "The headwind here is at or above this drone's speed for this leg - it would barely move forward, if at all.";
    var unsafeReasonTerrain = "Holding this height above the terrain would take the drone more than " + fmtLen(MAX_AGL_M) + " above the ground somewhere on this route (the ground drops away faster than it can descend).";
    var unsafeReasonLegal = "Above the legal height limit here (" + rules.profile.maxAglLabel + " above ground in " + (rules.fallback ? "Israel's rules, used as the default" : rules.profile.country) + "). Tick \"I have authorization to fly higher\" in the drone settings if you have a permit.";
    function cellReason(idx, crosswindOk, crossMsg, headwindOk, terrainOk){
        if (!legalOk[idx]) return unsafeReasonLegal;
        if (!buildingOk[idx]) return unsafeReasonBuilding;
        if (!windResOk[idx]) return unsafeReasonGust;
        if (!crosswindOk) return crossMsg;
        if (headwindOk === false) return unsafeReasonHead;
        if (terrainOk === false) return unsafeReasonTerrain;
        return '';
    }
    var unsafeNoteEl = document.getElementById('unsafeReasonNote')
    if (unsafeNoteEl) unsafeNoteEl.style.display = 'none'
    markUnsafe('timefore30', !flyableOut[0], cellReason(0, crosswindOkOut[0], unsafeReasonCrossOut, headwindOkOut[0], terrainOkOut[0]))
    markUnsafe('timeback30', !flyableBack[0], cellReason(0, crosswindOkBack[0], unsafeReasonCrossBack, headwindOkBack[0], terrainOkBack[0]))
    markUnsafe('timefore80', !flyableOut[5], cellReason(5, crosswindOkOut[5], unsafeReasonCrossOut, headwindOkOut[5], terrainOkOut[5]))
    markUnsafe('timeback80', !flyableBack[5], cellReason(5, crosswindOkBack[5], unsafeReasonCrossBack, headwindOkBack[5], terrainOkBack[5]))
    markUnsafe('timefore120', !flyableOut[9], cellReason(9, crosswindOkOut[9], unsafeReasonCrossOut, headwindOkOut[9], terrainOkOut[9]))
    markUnsafe('timeback120', !flyableBack[9], cellReason(9, crosswindOkBack[9], unsafeReasonCrossBack, headwindOkBack[9], terrainOkBack[9]))
    markUnsafe('ws30', !crosswindOkOut[0] || !crosswindOkBack[0], "The crosswind component here is at or above this drone's speed for at least one leg.")
    markUnsafe('ws80', !crosswindOkOut[5] || !crosswindOkBack[5], "The crosswind component here is at or above this drone's speed for at least one leg.")
    markUnsafe('ws120', !crosswindOkOut[9] || !crosswindOkBack[9], "The crosswind component here is at or above this drone's speed for at least one leg.")
    markUnsafe('gust30', !windResOk[0], unsafeReasonGust)
    markUnsafe('gust80', !windResOk[5], unsafeReasonGust)
    markUnsafe('gust120', !windResOk[9], unsafeReasonGust)

    renderRulesInfo(rules, legalCapM, altPermit)

    var terrainInfo = document.getElementById('terrainInfo')
    terrainInfo.classList.remove('warning-hint')
    if (!terrainAvailable){
        terrainInfo.innerHTML = "\u26A0\uFE0F Couldn't load terrain elevation for this route, so hills and valleys along the way aren't being checked &mdash; the heights shown are above the takeoff point only, which is not safe over rising ground. The flight-plan download is disabled until terrain loads. <button class=\"btn btn-ghost btn-inline\" onclick=\"getHeight()\">Try again</button>"
        terrainInfo.classList.add('warning-hint')
        renderTerrainProfile(null)
    } else {
        var gMin = Infinity, gMax = -Infinity
        terrainSamples.forEach(function(p){ gMin = Math.min(gMin, p.g); gMax = Math.max(gMax, p.g) })
        var gStart = terrainSamples[0].g, gEnd = terrainSamples[terrainSamples.length - 1].g
        // The plan-specific sentence and the side view are added by
        // renderPlan(), so switching plans doesn't need a recalculation.
        var terrainBaseText = "Ground along the route: " + fmtLen(gMin) + "\u2013" + fmtLen(gMax) + " above sea level (start " + fmtLen(gStart) + ", destination " + fmtLen(gEnd) + "). Heights are above the ground: the drone always stays at least that high above it and never more than " + fmtLen(MAX_AGL_M) + " above it."
    }
    terrainInfo.style.display = 'block'

    var buildingInfo = document.getElementById('buildingInfo')
    buildingInfo.classList.remove('warning-hint')
    if (buildings === null){
        buildingInfo.innerHTML = "Couldn't load building data from OpenStreetMap for this route, so only wind is being checked right now &mdash; heights below 30 m above nearby buildings might not actually be safe. <button class=\"btn btn-ghost btn-inline\" onclick=\"getHeight()\">Try again</button>"
        buildingInfo.classList.add('warning-hint')
    } else if (buildings.count === 0){
        buildingInfo.innerHTML = "No buildings found near this route in OpenStreetMap, so no extra height is needed for obstacle clearance."
    } else if (onRouteBuildings.length === 0){
        buildingInfo.innerHTML = "Checked " + buildings.count + " building" + (buildings.count===1?'':'s') + " from OpenStreetMap near this route, but none of them are actually on the direct line, so none affect this route's altitude or path. Buildings are shown in faint orange on the map for reference."
    } else {
        if (maxBuildingHeight > 0){
            buildingInfo.innerHTML = "Checked " + buildings.count + " building" + (buildings.count===1?'':'s') + " from OpenStreetMap near this route, " + onRouteBuildings.length + " of which " + (onRouteBuildings.length===1?'sits':'sit') + " on the direct line &mdash; the tallest one we still climb over is about " + fmtLen(maxBuildingHeight) + ", so we won't recommend flying below " + fmtLen(minSafeAltitude) + ". Buildings are shown in faint orange on the map for reference."
        } else {
            buildingInfo.innerHTML = "Checked " + buildings.count + " building" + (buildings.count===1?'':'s') + " from OpenStreetMap near this route, " + onRouteBuildings.length + " of which " + (onRouteBuildings.length===1?'sits':'sit') + " on the direct line &mdash; none of them need extra height, since the route detours around " + (onRouteBuildings.length===1?'it':'them') + " instead. Buildings are shown in faint orange on the map for reference."
        }

        if (avoidedForSimplicity.length > 0){
            var simplicityNote = document.createElement('span')
            simplicityNote.innerHTML = ' ' + avoidedForSimplicity.length + ' building' + (avoidedForSimplicity.length===1?' is':'s are') + ' directly on the route and could be climbed over, but with only ' + onRouteBuildings.length + ' on the direct line it\'s simpler (and lets you fly lower) to detour sideways around ' + (avoidedForSimplicity.length===1?'it':'them') + " instead, with a " + fmtLen(BUILDING_LATERAL_SAFETY_MARGIN_M) + ' clearance.'
            buildingInfo.appendChild(simplicityNote)
        }

        if (tooTallOnRoute.length > 0){
            var tallestTooTall = tooTallOnRoute.reduce(function(m, b){ return Math.max(m, b.height); }, 0)
            var ceilingNote = (effectiveCeilingM < legalCapM)
                ? (' the ' + fmtLen(effectiveCeilingM) + ' ceiling that today\'s wind allows (below the ' + fmtLen(legalCapM) + ' height limit)')
                : (' the ' + fmtLen(legalCapM) + ' height limit')
            var tooTallNote = document.createElement('span')
            tooTallNote.innerHTML = ' ' + tooTallOnRoute.length + ' building' + (tooTallOnRoute.length===1?' is':'s are') + ' taller than' + ceilingNote + ' (up to about ' + fmtLen(tallestTooTall) + ') \u2014 climbing over ' + (tooTallOnRoute.length===1?'it':'them') + " isn't possible within that limit, so the route is detoured sideways around " + (tooTallOnRoute.length===1?'it':'them') + ' instead, with a ' + fmtLen(BUILDING_LATERAL_SAFETY_MARGIN_M) + ' clearance.'
            buildingInfo.appendChild(tooTallNote)
        }

        if (routeLeftCheckedBuildingArea){
            var buildingCorridorWarning = document.createElement('span')
            buildingCorridorWarning.className = 'warning-hint'
            buildingCorridorWarning.innerHTML = ' Routing around a tall building swings the route about ' + fmtLen(buildingRouteDeviationM) + ' from the hazard-avoidance path \u2014 further than the ' + fmtLen(buildingHalfWidthUsed) + ' either side that was actually checked for buildings around it, so the recommended height may not account for a taller building further out along that swing.'
            buildingInfo.appendChild(buildingCorridorWarning)
        }
    }
    buildingInfo.style.display = 'block'

    var hazardInfo = document.getElementById('hazardInfo')
    hazardInfo.classList.remove('warning-hint')
    if (hazardData === null){
        hazardInfo.innerHTML = "Couldn't load restricted-area data from OpenStreetMap, so schools, hospitals, power infrastructure, airports and other restricted sites along this route aren't being checked right now. The map servers may be busy - trying again in a minute usually works. <button class=\"btn btn-ghost btn-inline\" onclick=\"getHeight()\">Try again</button>"
        hazardInfo.classList.add('warning-hint')
    } else if (hazards.length === 0){
        hazardInfo.innerHTML = "No schools, hospitals, power infrastructure, airports or other restricted sites found near this route in OpenStreetMap."
    } else {
        var detourText = avoidance.hazardsAvoided > 0
            ? "The route on the map now detours around " + avoidance.hazardsAvoided + " of them."
            : "The straight-line route already clears all of them."
        hazardInfo.innerHTML = "Found " + hazards.length + " restricted area" + (hazards.length===1?'':'s') + " (schools, hospitals, power infrastructure, airports and more) near this route, marked in red on the map. " + detourText

        var trappedList = avoidance.trapped || []
        if (trappedList.length > 0){
            var trappedNames = trappedList.map(function(t){
                var label = HAZARD_TYPE_LABEL[t.type] || 'restricted area'
                if (t.name) label += ' (' + escapeHtml(t.name) + ')'
                var where = (t.atStart && t.atDest) ? 'start and destination' : (t.atStart ? 'start point' : 'destination point')
                return label + ' at the ' + where
            })
            var trappedWarning = document.createElement('span')
            trappedWarning.className = 'warning-hint'
            trappedWarning.innerHTML = ' Your ' + trappedNames.join(', and your ') + ' is within its normal clearance distance \u2014 taking off or landing there is fine, but the route can only steer clear of it once it\'s away from that point.'
            hazardInfo.appendChild(trappedWarning)
        }

        if (routeLeftCheckedArea){
            var corridorWarning = document.createElement('span')
            corridorWarning.className = 'warning-hint'
            corridorWarning.innerHTML = ' To dodge these, the route swings about ' + fmtLen(routeDeviationM) + ' from the straight line \u2014 further than the ' + fmtLen(hazardHalfWidthUsed) + ' either side that was actually checked, so schools/hospitals/etc. further out along that swing may not be accounted for. Double-check that stretch of the route yourself before flying it.'
            hazardInfo.appendChild(corridorWarning)
        }
    }
    hazardInfo.style.display = 'block'

    var flyWarning = document.getElementById('flyWarning')
    var savingsText = document.getElementById('savingsText')

    if (minhor!==-1 && minhorb!==-1){
        flyWarning.style.display = 'none'

        // Baseline: the highest height that's legal and flyable on both
        // legs - the "just go high" choice most pilots would make.
        var baseIdx = -1
        for (i=0;i<heights.length; i++) if (flyableOut[i] && flyableBack[i]) baseIdx = i
        travel120 = baseIdx === -1 ? Infinity : timeupdown[baseIdx]+timeupdownback[baseIdx]+timehor[baseIdx]+timehorb[baseIdx]
        travelopt=timeupdown[minhor]+timehor[minhor]+timeupdownback[minhorb]+timehorb[minhorb]
        savingsText.style.display = isFinite(travel120) ? '' : 'none'
        if (baseIdx !== -1){
            document.getElementById('baselineHeight').textContent = fmtLen(heights[baseIdx])
            var battSave = (battOut[baseIdx] + battBack[baseIdx]) - (battOut[minhor] + battBack[minhorb])
            document.getElementById('battSaving').textContent = (isFinite(battSave) && battSave >= 0.5) ? ' and about ' + battSave.toFixed(0) + '% of a battery' : ''
            document.getElementById('timenowind').innerHTML = formatDuration(timeupdown[baseIdx]+timeupdownback[baseIdx]+(routeDist / speedhorizontal)+(routeDist / speedhorizontalback))
        }

        document.getElementById('savesec').innerHTML = formatDuration(travel120-travelopt, 1)
        document.getElementById('totaltime120').innerHTML = formatDuration(travel120)
        document.getElementById('savepercent').innerHTML = "(" +((travel120-travelopt)/travel120*100).toFixed(2) +"%)"
    } else {
        savingsText.style.display = 'none'
        var legs = []
        if (minhor===-1) legs.push('outbound')
        if (minhorb===-1) legs.push('return')

        var reasonBits = []
        if (minSafeAltitude > legalCapM){
            reasonBits.push("buildings along the route need about " + fmtLen(minSafeAltitude) + " of clearance, above the " + fmtLen(legalCapM) + " height limit")
        }
        var gustBlocksAll = true
        for (i=0;i<heights.length; i++){
            if (windResOk[i]) gustBlocksAll = false
        }
        if (gustBlocksAll){
            reasonBits.push("estimated gusts meet or beat this drone's " + fmtSpeed(windResistance) + " wind resistance at every height we can still check")
        }
        var crosswindBlocksOut = true, crosswindBlocksBack = true
        for (i=0;i<heights.length; i++){
            if (crosswindOkOut[i]) crosswindBlocksOut = false
            if (crosswindOkBack[i]) crosswindBlocksBack = false
        }
        if ((legs.indexOf('outbound')>-1 && crosswindBlocksOut) || (legs.indexOf('return')>-1 && crosswindBlocksBack)){
            reasonBits.push("the crosswind meets or beats the drone's speed at every height we can still check, so it couldn't hold course")
        }
        var headBlocksOut = true, headBlocksBack = true
        for (i=0;i<heights.length; i++){
            if (headwindOkOut[i]) headBlocksOut = false
            if (headwindOkBack[i]) headBlocksBack = false
        }
        if ((legs.indexOf('outbound')>-1 && headBlocksOut) || (legs.indexOf('return')>-1 && headBlocksBack)){
            reasonBits.push("the headwind meets or beats the drone's speed at every height we can still check, so it wouldn't make headway")
        }
        var terrainBlocksOut = true, terrainBlocksBack = true
        for (i=0;i<heights.length; i++){
            if (terrainOkOut[i]) terrainBlocksOut = false
            if (terrainOkBack[i]) terrainBlocksBack = false
        }
        if ((legs.indexOf('outbound')>-1 && terrainBlocksOut) || (legs.indexOf('return')>-1 && terrainBlocksBack)){
            reasonBits.push("the terrain changes too steeply to stay between the minimum clearance and " + fmtLen(MAX_AGL_M) + " above ground")
        }
        if (reasonBits.length===0){
            reasonBits.push("no height between 30 and 120 m clears the buildings, the gusts, and the crosswind on this route")
        }

        flyWarning.innerHTML = "We can't recommend a safe height for the " + legs.join(' and ') + " leg: " + reasonBits.join(' and ') + ". Consider a faster drone, a different time, or don't fly."
        flyWarning.style.display = 'block'
    }

    document.getElementById('visibility').innerHTML = unitsImperial ? (visibility / MILE_M).toFixed(0) + ' mi' : (visibility/1000).toFixed(0) + ' km'
    document.getElementById('precipitation').innerHTML = unitsImperial ? (precipitation / 25.4).toFixed(2) + ' in' : precipitation.toFixed(1) + ' mm'
    document.getElementById('temperature').innerHTML = (typeof temperatureC === 'number') ? (unitsImperial ? (temperatureC * 9 / 5 + 32).toFixed(0) + '\u00B0F' : temperatureC.toFixed(0) + '\u00B0C') : '\u2014'
    document.getElementById('precipitation_probability').innerHTML = precipitation_probability.toFixed(0)

    var rainWarning = document.getElementById('rainWarning')
    if (precipitation > 0.2 || precipitation_probability >= 50){
        rainWarning.innerHTML = "\u26A0\uFE0F Rain is likely on this route (" + precipitation_probability.toFixed(0) + "% chance, " + precipitation.toFixed(1) + " mm) &mdash; flying in rain can be dangerous: it can short-circuit electronics, reduce visibility and control, and make surfaces slippery on landing. Consider waiting for drier conditions."
        rainWarning.style.display = 'block'
    } else if (precipitation > 0 || precipitation_probability >= 20){
        rainWarning.innerHTML = "\u26A0\uFE0F There's some chance of rain on this route (" + precipitation_probability.toFixed(0) + "% chance) &mdash; keep an eye on conditions before flying."
        rainWarning.style.display = 'block'
    } else {
        rainWarning.style.display = 'none'
    }

    renderCompassRose(outboundHeading, [
        {h: 20, wd: wd[0]},
        {h: 80, wd: wd[5]},
        {h: 120, wd: wd[9]}
    ]);

    // ---- Plans: fastest (above) and least battery.
    var climbRunOut = speedhorizontal / speedup, descRunOut = speedhorizontal / speeddown
    var climbRunBack = speedhorizontalback / speedupback, descRunBack = speedhorizontalback / speeddownback
    var legSpecs = {
      out: { prof: profOut, flyable: flyableOut, timeV: timeupdown, timeH: timehor, batt: battOut, gs: gsOut, cross: crosswindOkOut, head: headwindOkOut,
             payload: payloadOut, hs: speedhorizontal, up: speedup, down: speeddown, samples: terrainSamples, req: reqOut, climbRun: climbRunOut, descRun: descRunOut, timingOpts: timingOptsOut },
      back: { prof: profBack, flyable: flyableBack, timeV: timeupdownback, timeH: timehorb, batt: battBack, gs: gsBack, cross: crosswindOkBack, head: headwindOkBack,
             payload: payloadBack, hs: speedhorizontalback, up: speedupback, down: speeddownback, samples: terrainBack, req: reqBack, climbRun: climbRunBack, descRun: descRunBack, timingOpts: timingOptsBack }
    }
    function nearestHeightIdx(m){
      var best = 0
      for (var j = 0; j < heights.length; j++) if (Math.abs(heights[j] - m) < Math.abs(heights[best] - m)) best = j
      return best
    }
    function evalLeg(L, idx, mode){
      if (mode === 'follow'){
        return { i: idx, mode: 'follow', prof: L.prof[idx], time: L.timeV[idx] + L.timeH[idx], batt: L.batt[idx], ok: L.flyable[idx] }
      }
      var prof = buildAltitudeProfile(L.samples, heights[idx], L.req, L.climbRun, L.descRun, 'level')
      // Holding altitude puts the drone higher above lower ground, so
      // wind limits are checked at every height it reaches, and the
      // leg's speed uses the wind at its average height.
      var top = nearestHeightIdx(Math.min(prof.maxAGL, heights[heights.length - 1]))
      if (heights[top] < prof.maxAGL - 0.5 && top < heights.length - 1) top++
      var windOk = true
      for (var j = idx; j <= top; j++) if (!(windResOk[j] && L.cross[j] && L.head[j])) windOk = false
      var w = nearestHeightIdx(prof.meanAGL)
      var timing = L.gs[w] > MIN_GROUND_SPEED_MS ? profileTiming(prof, L.samples, L.gs[w], L.up, L.down, L.timingOpts) : null
      var batt = (battModel && timing) ? batteryPct(battModel, legEnergyFromTiming(battModel, L.payload, L.hs, timing, L.up), temperatureC) : NaN
      return { i: idx, mode: 'level', prof: prof, time: timing ? timing.total : Infinity, batt: batt, ok: legalOk[idx] && buildingOk[idx] && prof.ok && windOk && !!timing }
    }
    // Every flyable (height x style) candidate per leg, scored once.
    function legCandidates(L){
      var list = []
      for (var j = 0; j < heights.length; j++){
        list.push(evalLeg(L, j, 'follow'))
        if (terrainAvailable) list.push(evalLeg(L, j, 'level'))
      }
      return list.filter(function(c){ return c.ok && isFinite(c.time) })
    }
    function pickBest(list, primary, secondary){
      var best = null
      list.forEach(function(c){
        if (!isFinite(c[primary])) return
        var tol = primary === 'batt' ? 0.05 : 0.5
        if (!best || c[primary] < best[primary] - tol || (Math.abs(c[primary] - best[primary]) <= tol && c[secondary] < best[secondary])) best = c
      })
      return best
    }
    var candOut = legCandidates(legSpecs.out), candBack = legCandidates(legSpecs.back)
    // What a pair of legs adds at the destination: the time spent
    // there (hovering, at the outbound weight), and for photo missions
    // the climb or descent between the two legs' heights.
    function pairExtras(co, cb){
      var t = dwellS
      var wh = battModel ? battModel.hoverW * Math.pow(payloadOut, 1.5) * dwellS / 3600 : NaN
      if (mission === 'photo'){
        var dz = cb.prof.pts[0].alt - co.prof.pts[co.prof.pts.length - 1].alt
        var baseBackW = battModel ? battModel.hoverW * Math.pow(payloadBack, 1.5) : NaN
        if (dz > 0){
          var tc = dz / speedupback
          t += tc
          if (battModel) wh += (baseBackW + battModel.massKg * payloadBack * 9.81 * speedupback / CLIMB_EFFICIENCY) * tc / 3600
        } else if (dz < 0){
          var td = -dz / speeddownback
          t += td
          if (battModel) wh += baseBackW * DESCENT_POWER_FACTOR * td / 3600
        }
      }
      return { time: t, batt: battModel ? batteryPct(battModel, wh, temperatureC) : NaN }
    }
    // Both legs are chosen together, since the turnaround depends on
    // the pair.
    function pickPair(primary, secondary){
      var best = null
      var tol = primary === 'batt' ? 0.05 : 0.5
      candOut.forEach(function(co){
        candBack.forEach(function(cb){
          var x = pairExtras(co, cb)
          var tot = { time: co.time + cb.time + x.time, batt: co.batt + cb.batt + x.batt }
          if (!isFinite(tot[primary])) return
          if (!best || tot[primary] < best[primary] - tol || (Math.abs(tot[primary] - best[primary]) <= tol && tot[secondary] < best[secondary])){
            best = { out: co, back: cb, time: tot.time, batt: tot.batt, totalTime: tot.time, totalBatt: tot.batt }
          }
        })
      })
      // One leg unflyable: still show the other one.
      return best || { out: pickBest(candOut, primary, secondary), back: pickBest(candBack, primary, secondary), totalTime: NaN, totalBatt: NaN }
    }
    var plans = { fast: pickPair('time', 'batt'), eco: null }
    if (battModel){
      plans.eco = pickPair('batt', 'time')
    }
    // A hold-altitude profile can rescue a leg that terrain following
    // couldn't fly; don't leave the "can't recommend" warning up then.
    if (plans.fast.out && plans.fast.back) document.getElementById('flyWarning').style.display = 'none'

    // Savings line: fastest plan vs simply flying at the highest
    // allowed, flyable height (terrain following).
    var savingsEl = document.getElementById('savingsText')
    if (plans.fast.out && plans.fast.back && typeof baseIdx === 'number' && baseIdx !== -1 && isFinite(travel120)){
        var baseX = pairExtras(evalLeg(legSpecs.out, baseIdx, 'follow'), evalLeg(legSpecs.back, baseIdx, 'follow'))
        var travelBase = travel120 + baseX.time
        var fastTotal = plans.fast.totalTime
        document.getElementById('savesec').innerHTML = formatDuration(travelBase - fastTotal, 1)
        document.getElementById('totaltime120').innerHTML = formatDuration(travelBase)
        document.getElementById('savepercent').innerHTML = "(" + ((travelBase - fastTotal) / travelBase * 100).toFixed(1) + "%)"
        var battSaveFast = (battOut[baseIdx] + battBack[baseIdx] + baseX.batt) - plans.fast.totalBatt
        document.getElementById('battSaving').textContent = (isFinite(battSaveFast) && battSaveFast >= 0.5) ? ' and about ' + battSaveFast.toFixed(0) + '% of a battery' : ''
        savingsEl.style.display = (travelBase - fastTotal) > 0.5 ? '' : 'none'
    }
    currentCalc = {
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
    }
    renderPlan()
    renderForecastStrip(json, nowHourIdx)

    updateUrlForRoute();

    // Only learn timings from fully successful lookups.
    Progress.finish(hazardData !== null && buildingData !== null && terrainAvailable);
    return;
}
