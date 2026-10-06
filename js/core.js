// Shared route state, duration formatting, place search, start/destination
// markers, and the distance/bearing/wind math everything else builds on.

import { map } from './map-view.js';
import { rememberStartPoint } from './share.js';

// todo:
// if choose start and than use GPs it makes two start marker
// before calculate height test if there is start and destination
// tell the user, how much he will save if he fly at 30m, 120m
// let the user decide horizontal and vertical UAV speed

//Set up some of our variables.
export var marker = 0; ////Has the user plotted their location marker?
export var lat1,lat2, lng1, lng2;
export var marker1, marker2, label1, label2;

// Formats a duration given in seconds as "M min S s" (or just "S s" under a minute).
export function formatDuration(totalSeconds, decimals){
  decimals = (typeof decimals === 'number') ? decimals : 0
  if (!isFinite(totalSeconds)) return '\u2014' // leg can't make progress
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
export async function geocodeLocation(query){
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

export function moveToLocation(lat, lng){
  map.setView([lat, lng], 14);
  setstartloc(lat, lng)
}

// Used by the "Use my location" button: always puts the start marker
// at the given location, moving it if it already exists instead of
// leaving it in place or creating a duplicate.
export function useCurrentLocationAsStart(lat, lng){
  map.setView([lat, lng], 14);
  if (marker === 0){
    setstartloc(lat, lng);
  } else {
    marker1.setLatLng([lat, lng]);
    markerLocation(1, marker1);
  }
}

// "Use my location" button.
export function getLocation() {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(showPosition);
  } else {
    window.alert("Geolocation is not supported by this browser.");
  }
}

export function showPosition(position) {
  useCurrentLocationAsStart(position.coords.latitude, position.coords.longitude);
}

// Place search box: geocode the text and put the start point there.
export async function searchLocation() {
  var input = document.getElementById('locationSearchInput');
  var query = input.value.trim();
  if (!query) { input.focus(); return; }

  var btn = document.getElementById('locationSearchBtn');
  var originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Searching\u2026';

  try {
    var result = await geocodeLocation(query);
    if (!result) {
      window.alert('No location found for "' + query + '". Try a different search.');
      return;
    }
    useCurrentLocationAsStart(result.lat, result.lng);
  } catch (err) {
    console.error(err);
    window.alert('Something went wrong while searching for that location - please try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

export function setstartloc(lat, long)
{
    if(marker === 0){ // new marker
            marker = 1;
   marker1 = new L.marker([lat, long],{draggable: true,autoPan: true}).addTo(map);
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
export function markerLocation(sd, mark){
    //Get location.
    if (sd===1)
        {
  var currentLocation = mark.getLatLng(); //getLatLng();  
  lat1 = currentLocation.lat; //latitude
  lng1 = currentLocation.lng; //longitude
  rememberStartPoint(lat1, lng1);
        }
    else
        {
   var currentLocation = mark.getLatLng();  
   lat2 = currentLocation.lat; //latitude
   lng2 = currentLocation.lng; //longitude
        }

}

// Map click: the first click places the start, the second the
// destination, later clicks move the destination.
export function addMarker(e){
    // Add marker to map at click location; add popup window  

        if(marker === 0){
        marker=1;        
       //Create the marker.
   marker1 = new L.marker(e.latlng,{draggable: true,autoPan: true ,color: 'car'}).addTo(map);
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
   marker2 = new L.marker(e.latlng,{draggable: true,autoPan: true}).addTo(map);
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

// Places (or moves) the destination marker - the programmatic twin
// of the second map click in addMarker().
export function setDestination(lat, lng){
  if (marker === 0) return;
  if (marker === 1){
    marker = 2;
    marker2 = new L.marker([lat, lng], { draggable: true, autoPan: true }).addTo(map);
    marker2.bindTooltip('Destination');
    marker2.on('dragend', function(){ markerLocation(2, marker2); });
  } else {
    marker2.setLatLng([lat, lng]);
  }
  markerLocation(2, marker2);
}

export function getDistanceFromLatLon(lat1, lon1, lat2, lon2) {
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

export function deg2rad(deg) {
  return deg * (Math.PI/180)
}

// True initial bearing (0=north, clockwise) from point 1 to point 2.
// Unlike a raw atan2 on lat/lng differences, this accounts for
// longitude degrees shrinking with latitude (~15% at 32N).
export function trueBearing(lat1, lng1, lat2, lng2){
  var p1 = deg2rad(lat1), p2 = deg2rad(lat2), dl = deg2rad(lng2 - lng1);
  var y = Math.sin(dl) * Math.cos(p2);
  var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Interpolates between two directions (degrees) as unit vectors, so
// 350 and 10 average to 0 rather than 180.
export function interpDir(d1, d2, t){
  var r = Math.PI / 180;
  var u = (1 - t) * Math.sin(d1 * r) + t * Math.sin(d2 * r);
  var v = (1 - t) * Math.cos(d1 * r) + t * Math.cos(d2 * r);
  return (Math.atan2(u, v) / r + 360) % 360;
}

// Ground speed along the track from the wind triangle: the drone
// crabs into the crosswind (losing some forward speed to it) and the
// along-track wind adds or subtracts. relRad is the angle between the
// direction the wind blows TO and the track. Returns <= 0 when the
// drone can't make progress (crosswind >= airspeed, or headwind wins).
export function groundSpeed(airspeed, wind, relRad){
  var along = wind * Math.cos(relRad);
  var cross = wind * Math.sin(relRad);
  if (Math.abs(cross) >= airspeed) return 0;
  return Math.sqrt(airspeed * airspeed - cross * cross) + along;
}
export var MIN_GROUND_SPEED_MS = 0.5; // below this a leg is treated as not flyable

// Index of the current hour in Open-Meteo's hourly arrays, matched by
// timestamp (requested in GMT) instead of assuming position.
export function hourIndexNow(times){
  var now = Date.now(), idx = 0;
  for (var k = 0; k < times.length; k++){
    if (Date.parse(times[k] + 'Z') <= now) idx = k;
  }
  return idx;
}

export function drift(){
// from Observing Boundary-Layer Winds from Hot-Air Balloon Flights 2016
// Cd is the drone drag coefficient
// rho is the air density (kg/m^3)
// A is the drone area when looking from the side (m^2)
// m is the drone mass (kg)
//////// a = cd*rho*A/2m
// v0 is the relative speed at t=0
// v(t) = 1 / (a*t+(1/v0))
}
