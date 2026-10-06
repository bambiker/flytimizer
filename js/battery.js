// Battery use estimate.

// ---------------------------------------------------------------
// Battery estimate
//
// A deliberately simple physical model, calibrated per drone from its
// spec sheet - so treat the result as an estimate (roughly +-20%),
// not a fuel gauge:
//  - DJI measures "max flight time" flying at about 21.6 km/h (6 m/s)
//    in still air. Battery energy / that time = average power at that
//    speed, which pins down the power curve for this drone.
//  - Power vs airspeed follows the usual multirotor shape: a little
//    lower than hover at moderate speed, rising steeply near top
//    speed (airspeedPowerFactor).
//  - Climbing adds the work of lifting the drone (m*g*climb rate)
//    divided by a propulsion efficiency; descending costs slightly
//    less than hovering.
//  - Payload: the app's payload coefficient multiplies weight, and
//    lift power grows with weight^1.5 (rotor momentum theory).
//  - Cold: below 15 C usable capacity drops (about 18% at 0 C).
//  - Battery health (%) scales usable capacity - lower it for older
//    packs.
// Wind is included through time: the drone always flies at its set
// airspeed, so a headwind leg simply takes longer at the same power.
// ---------------------------------------------------------------
var BATTERY_RESERVE_PCT = 20;
var SPEC_TEST_SPEED_MS = 6;     // ~21.6 km/h, DJI's flight-time test speed
var CLIMB_EFFICIENCY = 0.6;     // share of electrical power turned into climb work
var DESCENT_POWER_FACTOR = 0.9; // descending vs hovering

function airspeedPowerFactor(v, vmax){
  var x = Math.min(Math.max(v / Math.max(vmax, 0.1), 0), 1.2);
  return 1 - 0.2 * x + 0.5 * x * x * x;
}

function coldCapacityFactor(tempC){
  if (typeof tempC !== 'number' || !isFinite(tempC) || tempC >= 15) return 1;
  return Math.max(0.7, 1 - 0.012 * (15 - tempC));
}

function readBatteryModel(){
  var wh = parseFloat(document.getElementById('batt').value);
  var minutes = parseFloat(document.getElementById('ftime').value);
  var massKg = parseFloat(document.getElementById('mass').value);
  var health = parseFloat(document.getElementById('health').value);
  var vmax = parseFloat(document.getElementById('hor').value);
  if (!(wh > 0) || !(minutes > 0) || !(massKg > 0) || !(vmax > 0)) return null;
  if (!(health > 0)) health = 100;
  var specPowerW = wh * 60 / minutes;
  return {
    wh: wh,
    usableFraction: Math.min(health, 100) / 100,
    massKg: massKg,
    vmax: vmax,
    hoverW: specPowerW / airspeedPowerFactor(SPEC_TEST_SPEED_MS, vmax)
  };
}

// Energy (Wh) for one leg.
function legEnergyWh(model, payloadCoef, airspeed, horTimeS, climbUpM, climbDownM, upSpeed, downSpeed){
  if (!isFinite(horTimeS)) return Infinity;
  var baseW = model.hoverW * Math.pow(Math.max(payloadCoef, 0.1), 1.5);
  var cruiseW = baseW * airspeedPowerFactor(airspeed, model.vmax);
  var climbW = baseW + model.massKg * payloadCoef * 9.81 * upSpeed / CLIMB_EFFICIENCY;
  var descW = baseW * DESCENT_POWER_FACTOR;
  var joules = cruiseW * horTimeS + climbW * (climbUpM / upSpeed) + descW * (climbDownM / downSpeed);
  return joules / 3600;
}

// Time split for flying an altitude profile at ground speed gs: the
// drone climbs and descends while it travels, so each stretch takes
// whichever is longer - covering the distance, or the height change
// at the climb/descent rate. Takeoff and landing are purely vertical.
function profileTiming(prof, samples, gs, upSpeed, downSpeed, opts){
  opts = opts || {};
  var pts = prof.pts;
  var takeoff = opts.skipTakeoff ? 0 : Math.max(0, pts[0].alt - samples[0].g) / upSpeed;
  var landing = opts.skipLanding ? 0 : Math.max(0, pts[pts.length - 1].alt - samples[samples.length - 1].g) / downSpeed;
  var cruise = 0, climb = takeoff, desc = landing;
  for (var i = 1; i < pts.length; i++){
    var th = (pts[i].s - pts[i-1].s) / gs;
    var dz = pts[i].alt - pts[i-1].alt;
    var tv = dz > 0 ? dz / upSpeed : -dz / downSpeed;
    if (tv > th){
      // Height change sets the pace on this stretch.
      if (dz > 0) climb += tv; else desc += tv;
    } else {
      // Mostly cruising; the climbing share still costs extra power.
      if (dz > 0){ climb += tv; cruise += th - tv; }
      else { desc += tv; cruise += th - tv; }
    }
  }
  return { total: cruise + climb + desc, cruise: cruise, climb: climb, desc: desc };
}

function legEnergyFromTiming(model, payloadCoef, airspeed, timing, upSpeed){
  if (!timing || !isFinite(timing.total)) return Infinity;
  var baseW = model.hoverW * Math.pow(Math.max(payloadCoef, 0.1), 1.5);
  var cruiseW = baseW * airspeedPowerFactor(airspeed, model.vmax);
  var climbW = baseW + model.massKg * payloadCoef * 9.81 * upSpeed / CLIMB_EFFICIENCY;
  var descW = baseW * DESCENT_POWER_FACTOR;
  return (cruiseW * timing.cruise + climbW * timing.climb + descW * timing.desc) / 3600;
}

function batteryPct(model, energyWh, tempC){
  var usableWh = model.wh * model.usableFraction * coldCapacityFactor(tempC);
  return energyWh / usableWh * 100;
}

function fmtPct(p){
  if (!isFinite(p)) return '—';
  return (p < 1 ? '<1' : p.toFixed(0)) + '%';
}
