//map.js

// todo:
// if choose start and than use GPs it makes two start marker
// before calculate height test if there is start and destination
// change minimum height to be 20m
// tell the user, how much he will save if he fly at 20m, 120m
// let the user decide horizontal and vertical UAV speed

//Set up some of our variables.
//var map; //Will contain map object.
var marker = 0; ////Has the user plotted their location marker?
var lat1,lat2, lng1, lng2;
var marker1, marker2, label1, label2;

// Formats a duration given in seconds as "M min S s" (or just "S s" under a minute).
function formatDuration(totalSeconds, decimals){
  decimals = (typeof decimals === 'number') ? decimals : 0
  var sign = totalSeconds < 0 ? '-' : ''
  var abs = Math.abs(totalSeconds)
  var mins = Math.floor(abs / 60)
  var secs = abs - mins * 60
  if (mins === 0){
    return sign + secs.toFixed(decimals) + ' s'
  }
  return sign + mins + ' min ' + secs.toFixed(decimals) + ' s'
}

// Looks up a free-text place or address using OpenStreetMap's
// Nominatim geocoder (the same open data source as the buildings and
// hazard lookups above) and returns the best match's coordinates, or
// null if nothing was found. Used by the location search box next to
// "Use my location".
async function geocodeLocation(query){
  var url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(query);
  var response = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!response.ok){
    throw new Error('Location search failed: ' + response.status);
  }
  var results = await response.json();
  if (!results || results.length === 0){
    return null;
  }
  return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon), label: results[0].display_name };
}

//Function called to initialize / create the map.
//This is called when the page has loaded.

function moveToLocation(lat, lng){
  map.setView([lat, lng], 14);
  setstartloc(lat, lng)
}

// Used by the "Use my location" button: always puts the start marker
// at the given location, moving it if it already exists instead of
// leaving it in place or creating a duplicate.
function useCurrentLocationAsStart(lat, lng){
  map.setView([lat, lng], 14);
  if (marker === 0){
    setstartloc(lat, lng);
  } else {
    marker1.setLatLng([lat, lng]);
    markerLocation(1, marker1);
  }
}

function setstartloc(lat, long)
{
    if(marker === 0){ // new marker
            marker = 1;
   marker1 = new L.marker(coords = [lat, long],{draggable: true,autoPan: true}).addTo(map);
            marker1.bindTooltip("Start");  
         markerLocation(1, marker1);    
   //Listen for drag events!
   marker1.on('dragend', function(event) {
//        var latlng = event.target.getLatLng();
       markerLocation(1, marker1);  
});      
    }
//    else { //there is already marker
//     window.alert(marker)
//               markerLocation(2, marker1);  
//         }
}


//This function will get the marker's current location and then add the lat/long
//values to our textfields so that we can save the location.
function markerLocation(sd, mark){
    //Get location.
    if (sd===1)
        {
  var currentLocation = mark.getLatLng(); //getLatLng();  
  lat1 = currentLocation.lat; //latitude
  lng1 = currentLocation.lng; //longitude
        }
    else
        {
   var currentLocation = mark.getLatLng();  
   lat2 = currentLocation.lat; //latitude
   lng2 = currentLocation.lng; //longitude
        }

}

function getDistanceFromLatLon(lat1, lon1, lat2, lon2) {
  var R = 6371; // Radius of the earth in km
  var dLat = deg2rad(lat2-lat1);  // deg2rad below
  var dLon = deg2rad(lon2-lon1);
  var a =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon/2) * Math.sin(dLon/2)
    ;
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  var d = R * c * 1000; // Distance in m
  return d;
}

function deg2rad(deg) {
  return deg * (Math.PI/180)
}

function drift(){
// from Observing Boundary-Layer Winds from Hot-Air Balloon Flights 2016
// Cd is the drone drag coefficient
// rho is the air density (kg/m^3)
// A is the drone area when looking from the side (m^2)
// m is the drone mass (kg)
//////// a = cd*rho*A/2m
// v0 is the relative speed at t=0
// v(t) = 1 / (a*t+(1/v0))
}

// ---------------------------------------------------------------
// Drone presets: horizontal/ascent/descent speed (m/s), from each
// manufacturer's published spec sheet (sport/S-mode figures).
// ---------------------------------------------------------------

var DRONE_PRESETS = {
  mavic3classic: { name: 'DJI Mavic 3 Classic', hor: 21, asc: 8, des: 6, windres: 12 },
  mini4pro:      { name: 'DJI Mini 4 Pro',       hor: 16, asc: 5, des: 5, windres: 10.7 },
  air3:          { name: 'DJI Air 3',            hor: 21, asc: 10, des: 10, windres: 12 },
  matrice300:    { name: 'DJI Matrice 300 RTK',  hor: 23, asc: 6, des: 5, windres: 12 },
  evolite:       { name: 'Autel EVO Lite+',      hor: 18, asc: 5, des: 4, windres: 10.6 }
};

function updateDroneSummary(){
  var sel = document.getElementById('droneModel');
  var nameEl = document.getElementById('droneSummaryName');
  if (!sel || !nameEl) return;
  var preset = DRONE_PRESETS[sel.value];
  nameEl.textContent = preset ? preset.name : 'Custom';
}

function applyDronePreset(){
  var sel = document.getElementById('droneModel');
  var preset = DRONE_PRESETS[sel.value];
  if (preset){
    document.getElementById('hor').value = preset.hor;
    document.getElementById('asc').value = preset.asc;
    document.getElementById('des').value = preset.des;
    document.getElementById('windres').value = preset.windres;
  }
  updateDroneSummary(); // "Custom" - leave whatever the user has typed, just relabel
}

// If the person hand-edits a speed field away from the selected
// preset's value, flip the picker to "Custom" so it doesn't silently
// keep claiming to be that drone.
function checkCustom(){
  var sel = document.getElementById('droneModel');
  var preset = DRONE_PRESETS[sel.value];
  if (preset){
    var hor = parseFloat(document.getElementById('hor').value);
    var asc = parseFloat(document.getElementById('asc').value);
    var des = parseFloat(document.getElementById('des').value);
    var windres = parseFloat(document.getElementById('windres').value);
    if (hor !== preset.hor || asc !== preset.asc || des !== preset.des || windres !== preset.windres){
      sel.value = 'custom';
    }
  }
  updateDroneSummary();
}

function markUnsafe(id, unsafe, reason){
  var el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('unsafe-value', unsafe);
  el.title = unsafe ? reason : '';
}

// ---------------------------------------------------------------
// Building clearance (OpenStreetMap via the Overpass API)
//
// We ask Overpass only for buildings inside a narrow rectangle that
// hugs the straight-line route (not a big bounding box), and only for
// their tags + center point rather than full outlines - that keeps
// the download small regardless of how long the route is.
// ---------------------------------------------------------------

