// The Leaflet map and its layers (restricted areas, buildings, route).

import { addMarker } from './core.js';
import { HAZARD_TYPE_LABEL } from './osm.js';
import { escapeHtml, fmtDist, fmtLen } from './units.js';

// Set by initMap(), which app.js calls once at start-up.
export let map;
export var buildingLayer, hazardLayer, routeLine, rangeLayer;

export var OSM_DATA_CREDIT = 'Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

export function initMap(){
  map = L.map('map').setView([40.375540905462294, -74.601920573035], 14);

  // Base maps: Esri World Imagery (satellite) with Esri's place-name
  // overlay by default, or the standard OpenStreetMap map. The old
  // direct Google tile URL wasn't a licensed way to use Google's tiles.
  // OpenStreetMap is credited in every view because the buildings,
  // restricted areas and place search all come from its data (ODbL).
  var satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community'
  });
  var satelliteLabels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Labels &copy; Esri'
  });
  var satelliteGroup = L.layerGroup([satelliteLayer, satelliteLabels]);
  var streetLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  });
  satelliteGroup.addTo(map);
  L.control.layers({ 'Satellite': satelliteGroup, 'Map': streetLayer }, null, { position: 'topright' }).addTo(map);
  map.attributionControl.setPrefix(OSM_DATA_CREDIT);

  // Buildings, hazard zones (schools/kindergartens/hospitals/playgrounds)
  // and the route around them. Cleared and redrawn on every calculation
  // instead of piling up new layers each time. The round-trip range
  // outline goes first, so it sits underneath the rest.
  rangeLayer = L.layerGroup().addTo(map);
  buildingLayer = L.layerGroup().addTo(map);
  hazardLayer = L.layerGroup().addTo(map);
  routeLine = L.polyline([], { color: '#2f6fed', weight: 4, opacity: 0.85 }).addTo(map);

  map.on('click', addMarker);
}

// Start over: removes the restricted areas, buildings, route and range.
export function clearRouteLayers(){
  rangeLayer.clearLayers();
  hazardLayer.clearLayers();
  buildingLayer.clearLayers();
  routeLine.setLatLngs([]);
}

export function renderHazardsAndRoute(hazards, buildings, path){
  hazardLayer.clearLayers();
  buildingLayer.clearLayers();
  for (var i = 0; i < hazards.length; i++){
    var hz = hazards[i];
    var label = HAZARD_TYPE_LABEL[hz.type] || 'Restricted area';
    if (hz.name) label += ' \u2014 ' + escapeHtml(hz.name);
    var hazardStyle = hz.noFly
      ? { color: '#7a1620', weight: 2, dashArray: '6 4', fillColor: '#7a1620', fillOpacity: 0.28 }
      : { color: '#e6484f', weight: 2, fillColor: '#e6484f', fillOpacity: 0.22 };
    if (hz.noFly) label = '\u26A0\uFE0F ' + label;
    var hazardShape = hz.polygon
      ? L.polygon(hz.polygon.map(function(p){ return [p.lat, p.lng]; }), hazardStyle)
      : L.circle([hz.lat, hz.lng], Object.assign({ radius: hz.radius }, hazardStyle));
    hazardShape.bindTooltip(label).addTo(hazardLayer);
    // The keep-out distance the route steers around, so a detour is
    // explained on the map, not just in the text. Outline only: a
    // click inside it still sets a point.
    if (hz.clearance > hz.radius + 1){
      L.circle([hz.lat, hz.lng], {
        radius: hz.clearance, color: hazardStyle.color, weight: 2.5, dashArray: '4 6', fill: false, opacity: 0.95
      }).bindTooltip(label + ' \u2014 keep-out distance ' + fmtDist(hz.buffer), { sticky: true }).addTo(hazardLayer);
    }
  }
  for (var j = 0; j < buildings.length; j++){
    var b = buildings[j];
    L.circle([b.lat, b.lng], {
      radius: b.radius,
      color: '#f2994a',
      weight: 1.5,
      fillColor: '#f2994a',
      fillOpacity: 0.16
    }).bindTooltip('Building \u2014 ~' + fmtLen(b.height) + ' tall' + (b.heightSource === 'osm' ? '' : b.heightSource === 'ghsl' ? ' (area average, GHSL)' : ' (guess)')).addTo(buildingLayer);
  }
  routeLine.setLatLngs(path.map(function(p){ return [p.lat, p.lng]; }));
  // A detour can swing well outside the view; zoom out to show the
  // whole route, clear of the map's edges and attribution line (left
  // alone when it already fits, so picking another forecast hour
  // doesn't move the map).
  if (path.length > 1){
    var routeBounds = routeLine.getBounds();
    var size = map.getSize();
    var nw = map.latLngToContainerPoint(routeBounds.getNorthWest());
    var se = map.latLngToContainerPoint(routeBounds.getSouthEast());
    if (nw.x < 20 || nw.y < 20 || se.x > size.x - 20 || se.y > size.y - 30){
      map.fitBounds(routeBounds, { paddingTopLeft: [30, 30], paddingBottomRight: [30, 40] });
    }
  }
}
