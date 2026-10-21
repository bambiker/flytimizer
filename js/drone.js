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
//   Mini 3, Mini 4K: Normal 10.  Air 3S: Normal 12.  Mavic 4 Pro:
//   Normal 15 (from third-party tables).  Avata 2: Normal 8 (Sport 16;
//   Manual mode isn't counted).  Mini 5 Pro and Flip don't publish a
//   Normal-mode speed: 12 (like the Mini 4 Pro) and 8 (like the Neo 2)
//   are assumptions.
// ---------------------------------------------------------------

// batt = battery energy (Wh), ftime = rated max flight time (min),
// mass = takeoff weight (kg) - from the manufacturers' spec sheets,
// used by the battery estimate. Except the Neo 2: its batt and ftime
// are measured from 18 real flight logs (two packs) with
// tools/dji_battery_model.py - 10 Wh between 100% and 0% on the
// battery gauge, 47 W hovering and about 52.5 W in level flight at
// 6 m/s, which is 11.4 min on that energy. The spec sheet's 11.5 Wh /
// 19 min made the estimate about a third too low.
// mtow = max takeoff weight (kg), where the maker publishes one (the
// Matrice 300 RTK: 9 kg). The consumer drones have none: they aren't
// made to carry a payload.
// testSpeed (m/s) = the speed the maker measured ftime at, from the
// spec sheet's footnote: Mavic 3 Classic, Air 3S and Mavic 4 Pro
// 32.4 km/h, Air 3 28.8 km/h, Mini 4 Pro, Mini 3 and Avata 2 21.6 km/h,
// Flip 6 m/s, Mini 4K 17 km/h. The others don't say; battery.js
// assumes 6 m/s. Avata 2: 2150 mAh x 14.76 V = 31.7 Wh.
// power (optional) = the speed curve and climb efficiency measured
// from a drone's logs, replacing the defaults in battery.js. The Neo 2
// draws more power the faster it flies (no dip at moderate speed), and
// climbing costs it about 7.7 W per m/s. socSlope = how much less energy
// each gauge % holds as the battery runs down: on the Neo 2 about 0.110
// Wh per % near full and 0.091 Wh per % near empty (k = 0.002 per %).
export var DRONE_PRESETS = {
  mini3:         { name: 'DJI Mini 3',           testSpeed: 6, cruise: 10, hor: 16, asc: 5, des: 3.5, windres: 10.7, batt: 18.1, ftime: 38, mass: 0.248 },
  mini4k:        { name: 'DJI Mini 4K',          testSpeed: 4.7, cruise: 10, hor: 16, asc: 5, des: 3.5, windres: 10.7, batt: 17.32, ftime: 31, mass: 0.246 },
  mini5pro:      { name: 'DJI Mini 5 Pro',       cruise: 12, hor: 18, asc: 10, des: 6, windres: 12, batt: 19.52, ftime: 36, mass: 0.249 },
  air3s:         { name: 'DJI Air 3S',           testSpeed: 9, cruise: 12, hor: 21, asc: 10, des: 10, windres: 12, batt: 62.5, ftime: 45, mass: 0.724 },
  mavic4pro:     { name: 'DJI Mavic 4 Pro',      testSpeed: 9, cruise: 15, hor: 25, asc: 10, des: 10, windres: 12, batt: 95.3, ftime: 51, mass: 1.063 },
  flip:          { name: 'DJI Flip',             testSpeed: 6, cruise: 8, hor: 12, asc: 5, des: 5, windres: 10.7, batt: 22.3, ftime: 31, mass: 0.249 },
  avata2:        { name: 'DJI Avata 2',          testSpeed: 6, cruise: 8, hor: 16, asc: 9, des: 9, windres: 10.7, batt: 31.7, ftime: 23, mass: 0.377 },
  mavic3classic: { name: 'DJI Mavic 3 Classic', testSpeed: 9, cruise: 15, hor: 21, asc: 8, des: 6, windres: 12, batt: 77, ftime: 46, mass: 0.895 },
  mini4pro:      { name: 'DJI Mini 4 Pro',       testSpeed: 6, cruise: 12, hor: 16, asc: 5, des: 5, windres: 10.7, batt: 18.96, ftime: 34, mass: 0.249 },
  air3:          { name: 'DJI Air 3',            testSpeed: 8, cruise: 12, hor: 21, asc: 10, des: 10, windres: 12, batt: 62.6, ftime: 46, mass: 0.72 },
  matrice300:    { name: 'DJI Matrice 300 RTK',  mtow: 9, cruise: 15, hor: 23, asc: 6, des: 5, windres: 12, batt: 548, ftime: 55, mass: 6.3 },
  neo2:          { name: 'DJI Neo 2',            cruise: 8, hor: 12, asc: 5, des: 3, windres: 10.7, batt: 10, ftime: 11.4, mass: 0.151,
                   power: { measured: true, curve: { a: 0.1, b: 0.47 }, climbEff: 0.19, socSlope: 0.002 } },
  evolite:       { name: 'Autel EVO Lite+',      cruise: 10, hor: 18, asc: 5, des: 4, windres: 10.6, batt: 68.7, ftime: 40, mass: 0.835 }
};
// Fields a preset fills in (the rest - payload, drag, battery health -
// are the person's own).
export var PRESET_FIELDS = ['cruise', 'hor', 'asc', 'des', 'windres', 'batt', 'ftime', 'mass', 'mtow'];