// The corridor half-widths below are a floor, not the final value: the
// longer the route, the more room the avoidance routing may need to
// swing sideways around hazards (and each swing risks passing close to
// an obstacle we didn't fetch because it sat outside a fixed-width
// corridor). So the actual half-width used per route grows with
// straight-line distance, capped so the Overpass query never gets
// huge. See corridorHalfWidth() below.
var BUILDING_CORRIDOR_HALF_WIDTH_M = 100; // floor - 200 m wide corridor around the route
var BUILDING_CORRIDOR_MAX_HALF_WIDTH_M = 500;
var BUILDING_CORRIDOR_DISTANCE_FRACTION = 0.05; // +50 m of half-width per km of route
var BUILDING_HEIGHT_FALLBACK_M = 7;      // ~2 storeys, used when a building has no height/levels tag
var BUILDING_TYPE_HEIGHT_M = {
  garage: 3, garages: 3, shed: 3, roof: 3, hut: 3, carport: 3,
  house: 7, residential: 7, detached: 7, terrace: 7, semidetached_house: 7, bungalow: 5,
  apartments: 12, commercial: 10, industrial: 10, retail: 8, office: 12, warehouse: 9
};
// We don't fetch building outlines (keeps the download light), so on
// the map each building is drawn as a circle sized by a rough
// footprint guess per type - for reference only, not for routing.
// Most buildings are cleared by climbing over the tallest one rather
// than steering around them (routing around every building in a dense
// area produced an impractical zigzag; a bit more altitude is simpler
// and safer than weaving between buildings at low level) - but a
// building taller than the ceiling we can actually fly at today can't
// be cleared by climbing at all (see effectiveCeilingM further down,
// which accounts for wind as well as MAX_FLIGHT_ALTITUDE_M), so those
// specific ones are routed around horizontally instead, the same way
// hazards are (see below).
var BUILDING_FOOTPRINT_FALLBACK_M = 8;
var BUILDING_TYPE_FOOTPRINT_M = {
  garage: 3, garages: 3, shed: 3, hut: 3, carport: 3, roof: 4,
  house: 7, detached: 7, semidetached_house: 6, terrace: 5, residential: 7, bungalow: 6,
  apartments: 14, commercial: 14, industrial: 18, retail: 12, office: 14, warehouse: 20
};
var MAX_FLIGHT_ALTITUDE_M = 120;          // ceiling we check up to (matches the heights[] table below)
var BUILDING_HEIGHT_SAFETY_MARGIN_M = 20; // vertical buffer added on top of a building's height when climbing over it
var BUILDING_LATERAL_SAFETY_MARGIN_M = 30; // buffer added on top of a too-tall building's footprint when routing around it

// Places that are risky to overfly: schools, kindergartens, hospitals
// and playgrounds. Unlike buildings, altitude doesn't make these
// safe to cross, so these are the ones actually routed around
// horizontally. We only know their tags + a center point (no
// footprint, to keep the download small), so each is treated as a
// circle whose radius is a rough guess by type.
var HAZARD_CORRIDOR_HALF_WIDTH_M = 220; // floor - wide enough to see nearby hazards and have room to route around them
var HAZARD_CORRIDOR_MAX_HALF_WIDTH_M = 700;
var HAZARD_CORRIDOR_DISTANCE_FRACTION = 0.06; // +60 m of half-width per km of route - hazards get more headroom than buildings since the route actually swings sideways to dodge them
var HAZARD_SAFETY_MARGIN_M = 20;        // extra buffer added on top of the estimated radius
var HAZARD_TYPE_RADIUS_M = { school: 60, kindergarten: 40, hospital: 90, playground: 30 };
var HAZARD_TYPE_LABEL = { school: 'School', kindergarten: 'Kindergarten', hospital: 'Hospital', playground: 'Playground', building: 'Tall building' };

function rad2deg(rad){
  return rad * (180 / Math.PI);
}

// Destination point at `distMeters` from (lat,lng) along `bearingDeg`
// (standard spherical "direct geodesic" formula, same Earth radius
// used elsewhere in this file).
function offsetLatLng(lat, lng, bearingDeg, distMeters){
  var R = 6371000;
  var brng = deg2rad(bearingDeg);
  var lat1r = deg2rad(lat);
  var lon1r = deg2rad(lng);
  var dOverR = distMeters / R;
  var lat2r = Math.asin(Math.sin(lat1r) * Math.cos(dOverR) + Math.cos(lat1r) * Math.sin(dOverR) * Math.cos(brng));
  var lon2r = lon1r + Math.atan2(Math.sin(brng) * Math.sin(dOverR) * Math.cos(lat1r), Math.cos(dOverR) - Math.sin(lat1r) * Math.sin(lat2r));
  return { lat: rad2deg(lat2r), lng: rad2deg(lon2r) };
}

// Half-width to actually search, given the straight-line route
// distance: the floor, plus a slice of the distance, capped at a max
// so a very long route doesn't blow up the Overpass query.
function corridorHalfWidth(distM, minHalfWidthM, maxHalfWidthM, distanceFraction){
  return Math.min(maxHalfWidthM, minHalfWidthM + distM * distanceFraction);
}

// A thin rectangle hugging the start->destination line, used as the
// Overpass search area. Falls back to a small square around the start
// point when there's no real route yet (start and destination match).
function routeCorridorPolygon(lat1, lng1, lat2, lng2, bearingDeg, halfWidthM){
  var distM = getDistanceFromLatLon(lat1, lng1, lat2, lng2);
  if (distM < 10){
    var r = Math.max(halfWidthM, 100);
    var n = offsetLatLng(lat1, lng1, 0, r);
    var e = offsetLatLng(lat1, lng1, 90, r);
    var s = offsetLatLng(lat1, lng1, 180, r);
    var w = offsetLatLng(lat1, lng1, 270, r);
    return [n, e, s, w];
  }
  var p1 = offsetLatLng(lat1, lng1, bearingDeg + 90, halfWidthM);
  var p2 = offsetLatLng(lat2, lng2, bearingDeg + 90, halfWidthM);
  var p3 = offsetLatLng(lat2, lng2, bearingDeg - 90, halfWidthM);
  var p4 = offsetLatLng(lat1, lng1, bearingDeg - 90, halfWidthM);
  return [p1, p2, p3, p4];
}

function parseMetersTag(value){
  if (value === undefined || value === null) return null;
  var n = parseFloat(String(value).replace(',', '.'));
  return isNaN(n) ? null : n;
}

