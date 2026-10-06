// The Leaflet map, its layers, and placing start/destination markers.

//Load the map when the page has finished loading.

//google.maps.event.addDomListener(window, 'load', initMap);


const map = L.map('map').setView([40.375540905462294, -74.601920573035], 14);

// Base maps: Esri World Imagery (satellite) with Esri's place-name
// overlay by default, or the standard OpenStreetMap map. The old
// direct Google tile URL wasn't a licensed way to use Google's tiles.
// OpenStreetMap is credited in every view because the buildings,
// restricted areas and place search all come from its data (ODbL).
var OSM_DATA_CREDIT = 'Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
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
    if (hz.name) label += ' \u2014 ' + escapeHtml(hz.name);
    var hazardStyle = hz.noFly
      ? { color: '#7a1620', weight: 2, dashArray: '6 4', fillColor: '#7a1620', fillOpacity: 0.28 }
      : { color: '#e6484f', weight: 2, fillColor: '#e6484f', fillOpacity: 0.22 };
    if (hz.noFly) label = '\u26A0\uFE0F ' + label;
    var hazardShape = hz.polygon
      ? L.polygon(hz.polygon.map(function(p){ return [p.lat, p.lng]; }), hazardStyle)
      : L.circle([hz.lat, hz.lng], Object.assign({ radius: hz.radius }, hazardStyle));
    hazardShape.bindTooltip(label).addTo(hazardLayer);
  }
  for (var j = 0; j < buildings.length; j++){
    var b = buildings[j];
    L.circle([b.lat, b.lng], {
      radius: b.radius,
      color: '#f2994a',
      weight: 1.5,
      fillColor: '#f2994a',
      fillOpacity: 0.16
    }).bindTooltip('Building \u2014 ~' + fmtLen(b.height) + ' tall').addTo(buildingLayer);
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