// Below this takeoff weight (kg) a drone is in the lightest class in
// most countries (EU C0, no FAA registration for recreational flying).
export var LIGHT_CLASS_MAX_KG = 0.25;

function fieldKg(id){
  var el = document.getElementById(id);
  var v = el ? parseFloat(el.value) : NaN;
  return v > 0 ? v : 0;
}

// The payload as a weight factor: 1 = the drone alone, 2 = carrying
// its own weight again. { out, back, mass, outKg, backKg, mtow }.
// Photo missions carry the same load both ways.
export function payloadFactors(mission){
  var mass = fieldKg('mass');
  var outKg = fieldKg('payloadKg');
  var backKg = mission === 'photo' ? outKg : fieldKg('payloadBackKg');
  function factor(kg){ return mass > 0 ? 1 + kg / mass : 1; }
  return { out: factor(outKg), back: factor(backKg), mass: mass, outKg: outKg, backKg: backKg, mtow: fieldKg('mtow') || null };
}

// What's wrong with the takeoff weight, if anything: { level: 'over' |
// 'class' | 'unknown', text } or null.
export function payloadCheck(p){
  var heaviest = p.mass + Math.max(p.outKg, p.backKg);
  if (!(p.mass > 0) || heaviest <= p.mass) return null;
  if (p.mtow && heaviest > p.mtow + 1e-9){
    return { level: 'over', text: 'With the payload the drone weighs ' + heaviest.toFixed(2) + ' kg, over its ' + p.mtow + ' kg max takeoff weight. Don’t fly it like this.' };
  }
  if (p.mass <= LIGHT_CLASS_MAX_KG && heaviest > LIGHT_CLASS_MAX_KG){
    return { level: 'class', text: 'With the payload the drone weighs ' + Math.round(heaviest * 1000) + ' g: over 250 g it leaves the lightest class, so registration and other rules may apply.' };
  }
  if (!p.mtow){
    return { level: 'unknown', text: 'The maker doesn’t publish a max takeoff weight for this drone (it isn’t made to carry a payload): handling, climb and battery suffer, and a heavy load can make it unsafe.' };
  }
  return null;
}

export function updatePayloadNote(){
  var note = document.getElementById('payloadNote');
  if (!note) return;
  var mission = document.getElementById('mission');
  var c = payloadCheck(payloadFactors(mission && mission.value === 'photo' ? 'photo' : 'delivery'));
  note.hidden = !c;
  note.textContent = c ? c.text : '';
  note.classList.toggle('field-warn', !!c && c.level === 'over');
}

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
    PRESET_FIELDS.forEach(function(id){ document.getElementById(id).value = preset[id] === undefined ? '' : preset[id]; });
  }
  updateDroneSummary();
  updatePayloadNote(); // "Custom" - leave whatever the user has typed, just relabel
}

// If the person hand-edits a speed field away from the selected
// preset's value, flip the picker to "Custom" so it doesn't silently
// keep claiming to be that drone.
export function checkCustom(){
  var sel = document.getElementById('droneModel');
  var preset = DRONE_PRESETS[sel.value];
  if (preset){
    var differs = PRESET_FIELDS.some(function(id){
      var v = parseFloat(document.getElementById(id).value);
      return preset[id] === undefined ? !isNaN(v) : v !== preset[id];
    });
    if (differs) sel.value = 'custom';
  }
  updateDroneSummary();
  updatePayloadNote();
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
