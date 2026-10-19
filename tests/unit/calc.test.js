import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSite } from './load.js';

const site = await loadSite();
const heights = [30, 40, 50, 60, 70, 80, 90, 100, 110, 120];

// Forecast in the units Open-Meteo returns (km/h).
function hourly(over){
  const base = {
    time: ['2026-10-06T00:00'],
    wind_speed_10m: [18], wind_speed_80m: [36], wind_speed_120m: [54],
    wind_direction_10m: [180], wind_direction_80m: [180], wind_direction_120m: [180],
    wind_gusts_10m: [27], visibility: [20000], precipitation_probability: [0], precipitation: [0],
    temperature_2m: [20]
  };
  return { hourly: Object.assign(base, over) };
}
const inputs = { speedhorizontal: 15, speedhorizontalback: 15, drag: '1', windResistance: 12, speedMode: 'air' };
const groundInputs = Object.assign({}, inputs, { speedMode: 'ground' });

test('forecastAt converts km/h to m/s and clamps the gust factor', () => {
  const wx = site.forecastAt(hourly(), 0);
  assert.equal(wx.ws10, 5);
  assert.equal(wx.ws80, 10);
  assert.equal(wx.ws120, 15);
  assert.equal(wx.gustFactor, 1.5);
  assert.equal(site.forecastAt(hourly({ wind_gusts_10m: [180] }), 0).gustFactor, 3);
  assert.equal(site.forecastAt(hourly({ wind_gusts_10m: [1] }), 0).gustFactor, 1);
  assert.equal(site.forecastAt(hourly({ wind_speed_10m: [0], wind_gusts_10m: [10] }), 0).gustFactor, 1);
});

test('windByHeight uses the forecast at 80 and 120 m and interpolates between', () => {
  const wx = site.forecastAt(hourly(), 0);
  const w = site.windByHeight(heights, wx, 180, inputs);
  assert.equal(w.ws[5], 10);   // 80 m
  assert.equal(w.ws[9], 15);   // 120 m
  assert.ok(w.ws[7] > 10 && w.ws[7] < 15);   // 100 m
  assert.ok(w.ws[0] > 5 && w.ws[0] < 10);    // 30 m
  assert.equal(w.estgust[5], 15);
});

test('constant airspeed: wind from behind speeds up the outbound leg and slows the return', () => {
  // dronedegrees is the reverse bearing; wind from that direction is a tailwind outbound.
  const w = site.windByHeight(heights, site.forecastAt(hourly(), 0), 180, inputs);
  assert.ok(w.gsOut[5] > inputs.speedhorizontal);
  assert.ok(w.gsBack[5] < inputs.speedhorizontal);
  assert.ok(w.crosswind[5] < 1e-9);
});

test('windByHeight flags gusts over the rating and crosswind over the airspeed', () => {
  const wx = site.forecastAt(hourly(), 0);
  const w = site.windByHeight(heights, wx, 180, inputs);
  // Gust 1.5x: 15 m/s at 80 m (over 12), lower down it's fine.
  assert.equal(w.windResOk[0], true);
  assert.equal(w.windResOk[5], false);
  // Same wind straight across the track, drone slower than the wind at 120 m.
  const slow = Object.assign({}, inputs, { speedhorizontal: 12, speedhorizontalback: 12 });
  const cross = site.windByHeight(heights, wx, 90, slow);
  assert.equal(cross.crosswindOkOut[9], false);
  assert.equal(cross.crosswindOkOut[0], true);
});

test('flyableCeilingM is the highest height that is legal and wind-flyable', () => {
  const w = site.windByHeight(heights, site.forecastAt(hourly(), 0), 180, inputs);
  const legalOk = heights.map(h => h <= 120);
  const ceiling = site.flyableCeilingM(heights, legalOk, w);
  assert.ok(ceiling >= 30 && ceiling < 80, ceiling);
  assert.equal(site.flyableCeilingM(heights, heights.map(() => false), w), 0);
});

test('fastestFlyableIdx picks the quickest flyable height, or -1', () => {
  const timeV = [10, 10, 10, 10];
  const timeH = [100, 50, 20, 80];
  assert.equal(site.fastestFlyableIdx([true, true, true, true], timeV, timeH), 2);
  assert.equal(site.fastestFlyableIdx([true, true, false, true], timeV, timeH), 1);
  assert.equal(site.fastestFlyableIdx([false, false, false, false], timeV, timeH), -1);
});

