// OpenStreetMap data: building and restricted-area constants, corridor
// geometry and tag parsing, Overpass access, and the hazard/building lookups.

import { deg2rad, getDistanceFromLatLon } from './core.js';
import { Progress } from './progress.js';
import { minDistanceFromPath } from './routing.js';
import { applyRulesToHazards } from './rules.js';

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
export var BUILDING_CORRIDOR_HALF_WIDTH_M = 100; // floor - 200 m wide corridor around the route
export var BUILDING_CORRIDOR_MAX_HALF_WIDTH_M = 500;
export var BUILDING_CORRIDOR_DISTANCE_FRACTION = 0.05; // +50 m of half-width per km of route
export var BUILDING_HEIGHT_FALLBACK_M = 7;      // ~2 storeys, used when a building has no height/levels tag
export var BUILDING_TYPE_HEIGHT_M = {
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
export var BUILDING_FOOTPRINT_FALLBACK_M = 8;
export var BUILDING_TYPE_FOOTPRINT_M = {
  garage: 3, garages: 3, shed: 3, hut: 3, carport: 3, roof: 4,
  house: 7, detached: 7, semidetached_house: 6, terrace: 5, residential: 7, bungalow: 6,
  apartments: 14, commercial: 14, industrial: 18, retail: 12, office: 14, warehouse: 20
};
export var MAX_FLIGHT_ALTITUDE_M = 120;          // ceiling we check up to (matches the heights[] table below)
export var BUILDING_HEIGHT_SAFETY_MARGIN_M = 20; // vertical buffer added on top of a building's height when climbing over it
export var BUILDING_LATERAL_SAFETY_MARGIN_M = 30; // buffer added on top of a building's footprint when routing around it
export var BUILDING_AVOID_MAX_COUNT = 4; // detour around this many (or fewer) buildings actually on the route instead of climbing over them; beyond this, climbing over the tallest climbable one avoids an impractical zigzag

// Places that are risky to overfly: schools, kindergartens, hospitals,
// playgrounds, nursing homes, universities/colleges, and power
// infrastructure. Unlike buildings, altitude doesn't make these safe
// to cross, so these are the ones actually routed around
// horizontally. We ask Overpass for their real outline (out geom)
// when it has one, and fall back to a rough per-type radius guess
// when it doesn't.
export var HAZARD_CORRIDOR_HALF_WIDTH_M = 220; // floor - wide enough to see nearby hazards and have room to route around them
export var HAZARD_CORRIDOR_MAX_HALF_WIDTH_M = 700;
export var HAZARD_CORRIDOR_DISTANCE_FRACTION = 0.06; // +60 m of half-width per km of route - hazards get more headroom than buildings since the route actually swings sideways to dodge them
export var HAZARD_TYPE_RADIUS_M = {
  school: 60, kindergarten: 40, hospital: 90, playground: 30,
  nursing_home: 40, university: 120, power: 30,
  airport: 500, heliport: 50, prison: 100, embassy: 40, military: 150, military_airfield: 500
};
export var HAZARD_TYPE_LABEL = {
  school: 'School', kindergarten: 'Kindergarten', hospital: 'Hospital', playground: 'Playground',
  nursing_home: 'Nursing home', university: 'University/college', power: 'Power facility',
  airport: 'Airport/airfield', heliport: 'Heliport', prison: 'Prison', embassy: 'Embassy', military: 'Military site', military_airfield: 'Military airfield',
  building: 'Tall building'
};

export var HAZARD_ROUTING_RADIUS_CAP_M = 5000;  // sanity cap on the *total* clearance (real size + keep-out buffer) - guards against a data glitch producing an absurd radius, not meant to shrink a legitimately large site or its buffer

export function rad2deg(rad){
  return rad * (180 / Math.PI);
}

// Destination point at `distMeters` from (lat,lng) along `bearingDeg`
// (standard spherical "direct geodesic" formula, same Earth radius
// used elsewhere in this file).
export function offsetLatLng(lat, lng, bearingDeg, distMeters){
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
export function corridorHalfWidth(distM, minHalfWidthM, maxHalfWidthM, distanceFraction){
  return Math.min(maxHalfWidthM, minHalfWidthM + distM * distanceFraction);
}

// A thin rectangle hugging the start->destination line, used as the
// Overpass search area. Falls back to a small square around the start
// point when there's no real route yet (start and destination match).
export function routeCorridorPolygon(lat1, lng1, lat2, lng2, bearingDeg, halfWidthM){
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

// Flat-approximation bearing from (lat1,lng1) to (lat2,lng2), in the
// same convention as offsetLatLng (0=north, clockwise). Fine for the
// short, local distances this app deals with.
export function bearingBetween(lat1, lng1, lat2, lng2){
  var b = Math.atan2((lng2 - lng1) * Math.cos(deg2rad((lat1 + lat2) / 2)), lat2 - lat1) * 180 / Math.PI;
  return (b + 360) % 360;
}

// Buffer polygon (roughly halfWidthM on each side) around an
// arbitrary path - an array of {lat,lng} points, in order - not just
// a straight line. Used to query buildings along the *actual* route
// once it's known (which may already detour around hazards), instead
// of only around the straight line between start and destination.
export function pathCorridorPolygon(path, halfWidthM){
  if (path.length < 2){
    var p0 = path[0];
    var n = offsetLatLng(p0.lat, p0.lng, 0, halfWidthM);
    var e = offsetLatLng(p0.lat, p0.lng, 90, halfWidthM);
    var s = offsetLatLng(p0.lat, p0.lng, 180, halfWidthM);
    var w = offsetLatLng(p0.lat, p0.lng, 270, halfWidthM);
    return [n, e, s, w];
  }
  // Direction of travel at point i - the circular mean of the
  // incoming and outgoing segment bearings where both exist, so the
  // buffer doesn't pinch inward at a bend in the path.
  function bearingAt(i){
    var bIn = (i > 0) ? bearingBetween(path[i-1].lat, path[i-1].lng, path[i].lat, path[i].lng) : null;
    var bOut = (i < path.length - 1) ? bearingBetween(path[i].lat, path[i].lng, path[i+1].lat, path[i+1].lng) : null;
    if (bIn === null) return bOut;
    if (bOut === null) return bIn;
    var x = Math.cos(deg2rad(bIn)) + Math.cos(deg2rad(bOut));
    var y = Math.sin(deg2rad(bIn)) + Math.sin(deg2rad(bOut));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  var left = [];
  var right = [];
  for (var i = 0; i < path.length; i++){
    var b = bearingAt(i);
    left.push(offsetLatLng(path[i].lat, path[i].lng, b + 90, halfWidthM));
    right.push(offsetLatLng(path[i].lat, path[i].lng, b - 90, halfWidthM));
  }
  return left.concat(right.reverse());
}

export function parseMetersTag(value){
  if (value === undefined || value === null) return null;
  var n = parseFloat(String(value).replace(',', '.'));
  return isNaN(n) ? null : n;
}

// Best-effort height for a building from its OSM tags: explicit
// height, then level count (~3 m/level), then a type-based guess,
// then a generic fallback for untagged buildings.
export function estimateBuildingHeight(tags){
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
export function estimateBuildingFootprintRadius(tags){
  tags = tags || {};
  var type = (tags.building || '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(BUILDING_TYPE_FOOTPRINT_M, type)) return BUILDING_TYPE_FOOTPRINT_M[type];
  return BUILDING_FOOTPRINT_FALLBACK_M;
}

export var NOT_MILITARY_SITE = { bunker: true, trench: true, shelter: true, no: true };

export function classifyHazard(tags){
  tags = tags || {};
  if (tags.amenity === 'school') return 'school';
  if (tags.amenity === 'kindergarten') return 'kindergarten';
  if (tags.amenity === 'hospital') return 'hospital';
  if (tags.leisure === 'playground') return 'playground';
  if (tags.social_facility === 'nursing_home' || tags.amenity === 'nursing_home') return 'nursing_home';
  if (tags.amenity === 'university' || tags.amenity === 'college') return 'university';
  if (tags.power === 'substation' || tags.power === 'plant') return 'power';
  // Military airfields have their own (larger) keep-out distance.
  if (tags.military === 'airfield' || (tags.aeroway === 'aerodrome' && (tags.military || tags.landuse === 'military' || tags['aerodrome:type'] === 'military'))) return 'military_airfield';
  if (tags.aeroway === 'aerodrome') return 'airport';
  if (tags.aeroway === 'heliport') return 'heliport';
  if (tags.amenity === 'prison') return 'prison';
  if (tags.diplomatic === 'embassy') return 'embassy';
  if (tags.landuse === 'military') return 'military';
  // Bunkers and trenches are mostly public air-raid shelters (very
  // common in Israel, often tagged military=bunker) - not military
  // sites with a keep-out distance. A real base is still found through
  // its outline (landuse=military or military=base etc.).
  if (tags.military && !NOT_MILITARY_SITE[tags.military] && tags.amenity !== 'shelter') return 'military';
  return null;
}

// Overpass gives nodes their own lat/lon directly, and ways/relations
// a bounding-box "center" when queried with "out ... center;".
export function elementLatLng(el){
  if (typeof el.lat === 'number' && typeof el.lon === 'number') return { lat: el.lat, lng: el.lon };
  if (el.center) return { lat: el.center.lat, lng: el.center.lon };
  return null;
}

// Hazards are few enough per route (unlike buildings) that we ask
// Overpass for their full outline (out geom) instead of just a
// center point, so schools/hospitals/etc. can be drawn as their
// actual shape and get a tighter, real clearance radius instead of a
// guessed one. Returns an array of {lat,lng} points, or null if this
// element didn't come back with usable geometry (e.g. a bare node, or
// a relation Overpass didn't expand).
export function hazardPolygonFromElement(el){
  if (el.type === 'way' && Array.isArray(el.geometry)){
    var pts = el.geometry.filter(function(p){ return p && typeof p.lat === 'number'; })
      .map(function(p){ return { lat: p.lat, lng: p.lon }; });
    return pts.length >= 3 ? pts : null;
  }
  if (el.type === 'relation' && Array.isArray(el.members)){
    var mpts = [];
    el.members.forEach(function(m){
      if (Array.isArray(m.geometry)){
        m.geometry.forEach(function(p){
          if (p && typeof p.lat === 'number') mpts.push({ lat: p.lat, lng: p.lon });
        });
      }
    });
    return mpts.length >= 3 ? mpts : null;
  }
  return null;
}

// Centroid of a polygon's vertices, and the distance (in meters) from
// that centroid out to the farthest vertex - i.e. the smallest circle
// centered on the centroid that still fully encloses the shape. Used
// as a real, geometry-based clearance radius in place of the guessed
// per-type radius, whenever we have an actual outline to measure.
export function polygonCentroidAndRadius(points){
  var sumLat = 0, sumLng = 0;
  points.forEach(function(p){ sumLat += p.lat; sumLng += p.lng; });
  var centroid = { lat: sumLat / points.length, lng: sumLng / points.length };
  var mPerDegLat = 110540;
  var mPerDegLng = 111320 * Math.cos(deg2rad(centroid.lat));
  var maxR = 0;
  points.forEach(function(p){
    var dx = (p.lng - centroid.lng) * mPerDegLng;
    var dy = (p.lat - centroid.lat) * mPerDegLat;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d > maxR) maxR = d;
  });
  return { centroid: centroid, radius: maxR };
}

export function polygonToStr(polygon){
  return polygon.map(function(p){ return p.lat + ' ' + p.lng; }).join(' ');
}

// ---------------------------------------------------------------
// Overpass access
//
// Public Overpass servers are often overloaded, so every lookup goes
// through fetchOverpass(), which:
//  - tries several public mirrors in turn, starting with whichever
//    one answered last time (overpass.kumi.systems, used before, is
//    no longer listed as a public instance);
//  - retries the same server once after a short pause when it says
//    it's temporarily overloaded (503/504), but moves straight on to
//    the next mirror on 429 (rate limited) or a network error;
//  - treats Overpass's own "runtime error" remark as a failure. On a
//    server-side timeout Overpass still answers HTTP 200, just with a
//    remark and partial (often empty) data - taken at face value that
//    reads as "no hazards on this route", which is the worst possible
//    silent failure for a safety check;
//  - caches successful answers per exact query, so "Try again" after
//    a partial failure only re-downloads the part that failed.
// ---------------------------------------------------------------
export var OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];
export var OVERPASS_QUERY_TIMEOUT_S = 40;
export var OVERPASS_FETCH_TIMEOUT_MS = (OVERPASS_QUERY_TIMEOUT_S + 10) * 1000;
export var OVERPASS_RETRY_DELAY_MS = 2000;
export var OVERPASS_CACHE_MAX = 20;
export var overpassCache = new Map();
export var overpassPreferred = 0;

export function sleep(ms){
  return new Promise(function(resolve){ setTimeout(resolve, ms); });
}

export function overpassHost(url){
  return url.split('/')[2];
}

export async function overpassAttempt(url, query){
  var controller = new AbortController();
  var timer = setTimeout(function(){ controller.abort(); }, OVERPASS_FETCH_TIMEOUT_MS);
  try {
    var response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
      signal: controller.signal
    });
    if (!response.ok){
      var httpErr = new Error('Overpass HTTP ' + response.status + ' from ' + overpassHost(url));
      httpErr.status = response.status;
      throw httpErr;
    }
    var data = await response.json();
    if (data.remark && /runtime error|timed out|out of memory/i.test(data.remark)){
      var remarkErr = new Error('Overpass error from ' + overpassHost(url) + ': ' + data.remark);
      remarkErr.status = 'remark';
      throw remarkErr;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchOverpass(query){
  if (overpassCache.has(query)) return overpassCache.get(query);

  var lastErr = null;
  for (var k = 0; k < OVERPASS_ENDPOINTS.length; k++){
    var idx = (overpassPreferred + k) % OVERPASS_ENDPOINTS.length;
    var url = OVERPASS_ENDPOINTS[idx];
    for (var attempt = 0; attempt < 2; attempt++){
      if (k > 0 || attempt > 0){
        Progress.retrying('Map server busy — trying ' + (attempt > 0 ? 'again' : 'a backup server') + ' (' + overpassHost(url) + ')…');
      }
      try {
        var data = await overpassAttempt(url, query);
        overpassPreferred = idx;
        overpassCache.set(query, data);
        if (overpassCache.size > OVERPASS_CACHE_MAX){
          overpassCache.delete(overpassCache.keys().next().value);
        }
        return data;
      } catch (err){
        console.warn(err);
        lastErr = err;
        var transient = err.status === 503 || err.status === 504;
        if (transient && attempt === 0){
          await sleep(OVERPASS_RETRY_DELAY_MS);
          continue;
        }
        break; // next mirror
      }
    }
  }
  throw lastErr || new Error('Overpass request failed');
}

// Lat/lng bounding box of a polygon, as {s, w, n, e}.
export function polygonBBox(poly){
  var bb = { s: Infinity, w: Infinity, n: -Infinity, e: -Infinity };
  poly.forEach(function(p){
    bb.s = Math.min(bb.s, p.lat); bb.n = Math.max(bb.n, p.lat);
    bb.w = Math.min(bb.w, p.lng); bb.e = Math.max(bb.e, p.lng);
  });
  return bb;
}

export function bboxAreaKm2(bb){
  var wKm = (bb.e - bb.w) * 111.32 * Math.cos(deg2rad((bb.s + bb.n) / 2));
  var hKm = (bb.n - bb.s) * 110.54;
  return Math.abs(wKm * hKm);
}

// Hazard zones (schools/kindergartens/hospitals/playgrounds) near the
// straight start->destination line. These are looked up first,
// before we know the final route, because they're what determines
// the route's shape in the first place (buildings don't cause a
// detour - see below).
export async function getHazardsNearRoute(lat1, lng1, lat2, lng2, bearingDeg, rulesPromise){
  var distM = getDistanceFromLatLon(lat1, lng1, lat2, lng2);
  var hazardHalfWidth = corridorHalfWidth(distM, HAZARD_CORRIDOR_HALF_WIDTH_M, HAZARD_CORRIDOR_MAX_HALF_WIDTH_M, HAZARD_CORRIDOR_DISTANCE_FRACTION);
  // One global bounding box for the whole query (Overpass resolves a
  // bbox from its spatial index, far cheaper than evaluating the same
  // polygon filter in ~20 separate statements), then trimmed back to
  // the corridor below.
  var hazardCorridor = routeCorridorPolygon(lat1, lng1, lat2, lng2, bearingDeg, hazardHalfWidth);
  var bb = polygonBBox(hazardCorridor);
  var bboxStr = bb.s + ',' + bb.w + ',' + bb.n + ',' + bb.e;

  var query = '[out:json][timeout:' + OVERPASS_QUERY_TIMEOUT_S + '][bbox:' + bboxStr + '];(' +
    'nwr["amenity"~"^(school|kindergarten|hospital|university|college|prison|nursing_home)$"];' +
    'nwr["leisure"="playground"];' +
    'nwr["social_facility"="nursing_home"];' +
    'nwr["power"~"^(substation|plant)$"];' +
    'nwr["aeroway"~"^(aerodrome|heliport)$"];' +
    'nwr["diplomatic"="embassy"];' +
    'nwr["military"]["military"!~"^(bunker|trench|shelter|no)$"];' +
    'nwr["landuse"="military"];' +
    ');out geom;';

  var data = await fetchOverpass(query);
  var elements = data.elements || [];
  var hazards = [];

  for (var i = 0; i < elements.length; i++){
    var tags = elements[i].tags || {};
    var hazardType = classifyHazard(tags);
    if (hazardType){
      var polygon = hazardPolygonFromElement(elements[i]);
      var pos, hazardRadius;
      if (polygon){
        var pr = polygonCentroidAndRadius(polygon);
        pos = pr.centroid;
        // Never go below the usual radius for this hazard type - a
        // sliver of mapped outline (e.g. just one building on a big
        // school campus) shouldn't shrink the safety margin below
        // what we'd assume with no shape data at all.
        hazardRadius = Math.max(pr.radius, HAZARD_TYPE_RADIUS_M[hazardType]);
      } else {
        pos = elementLatLng(elements[i]);
        hazardRadius = HAZARD_TYPE_RADIUS_M[hazardType];
      }
      if (pos){
        // `radius` is the real (or best-guess) physical size. The
        // rule-dependent fields (buffer, clearance, noFly, warnM) are
        // added below by applyRulesToHazards, once the country is known.
        hazards.push({
          lat: pos.lat, lng: pos.lng, type: hazardType, name: tags.name || null,
          radius: hazardRadius, polygon: polygon
        });
      }
    }
  }

  var rules = await rulesPromise;
  applyRulesToHazards(hazards, rules.profile);

  // The bbox is wider than the corridor on diagonal routes; drop
  // sites whose clearance zone doesn't reach into the corridor at all
  // (no-fly sites are kept while their warning distance still does).
  var straightLine = [{ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 }];
  hazards = hazards.filter(function(h){
    var reach = h.noFly ? Math.max(h.clearance, h.radius + h.warnM) : h.clearance;
    return minDistanceFromPath(straightLine, h.lat, h.lng) <= hazardHalfWidth + reach;
  });

  return { hazards: hazards, hazardHalfWidthUsed: hazardHalfWidth };
}

// Buildings along the *actual* route: called once we already know the
// hazard-avoidance path (see getHazardsNearRoute and the first
// computeAvoidanceRoute pass in calcHeight), so a route that swings
// wide around a cluster of hazards still gets building coverage along
// that swing - not just along the straight line between start and
// destination, which a big detour can leave far behind.
export async function getBuildingsNearPath(path, straightDistM){
  var buildingHalfWidth = corridorHalfWidth(straightDistM, BUILDING_CORRIDOR_HALF_WIDTH_M, BUILDING_CORRIDOR_MAX_HALF_WIDTH_M, BUILDING_CORRIDOR_DISTANCE_FRACTION);
  var buildingPoly = polygonToStr(pathCorridorPolygon(path, buildingHalfWidth));

  var query = '[out:json][timeout:' + OVERPASS_QUERY_TIMEOUT_S + '];' +
    'way["building"](poly:"' + buildingPoly + '");' +
    'out tags center;';

  var data = await fetchOverpass(query);
  var elements = data.elements || [];

  var buildingCount = 0;
  var maxHeight = 0;
  var buildingList = [];

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
  }

  return {
    buildings: { count: buildingCount, maxHeight: maxHeight, list: buildingList },
    buildingHalfWidthUsed: buildingHalfWidth
  };
}
