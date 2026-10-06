// DJI WPML flight-plan export.

import { getDistanceFromLatLon } from './core.js';
import { lastRoute } from './plans.js';

// ---------------------------------------------------------------
// WPML flight-plan export
//
// Builds a DJI WPML waypoint mission (a .kmz archive containing
// wpmz/template.kml and wpmz/waylines.wpml) from the current
// recommendation, so it can be imported into DJI Pilot 2 rather than
// having to re-enter the route and altitude by hand.
//
// IMPORTANT COMPATIBILITY NOTE: WPML/DJI Pilot 2 waypoint missions
// are supported on DJI's enterprise line (Matrice 300/350 RTK, M30
// series, M3E/M3T/M3M, M3D/M3TD). Consumer drones flown with DJI Fly
// (Mavic 3 Classic, Mini 4 Pro, Air 3, Neo 2) generally do NOT import
// WPML/KMZ waypoint missions the same way, if at all - this export is
// really only expected to work end-to-end with the Matrice 300 RTK
// preset (or another enterprise-line drone entered as Custom).
// ---------------------------------------------------------------

// DJI's droneEnumValue for the handful of models that actually
// support WPML/DJI Pilot 2 waypoint missions. Everything else
// (consumer drones in our own preset list included) has no valid
// value here, so we fall back to the Matrice 300 RTK's code - the
// field is required by the format, but for an unsupported drone the
// exported file wasn't going to import into anything anyway.
export var WPML_DRONE_ENUM = {
  matrice300: { droneEnumValue: 60, droneSubEnumValue: 0 }, // M300 RTK
  m350: { droneEnumValue: 89, droneSubEnumValue: 0 },       // M350 RTK
  m30: { droneEnumValue: 67, droneSubEnumValue: 0 },        // M30
  m30t: { droneEnumValue: 67, droneSubEnumValue: 1 },       // M30T
  m3e: { droneEnumValue: 77, droneSubEnumValue: 0 },        // Mavic 3E (enterprise)
  m3t: { droneEnumValue: 77, droneSubEnumValue: 1 },        // Mavic 3T (enterprise)
  m3m: { droneEnumValue: 77, droneSubEnumValue: 2 }         // Mavic 3M (enterprise)
};
export var WPML_DEFAULT_DRONE_ENUM = WPML_DRONE_ENUM.matrice300;

export function wpmlDroneEnumFor(droneModelKey){
  return WPML_DRONE_ENUM[droneModelKey] || WPML_DEFAULT_DRONE_ENUM;
}