test('sortRouteBuildings: a few climbable buildings are detoured, many are climbed over', () => {
  const path = [{ lat: 32, lng: 35 }, { lat: 32.01, lng: 35 }];
  const b = (k, height) => ({ lat: 32 + 0.001 * (k + 1), lng: 35, radius: 8, height });
  const off = { lat: 32.005, lng: 35.01, radius: 8, height: 30 };   // ~1 km off the line

  const few = site.sortRouteBuildings([b(0, 10), b(1, 20), off], path, 120);
  assert.equal(few.onRoute.length, 2);
  assert.equal(few.toAvoid.length, 2);
  assert.equal(few.maxClimbedHeight, 0);

  const many = site.sortRouteBuildings([0, 1, 2, 3, 4, 5].map(k => b(k, 10 + k)), path, 120);
  assert.equal(many.onRoute.length, 6);
  assert.equal(many.toAvoid.length, 0);
  assert.equal(many.maxClimbedHeight, 15);

  const tall = site.sortRouteBuildings([0, 1, 2, 3, 4].map(k => b(k, k === 2 ? 150 : 10)), path, 120);
  assert.equal(tall.tooTall.length, 1);
  assert.deepEqual(tall.toAvoid.map(x => x.height), [150]);
  assert.equal(tall.maxClimbedHeight, 10);
});

test('airspeedFor is the inverse of groundSpeed', () => {
  for (const rel of [0, 0.7, Math.PI / 2, 2.5, Math.PI]){
    const gs = site.groundSpeed(15, 6, rel);
    assert.ok(Math.abs(site.airspeedFor(gs, 6, rel) - 15) < 1e-9, 'angle ' + rel);
  }
});

test('constant ground speed: a tailwind gives no extra speed, only a lower airspeed', () => {
  const wx = site.forecastAt(hourly(), 0);
  const air = site.windByHeight(heights, wx, 180, inputs);
  const ground = site.windByHeight(heights, wx, 180, groundInputs);
  // Outbound has the wind behind it: capped at the set 15 m/s over the ground,
  // flying 15 - 10 = 5 m/s through the air at 80 m.
  assert.equal(ground.gsOut[5], 15);
  assert.ok(Math.abs(ground.airOut[5] - 5) < 1e-9);
  assert.equal(air.gsOut[5], 25);
  assert.equal(air.airOut[5], 15);
  // Into the wind it already flies flat out, so both modes agree.
  assert.equal(ground.gsBack[5], air.gsBack[5]);
  assert.equal(ground.airBack[5], 15);
});


test('least battery may fly a leg slower than the set speed; fastest never does', () => {
  // Two follow-terrain candidates per leg at one height: full speed, and
  // a slower option that takes longer but uses less battery.
  const prof = [{ pts: [{ s: 0, alt: 40 }, { s: 1000, alt: 40 }] }];
  function leg(hs, factor, time, batt){
    return { prof: prof, flyable: [true], timeV: [0], timeH: [time], batt: [batt], gs: [hs], air: [hs], cross: [true], head: [true],
             payload: 1, hs: hs, speedFactor: factor, up: 5, down: 5, samples: [], req: [], climbRun: 3, descRun: 3, timingOpts: {} };
  }
  const base = { heights: [40], w: { windResOk: [true] }, legalOk: [true], buildingOk: [true], terrainAvailable: false,
    battModel: { hoverW: 100, wh: 50, usableFraction: 1, massKg: 1, vmax: 15 }, temperatureC: 20, mission: 'delivery', dwellS: 0,
    payloadOut: 1, payloadBack: 1, speedupback: 5, speeddownback: 5 };
  const legs = { out: leg(15, 1, 100, 20), back: leg(15, 1, 100, 20) };
  const slower = { out: leg(9, 0.6, 160, 15), back: leg(9, 0.6, 160, 25) };   // cheaper out, dearer back
  const p = site.buildPlans(Object.assign({ legs, speedLegs: [slower] }, base)).plans;
  assert.equal(p.fast.out.speedFactor, 1);
  assert.equal(p.fast.back.speedFactor, 1);
  assert.equal(p.eco.out.speedFactor, 0.6);   // each leg chooses on its own
  assert.equal(p.eco.out.speed, 9);
  assert.equal(p.eco.back.speedFactor, 1);
  assert.equal(p.eco.totalBatt, 35);
  // Without the slower options it's the full-speed pair.
  assert.equal(site.buildPlans(Object.assign({ legs }, base)).plans.eco.out.speedFactor, 1);
});

