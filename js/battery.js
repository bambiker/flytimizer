// Battery use estimate.

import { DRONE_PRESETS } from './drone.js';

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
//  - A preset can replace the speed curve and the climb efficiency
//    with figures measured from that drone's flight logs (its
//    `power` entry in drone.js); other drones use the defaults.
//  - Battery % is the drone's gauge, which counts charge: when the
//    pack is low its voltage is lower, so its last percents hold less
//    energy than its first. A preset's `socSlope` says by how much
//    (gaugeUsedPct); without one every percent holds the same energy.
//  - Payload: the app's payload coefficient multiplies weight, and
//    lift power grows with weight^1.5 (rotor momentum theory).
//  - Cold: below 15 C usable capacity drops (about 18% at 0 C).
//  - Battery health (%) scales usable capacity - lower it for older
//    packs.
// Wind is included through time: the drone always flies at its set
// airspeed, so a headwind leg simply takes longer at the same power.
// ---------------------------------------------------------------
export var BATTERY_RESERVE_PCT = 20;
export var SPEC_TEST_SPEED_MS = 6;     // ~21.6 km/h, DJI's flight-time test speed
export var CLIMB_EFFICIENCY = 0.6;     // share of electrical power turned into climb work
export var DESCENT_POWER_FACTOR = 0.9; // descending vs hovering

// Power at airspeed v as a multiple of hover power. curve = { a, b }
// for 1 + a*x + b*x^3 with x = v / top speed; the default dips a
// little at moderate speed.
export var DEFAULT_POWER_CURVE = { a: -0.2, b: 0.5 };

export function airspeedPowerFactor(v, vmax, curve){
  var c = curve || DEFAULT_POWER_CURVE;
  var x = Math.min(Math.max(v / Math.max(vmax, 0.1), 0), 1.2);
  return 1 + c.a * x + c.b * x * x * x;
}

export function climbEfficiency(model){
  return model.climbEff || CLIMB_EFFICIENCY;
}

export function coldCapacityFactor(tempC){
  if (typeof tempC !== 'number' || !isFinite(tempC) || tempC >= 15) return 1;
  return Math.max(0.7, 1 - 0.012 * (15 - tempC));
}

export function readBatteryModel(){
  var wh = parseFloat(document.getElementById('batt').value);
  var minutes = parseFloat(document.getElementById('ftime').value);
  var massKg = parseFloat(document.getElementById('mass').value);
  var health = parseFloat(document.getElementById('health').value);
  var vmax = parseFloat(document.getElementById('hor').value);
  if (!(wh > 0) || !(minutes > 0) || !(massKg > 0) || !(vmax > 0)) return null;
  if (!(health > 0)) health = 100;
  // A preset is only selected while its fields are untouched (editing
  // one switches the picker to Custom), so its measured curve applies.
  var picker = document.getElementById('droneModel');
  var preset = picker && DRONE_PRESETS[picker.value];
  var power = (preset && preset.power) || {};
  var curve = power.curve || DEFAULT_POWER_CURVE;
  var specPowerW = wh * 60 / minutes;
  return {
    wh: wh,
    usableFraction: Math.min(health, 100) / 100,
    massKg: massKg,
    vmax: vmax,
    curve: curve,
    climbEff: power.climbEff || CLIMB_EFFICIENCY,
    socSlope: power.socSlope || 0,
    hoverW: specPowerW / airspeedPowerFactor(SPEC_TEST_SPEED_MS, vmax, curve)
  };
}

// Energy (Wh) for one leg.
export function legEnergyWh(model, payloadCoef, airspeed, horTimeS, climbUpM, climbDownM, upSpeed, downSpeed){
  if (!isFinite(horTimeS)) return Infinity;
  var baseW = model.hoverW * Math.pow(Math.max(payloadCoef, 0.1), 1.5);
  var cruiseW = baseW * airspeedPowerFactor(airspeed, model.vmax, model.curve);
  var climbW = baseW + model.massKg * payloadCoef * 9.81 * upSpeed / climbEfficiency(model);
  var descW = baseW * DESCENT_POWER_FACTOR;
  var joules = cruiseW * horTimeS + climbW * (climbUpM / upSpeed) + descW * (climbDownM / downSpeed);
  return joules / 3600;
}

// Time split for flying an altitude profile at ground speed gs: the
// drone climbs and descends while it travels, so each stretch takes
// whichever is longer - covering the distance, or the height change
// at the climb/descent rate. Takeoff and landing are purely vertical.
export function profileTiming(prof, samples, gs, upSpeed, downSpeed, opts){
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

export function legEnergyFromTiming(model, payloadCoef, airspeed, timing, upSpeed){
  if (!timing || !isFinite(timing.total)) return Infinity;
  var baseW = model.hoverW * Math.pow(Math.max(payloadCoef, 0.1), 1.5);
  var cruiseW = baseW * airspeedPowerFactor(airspeed, model.vmax, model.curve);
  var climbW = baseW + model.massKg * payloadCoef * 9.81 * upSpeed / climbEfficiency(model);
  var descW = baseW * DESCENT_POWER_FACTOR;
  return (cruiseW * timing.cruise + climbW * timing.climb + descW * timing.desc) / 3600;
}

export function batteryPct(model, energyWh, tempC){
  var usableWh = model.wh * model.usableFraction * coldCapacityFactor(tempC);
  return energyWh / usableWh * 100;
}

// Energy in each gauge % at gauge level p is 1 + k*(p - 50) times the
// average (k = model.socSlope), so the whole 100% still holds the
// battery's energy. Share of that energy below gauge level p:
function energyShareBelow(k, p){
  return (p + k * (p * p / 2 - 50 * p)) / 100;
}

// Gauge % used when a flight starting at startPct (default a full
// battery) uses energyPct % of the battery's energy (the sum of the
// legs' batteryPct). Without a socSlope the two are the same.
export function gaugeUsedPct(model, energyPct, startPct){
  var k = (model && model.socSlope) || 0;
  var start = isFinite(startPct) ? startPct : 100;
  if (!k || !isFinite(energyPct)) return energyPct;
  var target = 100 * energyShareBelow(k, start) - energyPct;   // 100 x share left
  if (target <= 0) return energyPct + start - 100 * energyShareBelow(k, start);   // past empty
  var a = k / 2, b = 1 - 50 * k;
  var left = (-b + Math.sqrt(b * b + 4 * a * target)) / (2 * a);
  return start - left;
}

// % of the battery's energy that lies above a gauge level - what a
// flight from a full battery can use before reaching it.
export function energyPctAbove(model, gaugePct){
  var k = (model && model.socSlope) || 0;
  return 100 * (1 - energyShareBelow(k, gaugePct));
}

export function fmtPct(p){
  if (!isFinite(p)) return '—';
  return (p < 1 ? '<1' : p.toFixed(0)) + '%';
}