// Best-effort height for a building from its OSM tags: explicit
// height, then level count (~3 m/level), then a type-based guess,
// then a generic fallback for untagged buildings.
function estimateBuildingHeight(tags){
  tags = tags || {};
  var explicit = parseMetersTag(tags.height);
  if (explicit === null) explicit = parseMetersTag(tags['building:height']);
  if (explicit !== null) return explicit;

  var levels = parseMetersTag(tags['building:levels']);
  if (levels === null) levels = parseMetersTag(tags.levels);
  if (levels !== null) return levels * 3;

  var type = (tags.building || '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(BUILDING_TYPE_HEIGHT_M, type)) return BUILDING_TYPE_HEIGHT_M[type];

  return BUILDING_HEIGHT_FALLBACK_M;
}

// Same idea as estimateBuildingHeight, but guessing how wide the
// building is on the ground, since we need that to know how far to
// steer around it.
function estimateBuildingFootprintRadius(tags){
  tags = tags || {};
  var type = (tags.building || '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(BUILDING_TYPE_FOOTPRINT_M, type)) return BUILDING_TYPE_FOOTPRINT_M[type];
  return BUILDING_FOOTPRINT_FALLBACK_M;
}

function classifyHazard(tags){
  tags = tags || {};
  if (tags.amenity === 'school') return 'school';
  if (tags.amenity === 'kindergarten') return 'kindergarten';
  if (tags.amenity === 'hospital') return 'hospital';
  if (tags.leisure === 'playground') return 'playground';
  return null;
}

// Overpass gives nodes their own lat/lon directly, and ways/relations
// a bounding-box "center" when queried with "out ... center;".
function elementLatLng(el){
  if (typeof el.lat === 'number' && typeof el.lon === 'number') return { lat: el.lat, lng: el.lon };
  if (el.center) return { lat: el.center.lat, lng: el.center.lon };
  return null;
}

function polygonToStr(polygon){
  return polygon.map(function(p){ return p.lat + ' ' + p.lng; }).join(' ');
}

// One Overpass call for both building heights and hazard zones, each
// with its own (differently sized) corridor, tags + center only - no
// full geometries - so the download stays small and quick even when
// the route is long.
// overpass-api.de (the main public instance) can be slow when the
// query area is large - since we now widen the search corridor for
// longer routes, that made 504s from the frontend proxy more common.
// [timeout:N] below asks Overpass itself for a bigger execution
// budget, OVERPASS_FETCH_TIMEOUT_MS gives the fetch a little more
// headroom than that so we don't cut it off first, and a second
// public mirror is tried if the first one fails or times out.
var OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
var OVERPASS_QUERY_TIMEOUT_S = 45;
var OVERPASS_FETCH_TIMEOUT_MS = (OVERPASS_QUERY_TIMEOUT_S + 15) * 1000;

async function fetchOverpass(query){
  var lastErr = null;
  for (var i = 0; i < OVERPASS_ENDPOINTS.length; i++){
    var controller = new AbortController();
    var timer = setTimeout(function(){ controller.abort(); }, OVERPASS_FETCH_TIMEOUT_MS);
    try {
      var response = await fetch(OVERPASS_ENDPOINTS[i], {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response.ok){
        lastErr = new Error('Overpass request failed: ' + response.status);
        continue; // try the next mirror
      }
      return await response.json();
    } catch (err){
      clearTimeout(timer);
      lastErr = err; // network error or our own abort - try the next mirror
    }
  }
  throw lastErr || new Error('Overpass request failed');
}

async function getOsmDataNearRoute(lat1, lng1, lat2, lng2, bearingDeg){
  var distM = getDistanceFromLatLon(lat1, lng1, lat2, lng2);
  var buildingHalfWidth = corridorHalfWidth(distM, BUILDING_CORRIDOR_HALF_WIDTH_M, BUILDING_CORRIDOR_MAX_HALF_WIDTH_M, BUILDING_CORRIDOR_DISTANCE_FRACTION);
  var hazardHalfWidth = corridorHalfWidth(distM, HAZARD_CORRIDOR_HALF_WIDTH_M, HAZARD_CORRIDOR_MAX_HALF_WIDTH_M, HAZARD_CORRIDOR_DISTANCE_FRACTION);
  var buildingPoly = polygonToStr(routeCorridorPolygon(lat1, lng1, lat2, lng2, bearingDeg, buildingHalfWidth));
  var hazardPoly = polygonToStr(routeCorridorPolygon(lat1, lng1, lat2, lng2, bearingDeg, hazardHalfWidth));

  var query = '[out:json][timeout:' + OVERPASS_QUERY_TIMEOUT_S + '];(' +
    'way["building"](poly:"' + buildingPoly + '");' +
    'node["amenity"~"^(school|kindergarten|hospital)$"](poly:"' + hazardPoly + '");' +
    'way["amenity"~"^(school|kindergarten|hospital)$"](poly:"' + hazardPoly + '");' +
    'relation["amenity"~"^(school|kindergarten|hospital)$"](poly:"' + hazardPoly + '");' +
    'node["leisure"="playground"](poly:"' + hazardPoly + '");' +
    'way["leisure"="playground"](poly:"' + hazardPoly + '");' +
    ');out tags center;';

  var data = await fetchOverpass(query);
  var elements = data.elements || [];

  var buildingCount = 0;
  var maxHeight = 0;
  var buildingList = [];
  var hazards = [];

  for (var i = 0; i < elements.length; i++){
    var tags = elements[i].tags || {};
    if (tags.building){
      buildingCount++;
      var h = estimateBuildingHeight(tags);
      if (h > maxHeight) maxHeight = h;
      var bpos = elementLatLng(elements[i]);
      if (bpos){
        buildingList.push({ lat: bpos.lat, lng: bpos.lng, height: h, radius: estimateBuildingFootprintRadius(tags) });
      }
    }
    var hazardType = classifyHazard(tags);
    if (hazardType){
      var pos = elementLatLng(elements[i]);
      if (pos){
        var hazardRadius = HAZARD_TYPE_RADIUS_M[hazardType];
        hazards.push({ lat: pos.lat, lng: pos.lng, type: hazardType, name: tags.name || null, radius: hazardRadius, clearance: hazardRadius + HAZARD_SAFETY_MARGIN_M });
      }
    }
  }

  return {
    buildings: { count: buildingCount, maxHeight: maxHeight, list: buildingList },
    hazards: hazards,
    buildingHalfWidthUsed: buildingHalfWidth,
    hazardHalfWidthUsed: hazardHalfWidth
  };
}

// Distance from a circle's center to the segment p1-p2, used to test
// whether that segment cuts through the circle at all.
function distancePointToSegment(p1, p2, point){
  var dx = p2.x - p1.x, dy = p2.y - p1.y;
  var lenSq = dx * dx + dy * dy;
  var t = lenSq === 0 ? 0 : ((point.x - p1.x) * dx + (point.y - p1.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  var cx = p1.x + t * dx, cy = p1.y + t * dy;
  var ddx = point.x - cx, ddy = point.y - cy;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}

function segmentCrossesCircle(p1, p2, circle){
  // Small epsilon so a path that legitimately grazes a circle's own
  // boundary (which is how we route around it) isn't rejected due to
  // floating-point noise.
  return distancePointToSegment(p1, p2, circle) < circle.r - 0.5;
}

// True if the straight segment nodeA->nodeB is blocked by any circle,
// with two narrow exceptions: a step between two ADJACENT points
// sampled on the same circle's own boundary is allowed to graze that
// circle (that's how the path follows a boundary around); and a
// circle the start or destination point already sits inside of is
// skipped for edges touching that exact point, since no route can
// avoid a zone it has to take off or land inside of - it should still
// clear that circle everywhere else along the way.
function segmentBlocked(nodeA, nodeB, circles, trappedForStart, trappedForDest){
  var skipIdx = -1;
  if (nodeA.owner !== -1 && nodeA.owner === nodeB.owner){
    var n = VISIBILITY_SAMPLE_POINTS;
    var diff = Math.abs(nodeA.ring - nodeB.ring);
    if (Math.min(diff, n - diff) === 1) skipIdx = nodeA.owner;
  }
  var touchesStart = !!(nodeA.isStart || nodeB.isStart);
  var touchesDest = !!(nodeA.isDest || nodeB.isDest);
  for (var i = 0; i < circles.length; i++){
    if (i === skipIdx) continue;
    if (touchesStart && trappedForStart && trappedForStart.indexOf(i) !== -1) continue;
    if (touchesDest && trappedForDest && trappedForDest.indexOf(i) !== -1) continue;
    if (segmentCrossesCircle(nodeA.p, nodeB.p, circles[i])) return true;
  }
  return false;
}

var VISIBILITY_SAMPLE_POINTS = 16; // points sampled around each obstacle's clearance circle

// Which circles a point already sits inside of (closer to the center
// than the required clearance) - there's no avoiding those from here.
function trappingCircles(point, circles){
  var trapped = [];
  for (var i = 0; i < circles.length; i++){
    var dx = point.x - circles[i].x, dy = point.y - circles[i].y;
    if (Math.sqrt(dx * dx + dy * dy) < circles[i].r) trapped.push(i);
  }
  return trapped;
}

// Shortest path from `start` to `dest` around a set of circular
// obstacles, found with A* over a visibility graph: nodes are the
// start, the destination, and points sampled around each circle's
// clearance boundary; edges connect any two nodes whose straight
// line between them doesn't cross a circle. This finds a genuinely
// short route around the obstacles (as a group, not one at a time),
// rather than the zigzag you get from nudging around each obstacle
// independently.
function findPathAroundCircles(start, dest, circles, trappedForStart, trappedForDest){
  var nodes = [
    { p: start, owner: -1, ring: -1, isStart: true },
    { p: dest, owner: -1, ring: -1, isDest: true }
  ];
  for (var ci = 0; ci < circles.length; ci++){
    // Sample points sit on a slightly larger ring than the true
    // clearance radius, sized so the straight chord between two
    // adjacent samples is exactly tangent to the true circle rather
    // than cutting inside it (the "sagitta" of a chord vs its arc).
    var sampleRadius = circles[ci].r / Math.cos(Math.PI / VISIBILITY_SAMPLE_POINTS);
    for (var k = 0; k < VISIBILITY_SAMPLE_POINTS; k++){
      var ang = (k / VISIBILITY_SAMPLE_POINTS) * 2 * Math.PI;
      nodes.push({
        p: { x: circles[ci].x + sampleRadius * Math.cos(ang), y: circles[ci].y + sampleRadius * Math.sin(ang) },
        owner: ci,
        ring: k
      });
    }
  }

  var START = 0, DEST = 1;
  var n = nodes.length;

  function dist(a, b){
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  var open = [START];
  var cameFrom = {};
  var gScore = new Array(n).fill(Infinity);
  var fScore = new Array(n).fill(Infinity);
  gScore[START] = 0;
  fScore[START] = dist(nodes[START].p, nodes[DEST].p);

  while (open.length > 0){
    var bestAt = 0;
    for (var oi = 1; oi < open.length; oi++){
      if (fScore[open[oi]] < fScore[open[bestAt]]) bestAt = oi;
    }
    var current = open[bestAt];
    if (current === DEST) break;
    open.splice(bestAt, 1);

    for (var ni = 0; ni < n; ni++){
      if (ni === current) continue;
      if (segmentBlocked(nodes[current], nodes[ni], circles, trappedForStart, trappedForDest)) continue;
      var tentativeG = gScore[current] + dist(nodes[current].p, nodes[ni].p);
      if (tentativeG < gScore[ni]){
        cameFrom[ni] = current;
        gScore[ni] = tentativeG;
        fScore[ni] = tentativeG + dist(nodes[ni].p, nodes[DEST].p);
        if (open.indexOf(ni) === -1) open.push(ni);
      }
    }
  }

  if (gScore[DEST] === Infinity){
    // Shouldn't normally happen (sampled points always offer some way
    // around isolated circles), but fall back to the straight line
    // rather than fail outright.
    return [nodes[START], nodes[DEST]];
  }

  var order = [DEST];
  var cur = DEST;
  while (cur !== START){
    cur = cameFrom[cur];
    order.push(cur);
  }
  order.reverse();

  return order.map(function(idx){ return nodes[idx]; });
}

// Removes waypoints the path doesn't actually need: from each node,
// jump straight to the farthest later node still reachable in a clear
// line, skipping everything in between. Turns the graph's
// boundary-hugging step sequence into a small number of straight legs.
function smoothPath(pathNodes, circles, trappedForStart, trappedForDest){
  if (pathNodes.length <= 2) return pathNodes.map(function(nd){ return nd.p; });
  var result = [pathNodes[0].p];
  var i = 0;
  while (i < pathNodes.length - 1){
    var j = pathNodes.length - 1;
    while (j > i + 1 && segmentBlocked(pathNodes[i], pathNodes[j], circles, trappedForStart, trappedForDest)){
      j--;
    }
    result.push(pathNodes[j].p);
    i = j;
  }
  return result;
}

// Straight line by default. If it crosses any obstacle's clearance
// circle, a short detour is found with A* (see findPathAroundCircles)
// that routes around the obstacles as a group rather than nudging
// around each one in turn - which is what caused the zigzag before.
// How far (in meters) any point of `path` strays sideways from the
// straight start->destination line. Used to flag when the avoidance
// route swings wider than the corridor we actually asked OSM about,
// since anything past that width wasn't checked for buildings/hazards.
function maxLateralDeviationM(path, lat1, lng1, lat2, lng2){
  var mPerDegLat = 110540;
  var mPerDegLng = 111320 * Math.cos(deg2rad(lat1));
  function toLocal(lat, lng){
    return { x: (lng - lng1) * mPerDegLng, y: (lat - lat1) * mPerDegLat };
  }
  var startP = toLocal(lat1, lng1);
  var destP = toLocal(lat2, lng2);
  var dx = destP.x - startP.x, dy = destP.y - startP.y;
  var lineLen = Math.sqrt(dx * dx + dy * dy);
  if (lineLen < 1) return 0;
  var maxDev = 0;
  for (var i = 0; i < path.length; i++){
    var p = toLocal(path[i].lat, path[i].lng);
    var dev = Math.abs((p.x - startP.x) * dy - (p.y - startP.y) * dx) / lineLen;
    if (dev > maxDev) maxDev = dev;
  }
  return maxDev;
}

function computeAvoidanceRoute(lat1, lng1, lat2, lng2, obstacles){
  var straightDist = getDistanceFromLatLon(lat1, lng1, lat2, lng2);
  var straightPath = [{ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 }];
  var empty = { path: straightPath, distance: straightDist, buildingsAvoided: 0, hazardsAvoided: 0, trapped: [] };

  if (straightDist < 10 || !obstacles || obstacles.length === 0){
    return empty;
  }

  // Local flat-earth projection centered on the start point - fine
  // for the short distances this app targets.
  var mPerDegLat = 110540;
  var mPerDegLng = 111320 * Math.cos(deg2rad(lat1));

  function toLocal(lat, lng){
    return { x: (lng - lng1) * mPerDegLng, y: (lat - lat1) * mPerDegLat };
  }
  function toLatLng(p){
    return { lat: lat1 + p.y / mPerDegLat, lng: lng1 + p.x / mPerDegLng };
  }

  var startP = { x: 0, y: 0 };
  var destP = toLocal(lat2, lng2);

  var circles = obstacles.map(function(ob){
    var c = toLocal(ob.lat, ob.lng);
    return { x: c.x, y: c.y, r: ob.clearance, kind: ob.kind };
  });

  // Obstacles the start or destination point is already inside of -
  // no route can clear those right at that exact point (you have to
  // take off or land there), so they're excluded from "avoided" and
  // reported separately as a warning instead.
  var trappedForStart = trappingCircles(startP, circles);
  var trappedForDest = trappingCircles(destP, circles);
  var trappedAt = {};
  trappedForStart.forEach(function(i){ trappedAt[i] = trappedAt[i] || {}; trappedAt[i].atStart = true; });
  trappedForDest.forEach(function(i){ trappedAt[i] = trappedAt[i] || {}; trappedAt[i].atDest = true; });

  var crossedBuildings = 0, crossedHazards = 0;
  var trapped = [];
  for (var ci = 0; ci < circles.length; ci++){
    if (trappedAt[ci]){
      trapped.push({ type: obstacles[ci].type || null, name: obstacles[ci].name || null, kind: circles[ci].kind, atStart: !!trappedAt[ci].atStart, atDest: !!trappedAt[ci].atDest });
    } else if (segmentCrossesCircle(startP, destP, circles[ci])){
      if (circles[ci].kind === 'building') crossedBuildings++; else crossedHazards++;
    }
  }
  if (crossedBuildings === 0 && crossedHazards === 0 && trapped.length === 0){
    return empty;
  }

  var pathNodes = findPathAroundCircles(startP, destP, circles, trappedForStart, trappedForDest);
  var smoothed = smoothPath(pathNodes, circles, trappedForStart, trappedForDest);

  var path = smoothed.map(toLatLng);
  var totalDist = 0;
  for (var k = 1; k < path.length; k++){
    totalDist += getDistanceFromLatLon(path[k - 1].lat, path[k - 1].lng, path[k].lat, path[k].lng);
  }

  return { path: path, distance: totalDist, buildingsAvoided: crossedBuildings, hazardsAvoided: crossedHazards, trapped: trapped };
}

async function getJSON() {

   const apiUrl = 'https://api.open-meteo.com/v1/forecast?latitude='+lat1+'&longitude='+lng1+'&hourly=wind_speed_10m,wind_speed_80m,wind_speed_120m,wind_speed_180m,wind_direction_10m,wind_direction_80m,wind_direction_120m,wind_direction_180m,wind_gusts_10m,visibility,precipitation_probability,precipitation&forecast_days=1';

    return fetch(apiUrl)
        .then((response)=>response.json())
        .then((responseJson)=>{return responseJson});
}

// ---------------------------------------------------------------
// Visuals: altitude tape + compass rose (SVG, theme-matched)
// ---------------------------------------------------------------

var VIZ_COLORS = {
  accent: '#ff8a34',   // outbound
  accent2: '#4fd1c5',  // return / wind
  ink: '#e7ecf6',
  muted: '#8d9ab8',
  line: '#324066',
  panel: '#17223a',
  danger: '#ff5a5a'
};

// Keeps the SVG diagrams in step with the page's light/dark theme,
// which otherwise follows the OS/browser preference via CSS alone.
function refreshVizTheme(){
  var light = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  if (light){
    VIZ_COLORS.accent = '#d9670f';
    VIZ_COLORS.accent2 = '#0e8c7f';
    VIZ_COLORS.ink = '#172037';
    VIZ_COLORS.muted = '#58658a';
    VIZ_COLORS.line = '#c7cfe0';
    VIZ_COLORS.panel = '#eef1f8';
    VIZ_COLORS.danger = '#c93030';
    WIND_COLORS = ['#3355cc', '#0e8c7f', '#b8790a'];
  } else {
    VIZ_COLORS.accent = '#ff8a34';
    VIZ_COLORS.accent2 = '#4fd1c5';
    VIZ_COLORS.ink = '#e7ecf6';
    VIZ_COLORS.muted = '#8d9ab8';
    VIZ_COLORS.line = '#324066';
    VIZ_COLORS.panel = '#17223a';
    VIZ_COLORS.danger = '#ff5a5a';
    WIND_COLORS = ['#7c9cff', '#4fd1c5', '#ffd166'];
  }
}

function polarToXY(cx, cy, r, deg){
  var rad = (deg) * Math.PI / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

var WIND_COLORS = ['#7c9cff', '#4fd1c5', '#ffd166']; // 20m, 80m, 120m

// Draws a line from the center out to `length`, with a small triangular
// arrowhead at the tip pointing in the direction of travel, plus an
// optional short text label placed just past the tip.
function drawArrow(cx, cy, length, deg, color, width, label, labelOffset){
  var tip = polarToXY(cx, cy, length, deg);
  var back = polarToXY(cx, cy, length - 9, deg);
  var leftDeg = deg - 8, rightDeg = deg + 8;
  var headBase = length - 9;
  var lp = polarToXY(cx, cy, headBase, leftDeg);
  var rp = polarToXY(cx, cy, headBase, rightDeg);

  var svg = '<line x1="' + cx + '" y1="' + cy + '" x2="' + back.x + '" y2="' + back.y + '" stroke="' + color + '" stroke-width="' + width + '" stroke-linecap="round"/>' +
    '<polygon points="' + tip.x + ',' + tip.y + ' ' + lp.x + ',' + lp.y + ' ' + rp.x + ',' + rp.y + '" fill="' + color + '"/>';

  if (label){
    var lpt = polarToXY(cx, cy, length + (labelOffset || 14), deg);
    svg += '<text x="' + lpt.x + '" y="' + (lpt.y + 3) + '" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="' + color + '">' + label + '</text>';
  }
  return svg;
}

function renderCompassRose(droneDeg, windPoints){
  var el = document.getElementById('compassRose');
  if (!el) return;
  refreshVizTheme();

  var w = 220, h = 300;
  var cx = w / 2, cy = 120, r = 76;

  var ring = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + VIZ_COLORS.line + '" stroke-width="1.5"/>' +
             '<circle cx="' + cx + '" cy="' + cy + '" r="2" fill="' + VIZ_COLORS.line + '"/>';

  var labels = [0, 90, 180, 270];
  var labelText = ['0/360', '90', '180', '270'];
  var ticks = '';
  for (var i = 0; i < labels.length; i++){
    var p1 = polarToXY(cx, cy, r, labels[i]);
    var p2 = polarToXY(cx, cy, r - 8, labels[i]);
    var pt = polarToXY(cx, cy, r + 15, labels[i]);
    ticks += '<line x1="' + p1.x + '" y1="' + p1.y + '" x2="' + p2.x + '" y2="' + p2.y + '" stroke="' + VIZ_COLORS.muted + '" stroke-width="1.5"/>';
    ticks += '<text x="' + pt.x + '" y="' + (pt.y + 3) + '" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="' + VIZ_COLORS.muted + '">' + labelText[i] + '</text>';
  }

  // Wind arrows first (shorter, so the drone heading arrow sits on top
  // and always stays readable even if directions overlap). Open-Meteo
  // reports wind direction as where it blows FROM (met. convention);
  // we flip it 180 deg here so the arrow points where it's blowing
  // TO, which lines up intuitively against the drone's heading arrow
  // (same direction = tailwind, opposite = headwind).
  var windArrows = '';
  var windFlowDeg = [];
  var radii = [r * 0.45, r * 0.62, r * 0.8];
  for (var j = 0; j < windPoints.length; j++){
    var color = WIND_COLORS[j % WIND_COLORS.length];
    windFlowDeg[j] = (windPoints[j].wd + 180) % 360;
    windArrows += drawArrow(cx, cy, radii[j], windFlowDeg[j], color, 2, null, 0);
  }

  var droneArrow = drawArrow(cx, cy, r - 4, droneDeg, VIZ_COLORS.ink, 2.5, null, 0);

  // Legend: one row per series with its actual heading, since color
  // alone on an overlapping compass is hard to read at a glance. The
  // wind rows show the same "blowing to" degree as their arrow.
  var legendRows = [
    { color: VIZ_COLORS.ink, text: 'drone heading ' + droneDeg.toFixed(0) + '\u00B0' }
  ];
  var windLabels = ['wind 20m \u2192 ', 'wind 80m \u2192 ', 'wind 120m \u2192 '];
  for (var k = 0; k < windPoints.length; k++){
    legendRows.push({
      color: WIND_COLORS[k % WIND_COLORS.length],
      text: windLabels[k] + windFlowDeg[k].toFixed(0) + '\u00B0'
    });
  }

  var legendTop = h - (legendRows.length * 18) - 6;
  var legend = '<g font-family="JetBrains Mono, monospace" font-size="11">';
  for (var m = 0; m < legendRows.length; m++){
    var ly = legendTop + m * 18;
    legend += '<line x1="6" y1="' + ly + '" x2="20" y2="' + ly + '" stroke="' + legendRows[m].color + '" stroke-width="3" stroke-linecap="round"/>';
    legend += '<text x="26" y="' + (ly + 4) + '" fill="' + VIZ_COLORS.muted + '">' + legendRows[m].text + '</text>';
  }
  legend += '</g>';

  var svg =
    '<svg viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Compass showing the drone\'s outbound heading and the direction each wind is blowing toward, at 20, 80 and 120 meters">' +
      '<text x="' + cx + '" y="14" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="10" fill="' + VIZ_COLORS.muted + '">HEADING (OUT) vs WIND FLOW</text>' +
      ring + ticks + windArrows + droneArrow + legend +
    '</svg>';

  el.innerHTML = svg;
}

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
    var dronedegrees = Math.atan2(difflng, difflat) * 180 / 3.14159265;
    dronedegrees = (dronedegrees + 360) % 360;  // +360 for implementations where mod returns negative numbers
    // dronedegrees is used as-is by the headwind/crosswind formulas
    // below; for anything shown to the person, "heading" should mean
    // the outbound direction of travel, which is the opposite bearing.
    var outboundHeading = (dronedegrees + 180) % 360;
    dist=getDistanceFromLatLon(startlat,startlng,destlat, destlng);

    // Kick both network calls off together - wind from open-meteo, and
    // nearby buildings + hazard zones from OpenStreetMap's Overpass
    // API. A failed OSM lookup shouldn't block the wind calculation,
    // so it's caught locally and treated as "no data".
    const windPromise = this.getJSON();
    const osmPromise = getOsmDataNearRoute(startlat, startlng, destlat, destlng, dronedegrees)
        .catch(function(err){ console.warn('OSM lookup failed:', err); return null; });

    const json = await windPromise;  // command waits until completion
    const osmData = await osmPromise;
    const buildings = osmData ? osmData.buildings : null;
    const hazards = osmData ? osmData.hazards : [];
    const buildingList = buildings ? buildings.list : [];

    const d = new Date();
    let hour = d.getUTCHours();
    var mydata = JSON.stringify(json, null, 2);

ws10=json.hourly.wind_speed_10m[hour-1]/3.6; //array start at zero
ws80=json.hourly.wind_speed_80m[hour-1]/3.6; //array start at zero
ws120=json.hourly.wind_speed_120m[hour-1]/3.6; //array start at zero
wd10=json.hourly.wind_direction_10m[hour-1]; //array start at zero
wd80=json.hourly.wind_direction_80m[hour-1]; //array start at zero
wd120=json.hourly.wind_direction_120m[hour-1]; //array start at zero
gust10=json.hourly.wind_gusts_10m[hour-1]/3.6;
precipitation_probability=json.hourly.precipitation_probability[hour-1];
precipitation=json.hourly.precipitation[hour-1];
visibility=json.hourly.visibility[hour-1];

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

    speedup=document.getElementById('asc').value/document.getElementById('payload').value;
    speeddown=document.getElementById('des').value/document.getElementById('payload').value;
    speedhorizontal=document.getElementById('hor').value/document.getElementById('payload').value;
    speedupback=document.getElementById('asc').value/document.getElementById('payloadback').value;
    speeddownback=document.getElementById('des').value/document.getElementById('payloadback').value;
    speedhorizontalback=document.getElementById('hor').value/document.getElementById('payloadback').value;

    drag=document.getElementById('drag').value
    var windResistance = parseFloat(document.getElementById('windres').value);

    // Per-height wind figures (average speed/direction, estimated
    // gust, crosswind component, and whether that height is flyable
    // on wind grounds alone) only depend on the forecast and the
    // drone's own speeds - not on the route distance - so we can work
    // these out before we know the final (possibly detoured) route
    // length below.
    heights = [20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]
    ws = []
    wd = []
    estgust = []
    crosswind = []
    windResOk = []
    crosswindOkOut = []
    crosswindOkBack = []
    for (i=0;i<heights.length; i++) {
    if (heights[i]<80)
            {
            ws[i]=ws10*(80-heights[i])/70+ws80*(heights[i]-10)/70
            wd[i]=wd10*(80-heights[i])/70+wd80*(heights[i]-10)/70
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
   wd[i]=wd80*(120-heights[i])/40+wd120*(heights[i]-80)/40
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
    }

    // Wind alone can put a lower ceiling on today's flight than the
    // drone's altitude limit - e.g. gusts might only stay under the
    // drone's rating up to 80 m even though we normally check as high
    // as 120 m. A building only counts as "too tall to climb over"
    // once it's taller than whichever ceiling is actually flyable
    // right now (wind included), not a flat 120 m - otherwise we'd
    // recommend climbing to a height that the wind rules out anyway.
    var effectiveCeilingM = 0;
    for (i=0;i<heights.length; i++) {
        if (windResOk[i] && crosswindOkOut[i] && crosswindOkBack[i] && heights[i] > effectiveCeilingM){
            effectiveCeilingM = heights[i]
        }
    }

    // Buildings taller than that effective ceiling can't be cleared
    // by climbing today, so those go into the obstacle list and get
    // routed around horizontally, exactly like hazards. Buildings
    // within the ceiling stay in the "climb over the tallest one"
    // group - maxBuildingHeight below is only the tallest *climbable*
    // one, so a single very tall building no longer forces the whole
    // route to fail; it just gets detoured around instead.
    var climbableBuildings = [];
    var tooTallBuildings = [];
    buildingList.forEach(function(b){
      if (b.height + BUILDING_HEIGHT_SAFETY_MARGIN_M > effectiveCeilingM){
        tooTallBuildings.push(b);
      } else {
        climbableBuildings.push(b);
      }
    });
    var maxBuildingHeight = climbableBuildings.reduce(function(m, b){ return Math.max(m, b.height); }, 0);

    const obstacles = hazards.map(function(h){
      return { lat: h.lat, lng: h.lng, clearance: h.clearance, kind: 'hazard', type: h.type, name: h.name };
    }).concat(tooTallBuildings.map(function(b){
      return { lat: b.lat, lng: b.lng, clearance: b.radius + BUILDING_LATERAL_SAFETY_MARGIN_M, kind: 'building', type: 'building', name: null, height: b.height };
    }));

    const avoidance = computeAvoidanceRoute(startlat, startlng, destlat, destlng, obstacles);
    const routeDist = avoidance.distance;
    renderHazardsAndRoute(hazards, buildingList, avoidance.path);

    // The corridor width actually queried grows with route distance
    // (see corridorHalfWidth), but the avoidance routing itself can
    // still occasionally swing past it while dodging a cluster of
    // hazards - flag that so the person knows that stretch wasn't
    // fully checked, rather than silently trusting it.
    const hazardHalfWidthUsed = osmData ? osmData.hazardHalfWidthUsed : HAZARD_CORRIDOR_HALF_WIDTH_M;
    const buildingHalfWidthUsed = osmData ? osmData.buildingHalfWidthUsed : BUILDING_CORRIDOR_HALF_WIDTH_M;
    const routeDeviationM = maxLateralDeviationM(avoidance.path, startlat, startlng, destlat, destlng);
    const routeLeftCheckedArea = osmData !== null && routeDeviationM > hazardHalfWidthUsed;
    const routeLeftCheckedBuildingArea = osmData !== null && routeDeviationM > buildingHalfWidthUsed;

    // Now that we know the actual (possibly detoured) route length,
    // work out how long each leg takes at every height.
    timeupdown = []
    timeupdownback = []
    timehor = []
    timehorb = []
    for (i=0;i<heights.length; i++) {
        timeupdown[i] = (heights[i]/speedup)+(heights[i]/speeddown)
        timeupdownback[i] = (heights[i]/speedupback)+(heights[i]/speeddownback)
        diffangle=(wd[i]-dronedegrees)/180*Math.PI
        angle = Math.cos(diffangle)*drag
        timehor[i] = routeDist / (speedhorizontal+ws[i]*angle)
        timehorb[i] = routeDist / (speedhorizontalback-ws[i]*angle)
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
    var minSafeAltitude = maxBuildingHeight > 0 ? (maxBuildingHeight + BUILDING_HEIGHT_SAFETY_MARGIN_M) : 20;

    flyableOut = []
    flyableBack = []
    buildingOk = []
    for (i=0;i<heights.length; i++) {
        buildingOk[i] = heights[i] >= minSafeAltitude
        flyableOut[i] = buildingOk[i] && windResOk[i] && crosswindOkOut[i]
        flyableBack[i] = buildingOk[i] && windResOk[i] && crosswindOkBack[i]
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
    document.getElementById('heightfore').innerHTML = (minhor===-1) ? '&mdash;' : heights[minhor].toFixed(tofixed)
    document.getElementById('heightback').innerHTML = (minhorb===-1) ? '&mdash;' : heights[minhorb].toFixed(tofixed)
    document.getElementById('readoutFore').classList.toggle('unsafe', minhor===-1)
    document.getElementById('readoutBack').classList.toggle('unsafe', minhorb===-1)
    document.getElementById('distance').innerHTML = routeDist.toFixed(tofixed)
    var detourNote = document.getElementById('detourNote')
    var detourExtra = routeDist - dist
    var totalAvoided = avoidance.buildingsAvoided + avoidance.hazardsAvoided
    if (totalAvoided > 0 && detourExtra > 1){
        var avoidedParts = []
        if (avoidance.buildingsAvoided > 0) avoidedParts.push(avoidance.buildingsAvoided + ' building' + (avoidance.buildingsAvoided===1?'':'s'))
        if (avoidance.hazardsAvoided > 0) avoidedParts.push(avoidance.hazardsAvoided + ' restricted area' + (avoidance.hazardsAvoided===1?'':'s'))
        detourNote.textContent = ' (+' + detourExtra.toFixed(0) + 'm detour around ' + avoidedParts.join(' and ') + ')'
    } else {
        detourNote.textContent = ''
    }
    document.getElementById('dronedir').innerHTML = outboundHeading.toFixed(tofixed)
    // document.getElementById('windrose').innerHTML = wd[0].toFixed(tofixed)
    document.getElementById('timenowind').innerHTML = formatDuration(timeupdown[10]+timeupdownback[10]+(routeDist / speedhorizontal)+(routeDist / speedhorizontalback))
    document.getElementById('ws20').innerHTML = (ws[0]).toFixed(1)
    document.getElementById('ws80').innerHTML = (ws[6]).toFixed(1)
    document.getElementById('ws120').innerHTML = (ws[10]).toFixed(1)
    document.getElementById('gust20').innerHTML = (estgust[0]).toFixed(1)
    document.getElementById('gust80').innerHTML = (estgust[6]).toFixed(1)
    document.getElementById('gust120').innerHTML = (estgust[10]).toFixed(1)
    document.getElementById('wd20').innerHTML = (wd[0]).toFixed(0)
    document.getElementById('wd80').innerHTML = (wd[6]).toFixed(0)
    document.getElementById('wd120').innerHTML = (wd[10]).toFixed(0)
    document.getElementById('timefore20').innerHTML = formatDuration(timeupdown[0]+timehor[0])
    document.getElementById('timeback20').innerHTML = formatDuration(timeupdownback[0]+timehorb[0])
    document.getElementById('timefore80').innerHTML = formatDuration(timeupdown[6]+timehor[6])
    document.getElementById('timeback80').innerHTML = formatDuration(timeupdownback[6]+timehorb[6])
    document.getElementById('timefore120').innerHTML = formatDuration(timeupdown[10]+timehor[10])
    document.getElementById('timeback120').innerHTML = formatDuration(timeupdownback[10]+timehorb[10])

    var unsafeReasonBuilding = "Below the minimum safe height above buildings on this route (min " + minSafeAltitude.toFixed(0) + " m).";
    var unsafeReasonGust = "Estimated gust here is at or above this drone's rated wind resistance (" + windResistance.toFixed(1) + " m/s).";
    var unsafeReasonCrossOut = "The crosswind component here is at or above this drone's outbound speed - it couldn't hold this course.";
    var unsafeReasonCrossBack = "The crosswind component here is at or above this drone's return speed - it couldn't hold this course.";
    function cellReason(idx, crosswindOk, crossMsg){
        if (!buildingOk[idx]) return unsafeReasonBuilding;
        if (!windResOk[idx]) return unsafeReasonGust;
        if (!crosswindOk) return crossMsg;
        return '';
    }
    markUnsafe('timefore20', !flyableOut[0], cellReason(0, crosswindOkOut[0], unsafeReasonCrossOut))
    markUnsafe('timeback20', !flyableBack[0], cellReason(0, crosswindOkBack[0], unsafeReasonCrossBack))
    markUnsafe('timefore80', !flyableOut[6], cellReason(6, crosswindOkOut[6], unsafeReasonCrossOut))
    markUnsafe('timeback80', !flyableBack[6], cellReason(6, crosswindOkBack[6], unsafeReasonCrossBack))
    markUnsafe('timefore120', !flyableOut[10], cellReason(10, crosswindOkOut[10], unsafeReasonCrossOut))
    markUnsafe('timeback120', !flyableBack[10], cellReason(10, crosswindOkBack[10], unsafeReasonCrossBack))
    markUnsafe('ws20', !crosswindOkOut[0] || !crosswindOkBack[0], "The crosswind component here is at or above this drone's speed for at least one leg.")
    markUnsafe('ws80', !crosswindOkOut[6] || !crosswindOkBack[6], "The crosswind component here is at or above this drone's speed for at least one leg.")
    markUnsafe('ws120', !crosswindOkOut[10] || !crosswindOkBack[10], "The crosswind component here is at or above this drone's speed for at least one leg.")
    markUnsafe('gust20', !windResOk[0], unsafeReasonGust)
    markUnsafe('gust80', !windResOk[6], unsafeReasonGust)
    markUnsafe('gust120', !windResOk[10], unsafeReasonGust)

    var buildingInfo = document.getElementById('buildingInfo')
    buildingInfo.classList.remove('warning-hint')
    if (buildings === null){
        buildingInfo.innerHTML = "Couldn't load building data from OpenStreetMap for this route, so only wind is being checked right now &mdash; heights below 20 m above nearby buildings might not actually be safe."
        buildingInfo.classList.add('warning-hint')
    } else if (buildings.count === 0){
        buildingInfo.innerHTML = "No buildings found near this route in OpenStreetMap, so no extra height is needed for obstacle clearance."
    } else {
        if (maxBuildingHeight > 0){
            buildingInfo.innerHTML = "Checked " + buildings.count + " building" + (buildings.count===1?'':'s') + " from OpenStreetMap near this route &mdash; the tallest one we still climb over is about " + maxBuildingHeight.toFixed(0) + " m, so we won't recommend flying below " + minSafeAltitude.toFixed(0) + " m. Buildings are shown in faint blue on the map for reference."
        } else {
            buildingInfo.innerHTML = "Checked " + buildings.count + " building" + (buildings.count===1?'':'s') + " from OpenStreetMap near this route &mdash; none of them need extra height to clear. Buildings are shown in faint blue on the map for reference."
        }

        if (tooTallBuildings.length > 0){
            var tallestTooTall = tooTallBuildings.reduce(function(m, b){ return Math.max(m, b.height); }, 0)
            var ceilingNote = (effectiveCeilingM < MAX_FLIGHT_ALTITUDE_M)
                ? (' the ' + effectiveCeilingM.toFixed(0) + ' m ceiling that today\'s wind allows (below the usual ' + MAX_FLIGHT_ALTITUDE_M + ' m limit)')
                : (' the ' + MAX_FLIGHT_ALTITUDE_M + ' m ceiling')
            var tooTallNote = document.createElement('span')
            tooTallNote.innerHTML = ' ' + tooTallBuildings.length + ' building' + (tooTallBuildings.length===1?' is':'s are') + ' taller than' + ceilingNote + ' (up to about ' + tallestTooTall.toFixed(0) + ' m) \u2014 climbing over ' + (tooTallBuildings.length===1?'it':'them') + " isn't possible within that limit, so the route is detoured sideways around " + (tooTallBuildings.length===1?'it':'them') + ' instead.'
            buildingInfo.appendChild(tooTallNote)
        }

        if (routeLeftCheckedBuildingArea){
            var buildingCorridorWarning = document.createElement('span')
            buildingCorridorWarning.className = 'warning-hint'
            buildingCorridorWarning.innerHTML = ' The detour around nearby hazards swings about ' + routeDeviationM.toFixed(0) + ' m from the straight line \u2014 further than the ' + buildingHalfWidthUsed.toFixed(0) + ' m either side that was actually checked for buildings, so the recommended height may not account for a taller building further out along that swing.'
            buildingInfo.appendChild(buildingCorridorWarning)
        }
    }
    buildingInfo.style.display = 'block'

    var hazardInfo = document.getElementById('hazardInfo')
    hazardInfo.classList.remove('warning-hint')
    if (osmData === null){
        hazardInfo.innerHTML = "Couldn't load restricted-area data from OpenStreetMap, so schools, kindergartens, hospitals and playgrounds along this route aren't being checked right now."
        hazardInfo.classList.add('warning-hint')
    } else if (hazards.length === 0){
        hazardInfo.innerHTML = "No schools, kindergartens, hospitals or playgrounds found near this route in OpenStreetMap."
    } else {
        var detourText = avoidance.hazardsAvoided > 0
            ? "The route on the map now detours around " + avoidance.hazardsAvoided + " of them."
            : "The straight-line route already clears all of them."
        hazardInfo.innerHTML = "Found " + hazards.length + " restricted area" + (hazards.length===1?'':'s') + " (schools, kindergartens, hospitals, playgrounds) near this route, marked in red on the map. " + detourText

        var trappedList = avoidance.trapped || []
        if (trappedList.length > 0){
            var trappedNames = trappedList.map(function(t){
                var label = HAZARD_TYPE_LABEL[t.type] || 'restricted area'
                if (t.name) label += ' (' + t.name + ')'
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
            corridorWarning.innerHTML = ' To dodge these, the route swings about ' + routeDeviationM.toFixed(0) + ' m from the straight line \u2014 further than the ' + hazardHalfWidthUsed.toFixed(0) + ' m either side that was actually checked, so schools/hospitals/etc. further out along that swing may not be accounted for. Double-check that stretch of the route yourself before flying it.'
            hazardInfo.appendChild(corridorWarning)
        }
    }
    hazardInfo.style.display = 'block'

    var flyWarning = document.getElementById('flyWarning')
    var savingsText = document.getElementById('savingsText')

    if (minhor!==-1 && minhorb!==-1){
        flyWarning.style.display = 'none'
        savingsText.style.display = ''

        travel120=timeupdown[10]+timeupdownback[10]+timehor[10]+timehorb[10]
        travelopt=timeupdown[minhor]+timehor[minhor]+timeupdownback[minhorb]+timehorb[minhorb]

        document.getElementById('savesec').innerHTML = formatDuration(travel120-travelopt, 1)
        document.getElementById('totaltime120').innerHTML = formatDuration(travel120)
        document.getElementById('savepercent').innerHTML = "(" +((travel120-travelopt)/travel120*100).toFixed(2) +"%)"
    } else {
        savingsText.style.display = 'none'
        var legs = []
        if (minhor===-1) legs.push('outbound')
        if (minhorb===-1) legs.push('return')

        var reasonBits = []
        if (minSafeAltitude > 120){
            reasonBits.push("buildings along the route need about " + minSafeAltitude.toFixed(0) + " m of clearance, above the 120 m ceiling we check")
        }
        var gustBlocksAll = true
        for (i=0;i<heights.length; i++){
            if (windResOk[i]) gustBlocksAll = false
        }
        if (gustBlocksAll){
            reasonBits.push("estimated gusts meet or beat this drone's " + windResistance.toFixed(1) + " m/s wind resistance at every height we can still check")
        }
        var crosswindBlocksOut = true, crosswindBlocksBack = true
        for (i=0;i<heights.length; i++){
            if (crosswindOkOut[i]) crosswindBlocksOut = false
            if (crosswindOkBack[i]) crosswindBlocksBack = false
        }
        if ((legs.indexOf('outbound')>-1 && crosswindBlocksOut) || (legs.indexOf('return')>-1 && crosswindBlocksBack)){
            reasonBits.push("the crosswind meets or beats the drone's speed at every height we can still check, so it couldn't hold course")
        }
        if (reasonBits.length===0){
            reasonBits.push("no height between 20 and 120 m clears the buildings, the gusts, and the crosswind on this route")
        }

        flyWarning.innerHTML = "We can't recommend a safe height for the " + legs.join(' and ') + " leg: " + reasonBits.join(' and ') + ". Consider a faster drone, a different time, or don't fly."
        flyWarning.style.display = 'block'
    }

    document.getElementById('visibility').innerHTML = (visibility/1000).toFixed(0)
    document.getElementById('precipitation').innerHTML = precipitation.toFixed(1)
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
        {h: 80, wd: wd[6]},
        {h: 120, wd: wd[10]}
    ]);

    return;
}


//Load the map when the page has finished loading.

//google.maps.event.addDomListener(window, 'load', initMap);


const map = L.map('map').setView([40.375540905462294, -74.601920573035], 14);

const tiles = L.tileLayer('https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}',{
maxZoom: 20,
attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'        ,
subdomains:['mt0','mt1','mt2','mt3']
}).addTo(map);

map.attributionControl.setPrefix('Google map image') //remove flag

// Buildings, hazard zones (schools/kindergartens/hospitals/playgrounds)
// and the route around them. Cleared and redrawn on every calculation
// instead of piling up new layers each time.
var buildingLayer = L.layerGroup().addTo(map);
var hazardLayer = L.layerGroup().addTo(map);
var routeLine = L.polyline([], { color: '#2f6fed', weight: 4, opacity: 0.85 }).addTo(map);

function renderHazardsAndRoute(hazards, buildings, path){
  hazardLayer.clearLayers();
  buildingLayer.clearLayers();
  for (var i = 0; i < hazards.length; i++){
    var hz = hazards[i];
    var label = HAZARD_TYPE_LABEL[hz.type] || 'Restricted area';
    if (hz.name) label += ' \u2014 ' + hz.name;
    L.circle([hz.lat, hz.lng], {
      radius: hz.radius,
      color: '#e6484f',
      weight: 2,
      fillColor: '#e6484f',
      fillOpacity: 0.22
    }).bindTooltip(label).addTo(hazardLayer);
  }
  for (var j = 0; j < buildings.length; j++){
    var b = buildings[j];
    L.circle([b.lat, b.lng], {
      radius: b.radius,
      color: '#5c7cfa',
      weight: 1.5,
      fillColor: '#5c7cfa',
      fillOpacity: 0.12
    }).bindTooltip('Building \u2014 ~' + b.height.toFixed(0) + 'm tall').addTo(buildingLayer);
  }
  routeLine.setLatLngs(path.map(function(p){ return [p.lat, p.lng]; }));
}

map.on('click', addMarker);

function addMarker(e){
    // Add marker to map at click location; add popup window  

        if(marker === 0){
        marker=1;        
       //Create the marker.
   marker1 = new L.marker(coords = e.latlng,{draggable: true,autoPan: true ,color: 'car'}).addTo(map);
//marker1.valueOf()._icon.style.marker-color = 'red';
       marker1.bindTooltip("Start");    

       markerLocation(1, marker1);  
       //Listen for drag events!

marker1.on('dragend', function(event) {
 var latlng = event.target.getLatLng();
 markerLocation(1, marker1);
});      
    } else{
        if(marker === 1){
            marker=2;
            //Create the marker.
   marker2 = new L.marker(coords = e.latlng,{draggable: true,autoPan: true}).addTo(map);
//marker1.valueOf()._icon.style.marker-color = 'green'    
            marker2.bindTooltip("Destination");    
            markerLocation(2, marker2);
            //Listen for drag events!
     marker2.on('dragend', function(event) {
   markerLocation(2, marker2);  
});      
        } else{
            //Marker has already been added, so just change its location.
                var lat = (e.latlng.lat);
                var lng = (e.latlng.lng);
                var newLatLng = new L.LatLng(lat, lng);
                marker2.setLatLng(newLatLng);    
                markerLocation(2, marker2);  
        }
        }
}