test('legsAtSpeed: a slower leg takes longer, and holding ground speed with a tailwind it uses less power', () => {
  const heightsL = [30, 60];
  const samples = [{ s: 0, g: 0, lat: 0, lng: 0 }, { s: 1000, g: 0, lat: 0, lng: 0.009 }];
  const back = site.reverseSamples(samples);
  const inp = { speedup: 5, speeddown: 5, speedhorizontal: 15, speedupback: 5, speeddownback: 5, speedhorizontalback: 15,
    drag: '1', windResistance: 20, speedMode: 'ground', dwellS: 0 };
  const route = { samples, back, reqOut: [-Infinity, -Infinity], reqBack: [-Infinity, -Infinity], distance: 1000, buildingOk: [true, true],
    pOut: site.legProfiles(heightsL, samples, [-Infinity, -Infinity], 15, 5, 5), pBack: site.legProfiles(heightsL, back, [-Infinity, -Infinity], 15, 5, 5) };
  const model = { wh: 77, usableFraction: 1, massKg: 0.9, vmax: 15, hoverW: 100 };
  const ctx = { heights: heightsL, wx: site.forecastAt(hourly({ wind_direction_10m: [270], wind_direction_80m: [270], wind_direction_120m: [270] }), 0),
    dronedegrees: 270, inp, legalOk: [true, true], battModel: model, temperatureC: 20, payloadOut: 1, payloadBack: 1, timingOptsOut: {}, timingOptsBack: {} };
  const full = site.legsAtSpeed(ctx, route, 1), half = site.legsAtSpeed(ctx, route, 0.5);
  assert.ok(half.out.timeH[0] > full.out.timeH[0]);
  assert.equal(half.out.hs, 7.5);
  // Wind from the west, flying east: holding a lower ground speed, it flies slower through the air.
  assert.ok(half.out.air[0] < full.out.air[0]);
  assert.equal(half.out.speedFactor, 0.5);
  // Profiles keep their full-speed shape.
  assert.equal(half.out.climbRun, full.out.climbRun);
});

test('ecoSpeedFactors: slower shares, plus steps up to the top speed when it is faster than the mission speed', () => {
  assert.deepEqual(site.ecoSpeedFactors({ speedhorizontal: 10, speedhorizontalback: 10 }), site.ECO_SPEED_FACTORS);
  assert.deepEqual(site.ecoSpeedFactors({ speedhorizontal: 10, speedhorizontalback: 10, topSpeed: 10, topSpeedBack: 10 }), site.ECO_SPEED_FACTORS);
  const f = site.ecoSpeedFactors({ speedhorizontal: 12, speedhorizontalback: 12, topSpeed: 21, topSpeedBack: 21 });
  assert.equal(f.length, site.ECO_SPEED_FACTORS.length + 3);
  assert.ok(Math.abs(f[f.length - 1] * 12 - 21) < 1e-9);
});

