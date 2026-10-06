// Routing around restricted areas and buildings.

import { deg2rad, getDistanceFromLatLon } from './core.js';

// Distance from a circle's center to the segment p1-p2, used to test
// whether that segment cuts through the circle at all.
export function distancePointToSegment(p1, p2, point){
  var dx = p2.x - p1.x, dy = p2.y - p1.y;
  var lenSq = dx * dx + dy * dy;
  var t = lenSq === 0 ? 0 : ((point.x - p1.x) * dx + (point.y - p1.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  var cx = p1.x + t * dx, cy = p1.y + t * dy;
  var ddx = point.x - cx, ddy = point.y - cy;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}

export function segmentCrossesCircle(p1, p2, circle){
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
export function segmentBlocked(nodeA, nodeB, circles, trappedForStart, trappedForDest){
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

export var VISIBILITY_SAMPLE_POINTS = 16; // points sampled around each obstacle's clearance circle

// Which circles a point already sits inside of (closer to the center
// than the required clearance) - there's no avoiding those from here.
export function trappingCircles(point, circles){
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
export function findPathAroundCircles(start, dest, circles, trappedForStart, trappedForDest){
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
export function smoothPath(pathNodes, circles, trappedForStart, trappedForDest){
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
export function maxLateralDeviationM(path, lat1, lng1, lat2, lng2){
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

// Like maxLateralDeviationM, but measures deviation from an arbitrary
// already-computed reference path instead of a straight line - used
// to check whether a second avoidance pass (e.g. routing around
// buildings after already routing around hazards) swings further than
// the corridor that was actually queried around that first path.
export function maxPathDeviationM(path, referencePath){
  var mPerDegLat = 110540;
  var lat0 = referencePath[0].lat, lng0 = referencePath[0].lng;
  var mPerDegLng = 111320 * Math.cos(deg2rad(lat0));
  function toLocal(lat, lng){
    return { x: (lng - lng0) * mPerDegLng, y: (lat - lat0) * mPerDegLat };
  }
  var refLocal = referencePath.map(function(p){ return toLocal(p.lat, p.lng); });
  var maxDev = 0;
  path.forEach(function(p){
    var pl = toLocal(p.lat, p.lng);
    var minDist = Infinity;
    if (refLocal.length < 2){
      var dx = pl.x - refLocal[0].x, dy = pl.y - refLocal[0].y;
      minDist = Math.sqrt(dx * dx + dy * dy);
    } else {
      for (var i = 0; i < refLocal.length - 1; i++){
        var d = distancePointToSegment(refLocal[i], refLocal[i+1], pl);
        if (d < minDist) minDist = d;
      }
    }
    if (minDist > maxDev) maxDev = minDist;
  });
  return maxDev;
}

// Which of the given buildings actually sit on (within marginM of)
// the straight start->destination line, out of all the ones OSM
// returned in the search corridor. The corridor is deliberately wider
// than the route itself (see corridorHalfWidth), so most buildings it
// finds are off to the side and shouldn't affect this particular
// flight at all.
// Which of the given buildings actually sit on (within marginM of)
// the given path - an array of {lat,lng} points, in order. Passing a
// 2-point [start, destination] path checks against the straight
// line; passing an already-computed avoidance path checks against
// the actual route instead, which matters once that route detours
// away from the straight line to dodge a hazard.
// Shortest distance (meters) from (lat,lng) to any point on the
// given path. Used to check how close the route actually comes to a
// legally-restricted site (airport, military, etc.), regardless of
// the (capped) radius used for routing avoidance.
export function minDistanceFromPath(path, lat, lng){
  var mPerDegLat = 110540;
  var lat0 = path[0].lat, lng0 = path[0].lng;
  var mPerDegLng = 111320 * Math.cos(deg2rad(lat0));
  function toLocal(la, ln){ return { x: (ln - lng0) * mPerDegLng, y: (la - lat0) * mPerDegLat }; }
  var pathLocal = path.map(function(p){ return toLocal(p.lat, p.lng); });
  var target = toLocal(lat, lng);
  if (pathLocal.length < 2){
    var dx = target.x - pathLocal[0].x, dy = target.y - pathLocal[0].y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  var minD = Infinity;
  for (var i = 0; i < pathLocal.length - 1; i++){
    var d = distancePointToSegment(pathLocal[i], pathLocal[i+1], target);
    if (d < minD) minD = d;
  }
  return minD;
}

export function buildingsCrossingPath(buildingList, path, marginM){
  var mPerDegLat = 110540;
  var mPerDegLng = 111320 * Math.cos(deg2rad(path[0].lat));
  function toLocal(lat, lng){
    return { x: (lng - path[0].lng) * mPerDegLng, y: (lat - path[0].lat) * mPerDegLat };
  }
  var pathLocal = path.map(function(p){ return toLocal(p.lat, p.lng); });
  return buildingList.filter(function(b){
    var c = toLocal(b.lat, b.lng);
    for (var i = 0; i < pathLocal.length - 1; i++){
      if (distancePointToSegment(pathLocal[i], pathLocal[i+1], c) < (b.radius + marginM)) return true;
    }
    return false;
  });
}

export function computeAvoidanceRoute(lat1, lng1, lat2, lng2, obstacles){
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