export function xmlEscape(s){
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The mission-config block is identical in template.kml and
// waylines.wpml (see the "common elements" section of DJI's WPML
// spec), so it's built once and reused for both.
export function wpmlMissionConfigXml(droneEnum, finishAction){
  return '' +
'  <wpml:missionConfig>\n' +
'    <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>\n' +
'    <wpml:finishAction>' + (finishAction || 'goHome') + '</wpml:finishAction>\n' +
'    <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>\n' +
'    <wpml:executeRCLostAction>hover</wpml:executeRCLostAction>\n' +
'    <wpml:takeOffSecurityHeight>20</wpml:takeOffSecurityHeight>\n' +
'    <wpml:globalTransitionalSpeed>' + 6 + '</wpml:globalTransitionalSpeed>\n' +
'    <wpml:droneInfo>\n' +
'      <wpml:droneEnumValue>' + droneEnum.droneEnumValue + '</wpml:droneEnumValue>\n' +
'      <wpml:droneSubEnumValue>' + droneEnum.droneSubEnumValue + '</wpml:droneSubEnumValue>\n' +
'    </wpml:droneInfo>\n' +
'  </wpml:missionConfig>\n';
}

// One <Placemark> per waypoint - the same shape is used in both
// files (template.kml keeps it as the editable definition, and
// waylines.wpml as the actual execution instructions).
export function wpmlPlacemarkXml(point, index, total, speedMS){
  var altitudeM = point.heightRel;
  var name = (index === 0) ? 'Start' : (index === total - 1) ? 'Destination' : ('Waypoint ' + index);
  return '' +
'      <Placemark>\n' +
'        <name>' + xmlEscape(name) + '</name>\n' +
'        <Point>\n' +
'          <coordinates>' + point.lng.toFixed(8) + ',' + point.lat.toFixed(8) + '</coordinates>\n' +
'        </Point>\n' +
'        <wpml:index>' + index + '</wpml:index>\n' +
'        <wpml:executeHeight>' + altitudeM.toFixed(1) + '</wpml:executeHeight>\n' +
'        <wpml:waypointSpeed>' + speedMS.toFixed(1) + '</wpml:waypointSpeed>\n' +
'        <wpml:waypointHeadingParam>\n' +
'          <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>\n' +
'        </wpml:waypointHeadingParam>\n' +
'        <wpml:waypointTurnParam>\n' +
'          <wpml:waypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:waypointTurnMode>\n' +
'          <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>\n' +
'        </wpml:waypointTurnParam>\n' +
'        <wpml:useStraightLine>1</wpml:useStraightLine>\n' +
'      </Placemark>\n';
}

export function buildTemplateKml(route){
  var droneEnum = wpmlDroneEnumFor(route.droneModel);
  var placemarks = route.waypoints.map(function(p, i){
    return wpmlPlacemarkXml(p, i, route.waypoints.length, route.speedMS);
  }).join('');

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
'<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.2">\n' +
'<Document>\n' +
'  <wpml:author>Flytimizer</wpml:author>\n' +
'  <wpml:createTime>' + Date.now() + '</wpml:createTime>\n' +
'  <wpml:updateTime>' + Date.now() + '</wpml:updateTime>\n' +
wpmlMissionConfigXml(droneEnum, route.finishAction) +
'  <Folder>\n' +
'    <wpml:templateType>waypoint</wpml:templateType>\n' +
'    <wpml:templateId>0</wpml:templateId>\n' +
'    <wpml:waylineCoordinateSysParam>\n' +
'      <wpml:coordinateMode>WGS84</wpml:coordinateMode>\n' +
'      <wpml:heightMode>relativeToStartPoint</wpml:heightMode>\n' +
'    </wpml:waylineCoordinateSysParam>\n' +
'    <wpml:autoFlightSpeed>' + route.speedMS.toFixed(1) + '</wpml:autoFlightSpeed>\n' +
'    <wpml:globalHeight>' + route.waypoints[0].heightRel.toFixed(1) + '</wpml:globalHeight>\n' +
'    <wpml:globalWaypointHeadingParam>\n' +
'      <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>\n' +
'    </wpml:globalWaypointHeadingParam>\n' +
'    <wpml:globalWaypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:globalWaypointTurnMode>\n' +
'    <wpml:globalUseStraightLine>1</wpml:globalUseStraightLine>\n' +
placemarks +
'  </Folder>\n' +
'</Document>\n' +
'</kml>\n';
}

export function buildWaylinesWpml(route, distanceM){
  var droneEnum = wpmlDroneEnumFor(route.droneModel);
  var placemarks = route.waypoints.map(function(p, i){
    return wpmlPlacemarkXml(p, i, route.waypoints.length, route.speedMS);
  }).join('');
  var durationS = distanceM / Math.max(route.speedMS, 0.1);

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
'<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.2">\n' +
'<Document>\n' +
wpmlMissionConfigXml(droneEnum, route.finishAction) +
'  <Folder>\n' +
'    <wpml:templateId>0</wpml:templateId>\n' +
'    <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>\n' +
'    <wpml:waylineId>0</wpml:waylineId>\n' +
'    <wpml:distance>' + distanceM.toFixed(1) + '</wpml:distance>\n' +
'    <wpml:duration>' + durationS.toFixed(1) + '</wpml:duration>\n' +
'    <wpml:autoFlightSpeed>' + route.speedMS.toFixed(1) + '</wpml:autoFlightSpeed>\n' +
placemarks +
'  </Folder>\n' +
'</Document>\n' +
'</kml>\n';
}

// Builds the .kmz (WPML) file for the current recommendation and
// triggers a browser download. Called by the "Download flight plan"
// button, which is only shown once calcHeight() has found a flyable
// outbound height (see lastRoute above).
export async function downloadWPML(missionIdx){
  if (!lastRoute || !lastRoute.missions[missionIdx || 0]){
    window.alert("There's no flyable route to export yet - calculate a route first.");
    return;
  }
  if (typeof JSZip === 'undefined'){
    window.alert("Couldn't load the file-packaging library (JSZip) - check your internet connection and try again.");
    return;
  }

  var m = lastRoute.missions[missionIdx || 0];
  var route = { waypoints: m.waypoints, speedMS: m.speedMS, finishAction: m.finishAction, droneModel: lastRoute.droneModel };
  var distanceM = 0;
  for (var i = 0; i < route.waypoints.length - 1; i++){
    distanceM += getDistanceFromLatLon(route.waypoints[i].lat, route.waypoints[i].lng, route.waypoints[i+1].lat, route.waypoints[i+1].lng);
  }

  var zip = new JSZip();
  var wpmz = zip.folder('wpmz');
  wpmz.file('template.kml', buildTemplateKml(route));
  wpmz.file('waylines.wpml', buildWaylinesWpml(route, distanceM));

  try {
    var blob = await zip.generateAsync({ type: 'blob' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = m.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 10000);
  } catch (err){
    console.error(err);
    window.alert("Couldn't build the flight-plan file - please try again.");
  }
}