test('into a strong headwind, a leg at the top speed uses less battery than at the mission speed', () => {
  const heightsL = [30, 60];
  const samples = [{ s: 0, g: 0, lat: 0, lng: 0 }, { s: 1000, g: 0, lat: 0, lng: 0.009 }];
  const back = site.reverseSamples(samples);
  const inp = { speedup: 5, speeddown: 5, speedhorizontal: 10, speedupback: 5, speeddownback: 5, speedhorizontalback: 10,
    topSpeed: 20, topSpeedBack: 20, drag: '1', windResistance: 20, speedMode: 'air', dwellS: 0 };
  const route = { samples, back, reqOut: [-Infinity, -Infinity], reqBack: [-Infinity, -Infinity], distance: 1000, buildingOk: [true, true],
    pOut: site.legProfiles(heightsL, samples, [-Infinity, -Infinity], 10, 5, 5), pBack: site.legProfiles(heightsL, back, [-Infinity, -Infinity], 10, 5, 5) };
  const model = { wh: 77, usableFraction: 1, massKg: 0.9, vmax: 20, hoverW: 100 };
  // Wind from the east, flying east: a headwind out, a tailwind back.
  const ctx = { heights: heightsL, wx: site.forecastAt(hourly({ wind_direction_10m: [90], wind_direction_80m: [90], wind_direction_120m: [90] }), 0),
    dronedegrees: 270, inp, legalOk: [true, true], battModel: model, temperatureC: 20, payloadOut: 1, payloadBack: 1, timingOptsOut: {}, timingOptsBack: {} };
  const legs = site.legsAtSpeed(ctx, route, 1);
  const factors = site.ecoSpeedFactors(inp);
  const plans = site.buildPlans({ heights: heightsL, legs, speedLegs: factors.map(f => site.legsAtSpeed(ctx, route, f)), w: legs.w,
    legalOk: [true, true], buildingOk: [true, true], terrainAvailable: false, battModel: model, temperatureC: 20, mission: 'delivery',
    dwellS: 0, payloadOut: 1, payloadBack: 1, speedupback: 5, speeddownback: 5 }).plans;
  assert.equal(plans.fast.out.speedFactor, 1);
  assert.equal(plans.eco.out.speedFactor, 2);
  assert.equal(plans.eco.out.speed, 20);
  assert.ok(plans.eco.out.batt < plans.fast.out.batt);
  // With the wind behind it, it doesn't speed up.
  assert.ok(plans.eco.back.speedFactor <= 1);
  // In a light breeze it isn't worth flying by hand.
  const calmCtx = Object.assign({}, ctx, { wx: site.forecastAt(hourly({ wind_speed_10m: [2], wind_speed_80m: [3], wind_speed_120m: [3],
    wind_direction_10m: [90], wind_direction_80m: [90], wind_direction_120m: [90] }), 0) });
  const calmLegs = site.legsAtSpeed(calmCtx, route, 1);
  const calm = site.buildPlans({ heights: heightsL, legs: calmLegs, speedLegs: factors.map(f => site.legsAtSpeed(calmCtx, route, f)), w: calmLegs.w,
    legalOk: [true, true], buildingOk: [true, true], terrainAvailable: false, battModel: model, temperatureC: 20, mission: 'delivery',
    dwellS: 0, payloadOut: 1, payloadBack: 1, speedupback: 5, speeddownback: 5 }).plans;
  assert.ok(calm.eco.out.speedFactor <= 1);
});

test('a leg the mission speed cannot fly falls back to the top speed (Sport mode), in both plans', () => {
  const heightsL = [30, 60];
  const samples = [{ s: 0, g: 0, lat: 0, lng: 0 }, { s: 1000, g: 0, lat: 0, lng: 0.009 }];
  const back = site.reverseSamples(samples);
  // A 3 m/s mission speed into a ~7 m/s headwind makes no headway.
  const inp = { speedup: 5, speeddown: 5, speedhorizontal: 3, speedupback: 5, speeddownback: 5, speedhorizontalback: 3,
    topSpeed: 20, topSpeedBack: 20, drag: '1', windResistance: 20, speedMode: 'air', dwellS: 0 };
  const route = { samples, back, reqOut: [-Infinity, -Infinity], reqBack: [-Infinity, -Infinity], distance: 1000, buildingOk: [true, true],
    pOut: site.legProfiles(heightsL, samples, [-Infinity, -Infinity], 3, 5, 5), pBack: site.legProfiles(heightsL, back, [-Infinity, -Infinity], 3, 5, 5) };
  const model = { wh: 77, usableFraction: 1, massKg: 0.9, vmax: 20, hoverW: 100 };
  const ctx = { heights: heightsL, wx: site.forecastAt(hourly({ wind_direction_10m: [90], wind_direction_80m: [90], wind_direction_120m: [90] }), 0),
    dronedegrees: 270, inp, legalOk: [true, true], battModel: model, temperatureC: 20, payloadOut: 1, payloadBack: 1, timingOptsOut: {}, timingOptsBack: {} };
  const legs = site.legsAtSpeed(ctx, route, 1);
  const f = site.topSpeedFactor(inp);
  const args = { heights: heightsL, legs, w: legs.w, legalOk: [true, true], buildingOk: [true, true], terrainAvailable: false,
    battModel: model, temperatureC: 20, mission: 'delivery', dwellS: 0, payloadOut: 1, payloadBack: 1, speedupback: 5, speeddownback: 5 };
  assert.equal(site.buildPlans(args).plans.fast.out, null);
  const plans = site.buildPlans(Object.assign({}, args, { sportLegs: site.legsAtSpeed(ctx, route, f, true),
    speedLegs: site.ecoSpeedFactors(inp).map(x => site.legsAtSpeed(ctx, route, x)) })).plans;
  assert.equal(plans.fast.out.speed, 20);
  assert.equal(plans.fast.out.sportNeeded, true);
  assert.equal(plans.fast.back.speedFactor, 1);
  assert.ok(plans.eco.out && plans.eco.out.speedFactor > 1);
});
