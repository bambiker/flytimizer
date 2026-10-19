// Drone presets and custom drone parameters.

// ---------------------------------------------------------------
// Drone presets: horizontal/ascent/descent speed (m/s), from each
// manufacturer's published spec sheet (sport/S-mode figures).
// cruise = the mission speed: the most a waypoint mission flies (and
// the Normal-mode top speed, with obstacle sensing on), which every
// plan and downloaded flight plan uses. hor = the Sport-mode top
// speed: obstacle sensing is off and missions can't fly it, so only
// "Least battery" uses it, for a leg flown by hand into a headwind.
//   Mavic 3 Classic: Normal 15, waypoint missions up to 15.
//   Mini 4 Pro, Air 3: Normal 12, DJI Fly waypoints up to 12.
//   Matrice 300 RTK: P-mode 17, DJI Pilot 2 missions up to 15.
//   Neo 2: Normal 8.  EVO Lite+: Standard 10 (Ludicrous 18).
// ---------------------------------------------------------------

// batt = battery energy (Wh), ftime = rated max flight time (min),
// mass = takeoff weight (kg) - from the manufacturers' spec sheets,
// used by the battery estimate. Except the Neo 2: its batt and ftime
// are measured from 18 real flight logs (two packs) with
// tools/dji_battery_model.py - 10 Wh between 100% and 0% on the
// battery gauge, 47 W hovering and about 52.5 W in level flight at
// 6 m/s, which is 11.4 min on that energy. The spec sheet's 11.5 Wh /
// 19 min made the estimate about a third too low.
// power (optional) = the speed curve and climb efficiency measured
// from a drone's logs, replacing the defaults in battery.js. The Neo 2
// draws more power the faster it flies (no dip at moderate speed), and
// climbing costs it about 7.7 W per m/s.
export var DRONE_PRESETS = {
  mavic3classic: { name: 'DJI Mavic 3 Classic', cruise: 15, hor: 21, asc: 8, des: 6, windres: 12, batt: 77, ftime: 46, mass: 0.895 },
  mini4pro:      { name: 'DJI Mini 4 Pro',       cruise: 12, hor: 16, asc: 5, des: 5, windres: 10.7, batt: 18.96, ftime: 34, mass: 0.249 },
  air3:          { name: 'DJI Air 3',            cruise: 12, hor: 21, asc: 10, des: 10, windres: 12, batt: 62.6, ftime: 46, mass: 0.72 },
  matrice300:    { name: 'DJI Matrice 300 RTK',  cruise: 15, hor: 23, asc: 6, des: 5, windres: 12, batt: 548, ftime: 55, mass: 6.3 },
  neo2:          { name: 'DJI Neo 2',            cruise: 8, hor: 12, asc: 5, des: 3, windres: 10.7, batt: 10, ftime: 11.4, mass: 0.151,
                   power: { curve: { a: 0.1, b: 0.47 }, climbEff: 0.19 } },
  evolite:       { name: 'Autel EVO Lite+',      cruise: 10, hor: 18, asc: 5, des: 4, windres: 10.6, batt: 68.7, ftime: 40, mass: 0.835 }
};
// Fields a preset fills in (the rest - payload, drag, battery health -
// are the person's own).
export var PRESET_FIELDS = ['cruise', 'hor', 'asc', 'des', 'windres', 'batt', 'ftime', 'mass'];

export function updateDroneSummary(){
  var sel = document.getElementById('droneModel');
  var nameEl = document.getElementById('droneSummaryName');
  if (!sel || !nameEl) return;
  var preset = DRONE_PRESETS[sel.value];
  nameEl.textContent = preset ? preset.name : 'Custom';
}

export function applyDronePreset(){
  var sel = document.getElementById('droneModel');
  var preset = DRONE_PRESETS[sel.value];
  if (preset){
    PRESET_FIELDS.forEach(function(id){ document.getElementById(id).value = preset[id]; });
  }
  updateDroneSummary(); // "Custom" - leave whatever the user has typed, just relabel
}

// If the person hand-edits a speed field away from the selected
// preset's value, flip the picker to "Custom" so it doesn't silently
// keep claiming to be that drone.
export function checkCustom(){
  var sel = document.getElementById('droneModel');
  var preset = DRONE_PRESETS[sel.value];
  if (preset){
    var differs = PRESET_FIELDS.some(function(id){
      return parseFloat(document.getElementById(id).value) !== preset[id];
    });
    if (differs) sel.value = 'custom';
  }
  updateDroneSummary();
}

// Turns an element id like "timefore80" or "gust120" into a readable
// label for the tap-to-see-why note below the table.
export function unsafeCellLabel(id){
  var m = id.match(/^([a-z]+)(\d+)$/);
  if (!m) return id;
  var prefixLabel = {
    timefore: 'Outbound time at',
    timeback: 'Return time at',
    ws: 'Wind at',
    gust: 'Gust at'
  }[m[1]] || m[1];
  return prefixLabel + ' ' + m[2] + ' m';
}

export function showUnsafeReason(label, reason){
  var note = document.getElementById('unsafeReasonNote');
  if (!note) return;
  note.innerHTML = '<strong>' + label + ':</strong> ' + reason;
  note.style.display = 'block';
}

// Hovering a red (unsafe) value shows why via the title tooltip, but
// there's no hover on a touchscreen - so tapping shows the same
// reason in a small note under the table instead, which works the
// same way on both desktop and mobile.
export function markUnsafe(id, unsafe, reason){
  var el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('unsafe-value', unsafe);
  el.title = unsafe ? reason : '';
  el.onclick = unsafe ? function(){ showUnsafeReason(unsafeCellLabel(id), reason); } : null;
}
