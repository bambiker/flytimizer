// Drone presets and custom drone parameters.

// ---------------------------------------------------------------
// Drone presets: horizontal/ascent/descent speed (m/s), from each
// manufacturer's published spec sheet (sport/S-mode figures).
// ---------------------------------------------------------------

// batt = battery energy (Wh), ftime = rated max flight time (min),
// mass = takeoff weight (kg) - all from the manufacturers' spec
// sheets; used by the battery estimate.
var DRONE_PRESETS = {
  mavic3classic: { name: 'DJI Mavic 3 Classic', hor: 21, asc: 8, des: 6, windres: 12, batt: 77, ftime: 46, mass: 0.895 },
  mini4pro:      { name: 'DJI Mini 4 Pro',       hor: 16, asc: 5, des: 5, windres: 10.7, batt: 18.96, ftime: 34, mass: 0.249 },
  air3:          { name: 'DJI Air 3',            hor: 21, asc: 10, des: 10, windres: 12, batt: 62.6, ftime: 46, mass: 0.72 },
  matrice300:    { name: 'DJI Matrice 300 RTK',  hor: 23, asc: 6, des: 5, windres: 12, batt: 548, ftime: 55, mass: 6.3 },
  neo2:          { name: 'DJI Neo 2',            hor: 12, asc: 5, des: 3, windres: 10.7, batt: 11.5, ftime: 19, mass: 0.151 },
  evolite:       { name: 'Autel EVO Lite+',      hor: 18, asc: 5, des: 4, windres: 10.6, batt: 68.7, ftime: 40, mass: 0.835 }
};
// Fields a preset fills in (the rest - payload, drag, battery health -
// are the person's own).
var PRESET_FIELDS = ['hor', 'asc', 'des', 'windres', 'batt', 'ftime', 'mass'];

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
    PRESET_FIELDS.forEach(function(id){ document.getElementById(id).value = preset[id]; });
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
    var differs = PRESET_FIELDS.some(function(id){
      return parseFloat(document.getElementById(id).value) !== preset[id];
    });
    if (differs) sel.value = 'custom';
  }
  updateDroneSummary();
}

// Turns an element id like "timefore80" or "gust120" into a readable
// label for the tap-to-see-why note below the table.
function unsafeCellLabel(id){
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

function showUnsafeReason(label, reason){
  var note = document.getElementById('unsafeReasonNote');
  if (!note) return;
  note.innerHTML = '<strong>' + label + ':</strong> ' + reason;
  note.style.display = 'block';
}

// Hovering a red (unsafe) value shows why via the title tooltip, but
// there's no hover on a touchscreen - so tapping shows the same
// reason in a small note under the table instead, which works the
// same way on both desktop and mobile.
function markUnsafe(id, unsafe, reason){
  var el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('unsafe-value', unsafe);
  el.title = unsafe ? reason : '';
  el.onclick = unsafe ? function(){ showUnsafeReason(unsafeCellLabel(id), reason); } : null;
}
