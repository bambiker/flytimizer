import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSite } from './load.js';

const site = await loadSite();
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, a + ' vs ' + b);

// A drone like the DJI Neo 2: 11.5 Wh, 19 min rated flight time, 151 g, 12 m/s.
function model(over = {}){
  const fields = Object.assign({ batt: '11.5', ftime: '19', mass: '0.151', health: '100', hor: '12' }, over);
  globalThis.document = { getElementById: id => ({ value: fields[id] }) };
  try { return site.readBatteryModel(); } finally { delete globalThis.document; }
}

test('airspeedPowerFactor: hover is 1, a bit less at moderate speed, more near top speed', () => {
  near(site.airspeedPowerFactor(0, 12), 1);
  assert.ok(site.airspeedPowerFactor(6, 12) < 1);
  near(site.airspeedPowerFactor(12, 12), 1.3);
  // Clamped at 1.2 x top speed.
  near(site.airspeedPowerFactor(30, 12), site.airspeedPowerFactor(14.4, 12));
});

test('coldCapacityFactor: full capacity from 15 C, about 18% less at 0 C, never below 70%', () => {
  assert.equal(site.coldCapacityFactor(20), 1);
  assert.equal(site.coldCapacityFactor(15), 1);
  near(site.coldCapacityFactor(0), 0.82);
  assert.equal(site.coldCapacityFactor(-40), 0.7);
  assert.equal(site.coldCapacityFactor(null), 1);
  assert.equal(site.coldCapacityFactor(NaN), 1);
});

test('readBatteryModel calibrates hover power from the rated flight time', () => {
  const m = model();
  const specPowerW = 11.5 * 60 / 19;
  near(m.hoverW * site.airspeedPowerFactor(site.SPEC_TEST_SPEED_MS, 12), specPowerW);
  assert.equal(m.usableFraction, 1);
  assert.equal(model({ health: '80' }).usableFraction, 0.8);
  assert.equal(model({ health: '' }).usableFraction, 1);      // blank = new pack
  assert.equal(model({ health: '130' }).usableFraction, 1);   // capped at 100%
  assert.equal(model({ batt: '0' }), null);
  assert.equal(model({ ftime: '' }), null);
});

test('flying the rated test (6 m/s, still air, no payload) for the rated time uses the whole battery', () => {
  const m = model();
  const wh = site.legEnergyWh(m, 1, site.SPEC_TEST_SPEED_MS, 19 * 60, 0, 0, 5, 3);
  near(site.batteryPct(m, wh, 20), 100, 1e-9);
});

test('payload costs power with weight^1.5; climbs cost more, descents less than hovering', () => {
  const m = model();
  const level = site.legEnergyWh(m, 1, 8, 600, 0, 0, 5, 3);
  near(site.legEnergyWh(m, 2, 8, 600, 0, 0, 5, 3), level * Math.pow(2, 1.5), 1e-9);

  const hover60 = site.legEnergyWh(m, 1, 0, 60, 0, 0, 5, 3);
  const climb60 = site.legEnergyWh(m, 1, 0, 0, 300, 0, 5, 3);   // 300 m at 5 m/s = 60 s
  const desc60 = site.legEnergyWh(m, 1, 0, 0, 0, 180, 5, 3);    // 180 m at 3 m/s = 60 s
  assert.ok(climb60 > hover60);
  near(desc60, hover60 * site.DESCENT_POWER_FACTOR, 1e-9);
});

test('legEnergyFromTiming matches legEnergyWh for the same time split', () => {
  const m = model();
  const viaTiming = site.legEnergyFromTiming(m, 1.4, 10, { total: 0, cruise: 300, climb: 40 / 5, desc: 25 / 3 }, 5);
  near(viaTiming, site.legEnergyWh(m, 1.4, 10, 300, 40, 25, 5, 3), 1e-9);
});

test('a leg that cannot be flown has infinite energy', () => {
  const m = model();
  assert.equal(site.legEnergyFromTiming(m, 1, 10, null, 5), Infinity);
  assert.equal(site.legEnergyWh(m, 1, 10, Infinity, 0, 0, 5, 3), Infinity);
});

test('batteryPct: an older pack or the cold means a bigger share of the battery', () => {
  const m = model();
  const pct = site.batteryPct(m, 5, 20);
  near(site.batteryPct(model({ health: '80' }), 5, 20), pct / 0.8, 1e-9);
  near(site.batteryPct(m, 5, 0), pct / 0.82, 1e-9);
});

test('profileTiming: takeoff and landing are vertical, cruise is distance / ground speed', () => {
  const samples = [{ s: 0, g: 10 }, { s: 1000, g: 10 }];
  const prof = { pts: [{ s: 0, alt: 40 }, { s: 1000, alt: 40 }] };
  const t = site.profileTiming(prof, samples, 10, 5, 3);
  near(t.cruise, 100);
  near(t.climb, 30 / 5);
  near(t.desc, 30 / 3);
  near(t.total, 100 + 6 + 10);
  near(site.profileTiming(prof, samples, 10, 5, 3, { skipTakeoff: true }).climb, 0);
  near(site.profileTiming(prof, samples, 10, 5, 3, { skipLanding: true }).desc, 0);
});

test('profileTiming: a climb steeper than the drone can manage sets the pace', () => {
  const samples = [{ s: 0, g: 0 }, { s: 100, g: 0 }];
  // 100 m of distance (10 s at 10 m/s) with a 100 m climb (20 s at 5 m/s).
  const prof = { pts: [{ s: 0, alt: 0 }, { s: 100, alt: 100 }] };
  const t = site.profileTiming(prof, samples, 10, 5, 3, { skipLanding: true });
  near(t.climb, 20);
  near(t.cruise, 0);
  // A gentle climb: the distance sets the pace, climbing just costs extra power.
  const gentle = site.profileTiming({ pts: [{ s: 0, alt: 0 }, { s: 1000, alt: 50 }] }, [{ s: 0, g: 0 }, { s: 1000, g: 0 }], 10, 5, 3, { skipLanding: true });
  near(gentle.total, 100);
  near(gentle.climb, 10);
});
