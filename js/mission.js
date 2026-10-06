// Mission type (delivery / photo) and its defaults.

import { saveSettings } from './share.js';
import { profileWaypoints } from './terrain.js';

// ---------------------------------------------------------------
// Mission type
//
// Delivery: land (or lower the parcel) at the destination, then fly
// back - the return leg can carry a different payload, and each leg
// is its own mission (takeoff and landing at both ends).
// Photo / inspection: fly to the destination, stay airborne there for
// the time set, and come straight back at the same weight - no
// landing or takeoff at the destination, one round-trip mission.
// ---------------------------------------------------------------
export var DWELL_DEFAULTS = { delivery: 30, photo: 60 };
export var PAYLOAD_DEFAULTS = { delivery: 2, photo: 1 };

export function currentMission(){
  var el = document.getElementById('mission');
  return (el && el.value === 'photo') ? 'photo' : 'delivery';
}

export function onMissionChange(){
  var m = currentMission();
  var backField = document.getElementById('payloadBackField');
  if (backField) backField.style.display = m === 'photo' ? 'none' : '';
  var lbl = document.getElementById('payloadLabel');
  if (lbl) lbl.textContent = m === 'photo' ? 'Payload coefficient' : 'Payload coefficient (outbound)';
  var d = document.getElementById('dwell');
  var other = m === 'photo' ? 'delivery' : 'photo';
  if (d && parseFloat(d.value) === DWELL_DEFAULTS[other]) d.value = DWELL_DEFAULTS[m];
  // Photo flights usually carry nothing extra; swap the default payload
  // too, but leave any value the person typed themselves.
  var pl = document.getElementById('payload');
  if (pl && parseFloat(pl.value) === PAYLOAD_DEFAULTS[other]) pl.value = PAYLOAD_DEFAULTS[m];
  var note = document.getElementById('missionNote');
  if (note){
    note.textContent = m === 'photo'
      ? 'Flies to the destination, stays in the air there for the time you set, and comes straight back at the same weight. Flight plan: one round-trip mission.'
      : 'Lands or lowers the parcel at the destination (time at destination = hovering time; set 0 if it lands and waits powered down), then flies back with the return payload. Flight plans: one mission each way.';
  }
  saveSettings();
}

// One continuous waypoint list out and back, all heights relative to
// the start point (the outbound takeoff).
export function roundTripWaypoints(outSamples, outProf, backSamples, backProf){
  var outW = profileWaypoints(outSamples, outProf);
  var offset = backSamples[0].g - outSamples[0].g;
  var backW = profileWaypoints(backSamples, backProf).map(function(w){
    return { lat: w.lat, lng: w.lng, heightRel: w.heightRel + offset };
  });
  // Turn around at the destination at whichever leg's height is higher.
  outW[outW.length - 1].heightRel = Math.max(outW[outW.length - 1].heightRel, backW[0].heightRel);
  return outW.concat(backW.slice(1));
}
