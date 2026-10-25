import * as base from '@playwright/test';
import JSZip from 'jszip';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { openSite, waitForResult } from './site.js';

// Every test fails on an uncaught page error or console error.
const test = base.test.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    // Messages are shown in the page; a blocking alert/prompt is a bug.
    page.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss(); });
    await use(page);
    base.expect(errors, 'page errors').toEqual([]);
  }
});
const { expect } = base;

const HAIFA = [32.794, 34.989];
const HAIFA_DEST = [32.803, 35.001];

async function downloadMission(page){
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#wpmlButtons button').first().click()]);
  const zip = await JSZip.loadAsync(fs.readFileSync(await download.path()));
  return { name: download.suggestedFilename(), files: Object.keys(zip.files), zip };
}

test('a shared route calculates and shows a recommended height', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro');
  await waitForResult(page);

  await expect(page.locator('#heightfore')).toHaveText(/^\d+$/);
  await expect(page.locator('#heightback')).toHaveText(/^\d+$/);
  await expect(page.locator('#flyWarning')).toBeHidden();
  await expect(page.locator('#distance')).toHaveText(/km/);
  await expect(page.locator('#rulesInfo')).toContainText('Israel');
  await expect(page.locator('#hazardInfo')).toContainText('Found 3 restricted areas');
  await expect(page.locator('#buildingInfo')).toContainText('Checked 2 buildings');
  await expect(page.locator('#noFlyWarning')).toContainText('Heliport (Pad)');
  expect(page.url()).toContain('to=32.80300,35.00100');
});

test('the result shows the essentials; the details are folded away until opened', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro');
  await waitForResult(page);
  await expect(page.locator('#heightfore')).toBeVisible();
  await expect(page.locator('#wpmlButtons button').first()).toBeVisible();
  await expect(page.locator('#forecastStrip')).toBeVisible();
  await expect(page.locator('#noFlyWarning')).toBeVisible();
  await expect(page.locator('.wind-table')).toBeHidden();
  await expect(page.locator('#hazardInfo')).toBeHidden();
  await page.locator('#resultDetails > summary').click();
  await expect(page.locator('.wind-table')).toBeVisible();
  await expect(page.locator('#hazardInfo')).toBeVisible();
  await expect(page.locator('#terrainProfile')).toBeVisible();
});

test('names from OpenStreetMap are shown as text, never run as HTML', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro');
  await waitForResult(page);

  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await expect(page.locator('.leaflet-overlay-pane img, #hazardInfo img, #noFlyWarning img')).toHaveCount(0);
  // Hover each restricted area (drawn in red) and read its tooltip.
  const tooltips = [];
  const areas = page.locator('path.leaflet-interactive[stroke="#e6484f"], path.leaflet-interactive[stroke="#7a1620"]');
  for (let i = 0; i < await areas.count(); i++){
    await areas.nth(i).hover({ force: true });
    tooltips.push(await page.locator('.leaflet-tooltip').last().textContent());
    await page.mouse.move(0, 0);
  }
  expect(tooltips).toContain('School \u2014 <img src=x onerror="window.__xss=1">Evil School');
  expect(tooltips.some(t => t.includes('Rambam & <b>Sons</b>'))).toBe(true);
  await expect(page.locator('.leaflet-tooltip img, .leaflet-tooltip b')).toHaveCount(0);
});

test('switching plan and forecast hour updates the result', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro');
  await waitForResult(page);

  await expect(page.locator('#planTabs')).toBeVisible();
  await page.locator('#planEcoBtn').click();
  await expect(page.locator('#planEcoBtn')).toHaveClass(/active/);
  await expect(page.locator('#planFastBtn')).not.toHaveClass(/active/);

  const strip = page.locator('#forecastStrip');
  const before = await strip.innerHTML();
  await page.locator('#forecastStrip [data-arg="5"]').click();
  await waitForResult(page);
  await expect.poll(() => strip.innerHTML()).not.toBe(before);
  await expect(page.locator('#heightfore')).toHaveText(/^\d+$/);
});

test('the DJI flight plan downloads as a valid WPML archive', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro');
  await waitForResult(page);

  const kmz = await downloadMission(page);
  expect(kmz.name).toBe('flytimizer-outbound.kmz');
  expect(kmz.files).toEqual(expect.arrayContaining(['wpmz/template.kml', 'wpmz/waylines.wpml']));
  const waylines = await kmz.zip.file('wpmz/waylines.wpml').async('string');
  expect(waylines).toContain('<Placemark>');
  expect(waylines).toContain('wpml:executeHeight');
});

test('into the wind a plan may fly in Sport mode; the download stays at the mission speed, and fastest is never slower than least battery', async ({ page }) => {
  const noon = new Date(); noon.setUTCHours(12, 30, 0, 0);
  await page.clock.setFixedTime(noon);
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=air3');
  await waitForResult(page);
  await expect(page.locator('#cruise')).toHaveValue('12');
  await expect(page.locator('#hor')).toHaveValue('21');
  // Into the wind, the fastest plan flies the leg in Sport mode too.
  await expect(page.locator('#styleFore')).toContainText('(Sport mode, by hand)');
  await expect(page.locator('#sportNote')).toContainText('faster than a mission');

  await page.locator('#planEcoBtn').click();
  await expect(page.locator('#styleFore')).toContainText('(Sport mode, by hand)');
  await expect(page.locator('#sportNote')).toContainText('faster than a mission');
  const missionSpeed = await page.evaluate(() => 12 * 0.72 / (0.72 + (parseFloat(document.getElementById('payloadKg').value) || 0)));
  const kmz = await downloadMission(page);
  expect(kmz.name).toBe('flytimizer-least-battery-outbound.kmz');
  const waylines = await kmz.zip.file('wpmz/waylines.wpml').async('string');
  const speed = parseFloat(waylines.match(/<wpml:autoFlightSpeed>([\d.]+)</)[1]);
  expect(speed).toBeCloseTo(missionSpeed, 1);

  // The fastest plan is never slower than least battery.
  const seconds = async id => {
    const m = (await page.locator('#' + id + ' .plan-detail').textContent()).match(/(?:(\d+) min)?\s*(?:(\d+) s)?/);
    return (+m[1] || 0) * 60 + (+m[2] || 0);
  };
  const fast = await seconds('planFastBtn');
  expect(fast).toBeGreaterThan(0);
  expect(fast).toBeLessThanOrEqual(await seconds('planEcoBtn'));
});

test('when the wind is too strong for the mission speed, the fastest plan flies that leg in Sport mode', async ({ page }) => {
  // At this hour the fake forecast's wind is more than the Neo 2 carrying its own weight can handle at its
  // mission speed (8 m/s, halved), but not at its Sport speed.
  const morning = new Date(); morning.setUTCHours(8, 32, 0, 0);
  await page.clock.setFixedTime(morning);
  await openSite(page, HAIFA, null, 'payloadKg=0.151');
  await page.locator('#calcBtn').click();
  await waitForResult(page);
  await expect(page.locator('#heightfore')).toHaveText(/^\d+$/);
  await expect(page.locator('#styleFore')).toContainText('(Sport mode, by hand)');
  await expect(page.locator('#flyWarning')).toBeHidden();
  await expect(page.locator('#sportNote')).toContainText('too strong for a mission');
});

test('wind stronger than the drone can handle gives a clear no-fly warning', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro', { windMul: 6 });
  await waitForResult(page);

  await expect(page.locator('#flyWarning')).toBeVisible();
  await expect(page.locator('#flyWarning')).toContainText("can't recommend a safe height");
  await expect(page.locator('#flyWarning')).toContainText('gusts');
  await expect(page.locator('#wpmlButtons button')).toHaveCount(0);
});

test('the keep-out distance the route detours around is drawn on the map', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro');
  await waitForResult(page);
  // The heliport (Israel: 2 km) is drawn as a dashed ring at that distance.
  const rings = page.locator('.leaflet-overlay-pane path[stroke-dasharray="4 6"]');
  await expect(rings).toHaveCount(3);
  await expect(page.locator('#hazardInfo')).toContainText('dashed ring for the keep-out distance');
  await expect(page.locator('#hazardInfo')).toContainText("doesn't get any closer to the site than it has to");
});

test('a detour that swings out of view zooms the map out to show the whole route', async ({ page }) => {
  // An airfield halfway along a 6 km route: 2.5 km around it is well outside the first view.
  const to = [HAIFA[0], HAIFA[1] + 0.064];
  await openSite(page, HAIFA, to, 'drone=mini4pro', { hazards: [
    { type: 'node', id: 40, lat: HAIFA[0], lon: HAIFA[1] + 0.032, tags: { aeroway: 'aerodrome', name: 'Field' } }
  ] });
  await waitForResult(page);
  await expect(page.locator('#hazardInfo')).toContainText('detours around 1 of them');
  // Both measured at once (the page may still be scrolling). Leaflet
  // clips lines at the map's edge, so "fits" means clear of it.
  await expect.poll(() => page.evaluate(() => {
    const m = document.getElementById('map').getBoundingClientRect();
    const r = document.querySelector('.leaflet-overlay-pane path[stroke="#2f6fed"]').getBoundingClientRect();
    return r.left > m.left + 10 && r.top > m.top + 10 && r.right < m.right - 10 && r.bottom < m.bottom - 10;
  })).toBe(true);
});

test('a military site near the route gets no 3 km detour; a military airfield gets the 3 km keep-out', async ({ page }) => {
  // A 2.6 km route, with a military site 2.95 km south of its middle:
  // a 3 km keep-out would just reach the line.
  const to = [HAIFA[0], HAIFA[1] + 0.028];
  const site = tags => [{ type: 'node', id: 50, lat: HAIFA[0] - 0.02668, lon: HAIFA[1] + 0.014, tags }];
  await openSite(page, HAIFA, to, 'drone=mini4pro', { hazards: site({ landuse: 'military' }) });
  await waitForResult(page);
  await expect(page.locator('#detourNote')).toHaveText('');
  await expect(page.locator('#noFlyWarning')).toBeHidden();

  await openSite(page, HAIFA, to, 'drone=mini4pro', { hazards: site({ military: 'airfield' }) });
  await waitForResult(page);
  // Both ends are inside its keep-out, so it's a warning rather than a detour.
  await expect(page.locator('#noFlyWarning')).toContainText('Military airfield — keep-out distance around 3 km');
  await expect(page.locator('#hazardInfo')).toContainText('Military airfield at the start and destination');
});

test('a military site right on the route: the route keeps off it and warns not to fly over it', async ({ page }) => {
  const to = [HAIFA[0], HAIFA[1] + 0.028];
  await openSite(page, HAIFA, to, 'drone=mini4pro', { hazards: [{ type: 'node', id: 60, lat: HAIFA[0], lon: HAIFA[1] + 0.014, tags: { landuse: 'military' } }] });
  await waitForResult(page);
  await expect(page.locator('#noFlyWarning')).toContainText('Military site — don’t fly over it');
  await expect(page.locator('#detourNote')).toContainText('detour around 1 restricted area');
});

test('buildings with no height in OpenStreetMap get the GHSL average height around them', async ({ page }) => {
  // The fake forecast's wind changes hour by hour; at some UTC hours (5, 10,
  // 11, 20) it caps the height below what this test needs. Fly at noon.
  const noon = new Date(); noon.setUTCHours(12, 30, 0, 0);
  await page.clock.setFixedTime(noon);
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro', { buildings: 'untagged', ghsl: 24, hazards: [], flatGround: true });
  await waitForResult(page);
  await expect(page.locator('#buildingInfo')).toContainText('6 were raised to the average building height around them');
  await expect(page.locator('#buildingInfo')).toContainText('the tallest one we still climb over is about 24 m');
  // 24 m + the 20 m margin: nothing lower than 44 m is recommended.
  expect(Number(await page.locator('#heightfore').textContent())).toBeGreaterThanOrEqual(44);
});

test('if the GHSL heights can\'t be loaded, untagged buildings keep a type guess and the result says so', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro', { buildings: 'untagged', hazards: [] });
  await waitForResult(page);
  await expect(page.locator('#buildingInfo')).toContainText('the backup height data couldn’t be loaded');
  await expect(page.locator('#buildingInfo')).toContainText('about 7 m');
});

test('Conditions here: satellites, Kp, highest height in the wind and range at the start point', async ({ page }) => {
  await openSite(page, HAIFA, null, 'drone=mavic3classic');
  await page.getByRole('button', { name: 'Conditions here' }).click();
  const card = page.locator('#conditionsCard');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Conditions at the start point');
  await expect(card).toContainText(/~\d+ navigation satellites above 10° \(GPS \d+, Galileo \d+/);
  const total = Number((await card.textContent()).match(/~(\d+) navigation/)[1]);
  expect(total).toBeGreaterThanOrEqual(10);
  expect(total).toBeLessThanOrEqual(25);
  await expect(card).toContainText('Kp 2: quiet');
  // Israel: 50 m limit unless there's a permit.
  await expect(card).toContainText(/Up to \d+ m above the ground/);
  await expect(card).toContainText(/Up to [\d.]+ km toward the \w+/);
  await expect(page.locator('.leaflet-overlay-pane path[stroke="#14b8a6"]')).toHaveCount(1);
  // Start over hides it.
  await page.getByRole('button', { name: 'Start over' }).click();
  await expect(card).toBeHidden();
});

test('Conditions here with no point on the map uses your location, and says what it couldn\'t load', async ({ page }) => {
  await page.context().grantPermissions(['geolocation'], { origin: 'https://flytimizer.test' });
  await page.context().setGeolocation({ latitude: HAIFA[0], longitude: HAIFA[1] });
  await openSite(page, HAIFA, null, 'drone=mini4pro', { gnssFail: true, kp: 5.67 });
  await page.evaluate(() => history.replaceState(null, '', location.pathname));
  await page.reload();
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(0);
  await page.getByRole('button', { name: 'Conditions here' }).click();
  const card = page.locator('#conditionsCard');
  await expect(card).toContainText('Conditions at your location');
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(1);
  await expect(card).toContainText('Couldn’t load the satellite orbits right now');
  await expect(card).toContainText('Kp 6: geomagnetic storm');
});

base.test.describe('GPS spoofing check (Israeli time zone)', () => {
  test.use({ timezoneId: 'Asia/Jerusalem', permissions: ['geolocation'] });
  const BEIRUT_AIRPORT = { latitude: 33.8209, longitude: 35.4884, accuracy: 9 };

  async function openWithoutPoints(page, geo, sc){
    await page.context().setGeolocation(geo);
    await openSite(page, HAIFA, null, 'drone=mini4pro', sc);
    await page.evaluate(() => history.replaceState(null, '', location.pathname));
    await page.reload();
  }

  test('a position at Beirut airport while the network says Israel is flagged as likely spoofed', async ({ page }) => {
    await openWithoutPoints(page, BEIRUT_AIRPORT, { country: 'lb', ipCountry: 'IL' });
    await page.getByRole('button', { name: 'Use my location' }).click();
    await expect(page.locator('#searchNotice')).toContainText('GPS spoofing likely: your device puts you near Beirut airport, a common fake position, but your internet connection and time zone say Israel');

    await page.getByRole('button', { name: 'Conditions here' }).click();
    await expect(page.locator('#conditionsCard')).toContainText('Conditions at the start point');
  });

  test('Conditions here from your location checks it against the network', async ({ page }) => {
    await openWithoutPoints(page, BEIRUT_AIRPORT, { country: 'lb', ipCountry: 'IL' });
    await page.getByRole('button', { name: 'Conditions here' }).click();
    const card = page.locator('#conditionsCard');
    await expect(card).toContainText('GPS spoofing likely');
    await expect(card).toContainText('The figures below are for the reported position');
    await expect(card.locator('a[href="https://gpsjam.org/"]')).toHaveCount(1);
  });

  test('a normal position gives no warning, and the card says it matches', async ({ page }) => {
    await openWithoutPoints(page, { latitude: HAIFA[0], longitude: HAIFA[1], accuracy: 6 }, { ipCountry: 'IL' });
    await page.getByRole('button', { name: 'Use my location' }).click();
    await expect(page.locator('.leaflet-marker-icon')).toHaveCount(1);
    await page.waitForTimeout(300);
    await expect(page.locator('#searchNotice')).toBeHidden();
    await page.getByRole('button', { name: 'Start over' }).click();
    await page.getByRole('button', { name: 'Conditions here' }).click();
    await expect(page.locator('#conditionsCard')).toContainText('✓ Your location matches your network (Israel). Reported accuracy ±6 m.');
  });
});

test('Conditions here without location access explains what to do instead', async ({ page }) => {
  await openSite(page, HAIFA, null, '');
  await page.evaluate(() => history.replaceState(null, '', location.pathname));
  await page.reload();
  await page.getByRole('button', { name: 'Conditions here' }).click();
  await expect(page.locator('#searchNotice')).toContainText('Click the map or search for a place first');
  await expect(page.locator('#conditionsCard')).toBeHidden();
});

test('Restricted areas: schools and hospitals can be switched off; no-fly sites can\'t', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro');
  await waitForResult(page);
  await expect(page.locator('#sitesSummary')).toHaveText('all avoided');
  const red = page.locator('.leaflet-overlay-pane path[stroke="#e6484f"]');
  const grey = page.locator('.leaflet-overlay-pane path[stroke="#8d9ab8"]');
  await expect(grey).toHaveCount(0);

  await page.locator('#sitesPanel > summary').click();
  await page.getByLabel('Schools').uncheck();
  await page.getByLabel('Hospitals').uncheck();
  // Heliports are no-fly in Israel: switching them off changes nothing.
  await page.getByLabel('Heliports').uncheck();
  await expect(page.locator('#sitesSummary')).toHaveText('3 types not avoided');
  await page.locator('#calcBtn').click();
  await waitForResult(page);

  await expect(grey).toHaveCount(2);
  await expect(red).toHaveCount(0);   // the school's and hospital's red shapes and rings are gone
  await expect(page.locator('#hazardInfo')).toContainText('Found 1 restricted area');
  await expect(page.locator('#hazardInfo')).toContainText('2 more (school, hospital), shown in grey, aren’t avoided because of your Restricted areas settings');
  await expect(page.locator('#noFlyWarning')).toContainText('Heliport (Pad)');
  expect(page.url()).toContain('skipSites=school,hospital,heliport');

  // Remembered on the next visit.
  await page.evaluate(() => history.replaceState(null, '', location.pathname));
  await page.reload();
  await page.locator('#sitesPanel > summary').click();
  await expect(page.getByLabel('Schools')).not.toBeChecked();
  await expect(page.getByLabel('Kindergartens')).toBeChecked();
});

test('a shared link carries the Restricted areas settings', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro&skipSites=school');
  await waitForResult(page);
  await expect(page.locator('#sitesSummary')).toHaveText('1 type not avoided');
  await expect(page.locator('.leaflet-overlay-pane path[stroke="#8d9ab8"]')).toHaveCount(1);
});

test('the result says roughly how many people live under the route', async ({ page }) => {
  // 50 people per 0.005-degree cell (~0.26 km2) is ~190 per km2; the route is ~1.5 km.
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro', { hazards: [], population: 50 });
  await waitForResult(page);
  const info = page.locator('#peopleInfo');
  await expect(info).toContainText(/About \d+ people live within 50 m either side of this route; the most crowded stretch is sparsely populated/);
  const n = Number((await info.textContent()).match(/About (\d+) people/)[1]);
  expect(n).toBeGreaterThan(22);
  expect(n).toBeLessThan(36);
  await expect(info).toContainText('EU GHS-POP 2025');
});

test('a route over fewer people becomes a third plan, with its own heights and flight plans', async ({ page }) => {
  // A crowded block (~6,000 per km2) on the middle of the straight line, nearly empty around it.
  const mid = [(HAIFA[0] + HAIFA_DEST[0]) / 2, (HAIFA[1] + HAIFA_DEST[1]) / 2];
  const population = (lat, lng) => Math.abs(lat - mid[0]) < 0.003 && Math.abs(lng - mid[1]) < 0.003 ? 1500 : 1;
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro', { hazards: [], population, flatGround: true });
  await waitForResult(page);
  const info = page.locator('#peopleInfo');
  await expect(info).toContainText(/A route over fewer people \(dashed purple on the map\): [\d.]+ km \(\+\d+%\), about \d+ people under it \(\d+% fewer\) — see the Fewer people plan/);
  const shortest = await page.locator('#distance').textContent();
  const tab = page.locator('#planPeopleBtn');
  await expect(tab).toBeVisible();
  await expect(tab).toContainText(/Fewer people.*%/);

  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  expect(parseFloat(await page.locator('#distance').textContent())).toBeGreaterThan(parseFloat(shortest));
  await expect(page.locator('#detourNote')).toHaveText(' (the route over fewer people)');
  await expect(page.locator('#heightfore')).toHaveText(/^\d+$/);
  const kmz = await downloadMission(page);
  expect(kmz.name).toBe('flytimizer-fewer-people-outbound.kmz');

  // Back to the fastest plan: its own route, distance and file names.
  await page.locator('#planFastBtn').click();
  await expect(page.locator('#distance')).toHaveText(shortest);
  expect((await downloadMission(page)).name).toBe('flytimizer-outbound.kmz');
});

test('a route over fewer people that can\'t be flown, even round the tall buildings, isn\'t offered, and the result says why', async ({ page }) => {
  const mid = [(HAIFA[0] + HAIFA_DEST[0]) / 2, (HAIFA[1] + HAIFA_DEST[1]) / 2];
  const population = (lat, lng) => Math.abs(lat - mid[0]) < 0.003 && Math.abs(lng - mid[1]) < 0.003 ? 1500 : 1;
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro', { hazards: [], population, flatGround: true, buildings: 'towerOnDetour' });
  await waitForResult(page);
  const info = page.locator('#peopleInfo');
  await expect(info).toContainText(/A route over fewer people was found, but it passes buildings too tall to fly over at the heights allowed today, and no way round them saves enough people, so it isn’t offered\./);
  await expect(page.locator('.leaflet-overlay-pane path[stroke="#8b5cf6"]')).toHaveAttribute('d', /^(M0 0)?$/);
  // The tab is still there, says why, and shows the fastest route.
  const tab = page.locator('#planPeopleBtn');
  await expect(tab).toContainText('not flyable');
  const distance = await page.locator('#distance').textContent();
  await tab.click();
  await expect(page.locator('#planNote')).toContainText('this is the fastest route');
  await expect(page.locator('#distance')).toHaveText(distance);
});

test('the Fewer people tab is always there: same as Fastest when no detour saves people, no data without the population file', async ({ page }) => {
  // Evenly spread people: no way round saves any.
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro', { hazards: [], population: 1500, flatGround: true });
  await waitForResult(page);
  const tab = page.locator('#planPeopleBtn');
  await expect(tab).toContainText('same as Fastest');
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#planNote')).toContainText('No way round passes over clearly fewer people');
  await expect(page.locator('#heightfore')).toHaveText(/^\d+$/);

  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro', { hazards: [] });
  await waitForResult(page);
  await expect(page.locator('#planPeopleBtn')).toContainText('no data');
});

test('a route over fewer people that meets a building too tall to fly over is looked for again round it', async ({ page }) => {
  const mid = [(HAIFA[0] + HAIFA_DEST[0]) / 2, (HAIFA[1] + HAIFA_DEST[1]) / 2];
  const population = (lat, lng) => Math.abs(lat - mid[0]) < 0.003 && Math.abs(lng - mid[1]) < 0.003 ? 1500 : 1;
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro', { hazards: [], population, flatGround: true, buildings: 'towerOnFirstDetour' });
  await waitForResult(page);
  const tab = page.locator('#planPeopleBtn');
  await expect(tab).toBeVisible();
  await expect(tab).toContainText(/Fewer people.*%/);
  await expect(page.locator('#peopleInfo')).toContainText('see the Fewer people plan');
  await tab.click();
  await expect(page.locator('#heightfore')).toHaveText(/^\d+$/);
});

test('without the population file the people line is left out', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro', { hazards: [] });
  await waitForResult(page);
  await expect(page.locator('#peopleInfo')).toBeHidden();
});

test('public shelters tagged as military bunkers are not treated as military sites', async ({ page }) => {
  const mid = [(HAIFA[0] + HAIFA_DEST[0]) / 2, (HAIFA[1] + HAIFA_DEST[1]) / 2];
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro', { hazards: [
    { type: 'node', id: 30, lat: mid[0] + 0.0005, lon: mid[1], tags: { military: 'bunker', amenity: 'shelter', name: 'מקלט ציבורי' } },
    { type: 'node', id: 31, lat: mid[0] - 0.0005, lon: mid[1], tags: { military: 'bunker', name: 'מקלט 8' } }
  ] });
  await waitForResult(page);
  await expect(page.locator('#noFlyWarning')).toBeHidden();
  await expect(page.locator('#hazardInfo')).toContainText('No schools, hospitals');
});

test('a failed OpenStreetMap lookup is reported, not silently ignored', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=air3', { overpassFail: true });
  await waitForResult(page);

  await expect(page.locator('#hazardInfo')).toContainText("Couldn't load restricted-area data");
  await expect(page.locator('#buildingInfo')).toContainText("Couldn't load building data");
  await expect(page.locator('#heightfore')).toHaveText(/^\d+$/);
});

test('without terrain data the flight-plan download is disabled', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mavic3classic', { elevFail: true });
  await waitForResult(page);

  await expect(page.locator('#terrainInfo')).toContainText("Couldn't load terrain elevation");
  await expect(page.locator('#wpmlButtons button')).toHaveCount(0);
});

test('photo mission in imperial units: one round-trip mission, tall building detoured', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=air3&mission=photo&dwell=90', { imperial: true, hazards: [], buildings: 'mixed' });
  await waitForResult(page);

  await expect(page.locator('#unitFore')).toHaveText('ft');
  await expect(page.locator('#distance')).toHaveText(/mi|ft/);
  await expect(page.locator('#buildingInfo')).toContainText('3 of which sit on the direct line');
  await expect(page.locator('#buildingInfo')).toContainText(/too tall to clear by \d+ ft within/);
  const kmz = await downloadMission(page);
  expect(kmz.name).toBe('flytimizer-round-trip.kmz');
});

test('many buildings on the line are climbed over instead of zigzagging round them', async ({ page }) => {
  // The fake forecast's wind changes hour by hour; at some UTC hours (5,
  // for one) it caps the ceiling low enough that the tallest buildings
  // get detoured. Fly at 12:30 UTC, like the GHSL test.
  const noon = new Date(); noon.setUTCHours(12, 30, 0, 0);
  await page.clock.setFixedTime(noon);
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=matrice300&payloadKg=1.9&payloadBackKg=0', { hazards: [], buildings: 'many' });
  await waitForResult(page);

  await expect(page.locator('#buildingInfo')).toContainText('6 of which sit on the direct line');
  await expect(page.locator('#buildingInfo')).toContainText('the tallest one we still climb over');
  await expect(page.locator('#buildingInfo')).toContainText("we won't recommend flying below");
  // Only buildings too tall for today's wind-limited ceiling get a detour.
  await expect(page.locator('#detourNote')).not.toContainText(/[2-9] buildings/);
});

test('a US route uses FAA rules and imperial units automatically', async ({ page }) => {
  await openSite(page, [40.37554, -74.60192], [40.383, -74.59], 'drone=mini4pro', { country: 'us' });
  await waitForResult(page);

  await expect(page.locator('#rulesInfo')).toContainText('United States (FAA)');
  await expect(page.locator('#unitFore')).toHaveText('ft');
});

test('with only a start point, Calculate plans a hover at that spot', async ({ page }) => {
  await openSite(page, HAIFA, null, 'drone=mini4pro');
  await page.locator('#calcBtn').click();
  await waitForResult(page);

  await expect(page.locator('#heightfore')).toHaveText(/^\d+$/);
});

test('the round-trip range is drawn around the start and can be hidden', async ({ page }) => {
  await openSite(page, HAIFA, null, 'drone=mini4pro');
  await page.locator('#calcBtn').click();
  await waitForResult(page);

  const outline = page.locator('.leaflet-overlay-pane path[stroke="#14b8a6"]');
  await expect(outline).toHaveCount(1);
  await expect(page.locator('#rangeText')).toContainText(/up to [\d.]+ km toward the \w+/);
  // With only a start point the map zooms out to show the whole range.
  // The outline's box is measured relative to the map's in the same
  // frame, since the page may still be scrolling to the result.
  const inMap = () => page.evaluate(() => {
    const m = document.getElementById('map').getBoundingClientRect();
    const o = document.querySelector('.leaflet-overlay-pane path[stroke="#14b8a6"]').getBoundingClientRect();
    return { left: o.left - m.left, top: o.top - m.top, right: m.right - o.right, bottom: m.bottom - o.bottom, height: o.height, mapHeight: m.height };
  });
  await expect.poll(async () => { const r = await inMap(); return r.height / r.mapHeight; }).toBeGreaterThan(0.4);
  const r = await inMap();
  for (const side of ['left', 'top', 'right', 'bottom']) expect(r[side], side).toBeGreaterThanOrEqual(-0.5);
  const map = await page.locator('#map').boundingBox();

  await page.getByLabel('Show range on the map').uncheck();
  await expect(outline).toHaveCount(0);
  await page.getByLabel('Show range on the map').check();
  await expect(outline).toHaveCount(1);

  // A click inside the range still sets the destination.
  await page.locator('#map').click({ position: { x: map.width / 2 + 40, y: map.height / 2 + 40 } });
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(2);
});

test('with a custom drone that has no battery figures, no range is shown', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro');
  await waitForResult(page);
  await expect(page.locator('#rangeInfo')).toBeVisible();
  // Custom drones can leave the battery size empty.
  await page.locator('#batt').evaluate(el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#calcBtn').click();
  await waitForResult(page);
  await expect(page.locator('#rangeInfo')).toBeHidden();
  await expect(page.locator('.leaflet-overlay-pane path[stroke="#14b8a6"]')).toHaveCount(0);
});

test('on a phone the recommended heights come before the warnings', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro');
  await waitForResult(page);

  const top = async sel => (await page.locator(sel).boundingBox()).y;
  await expect(page.locator('#noFlyWarning')).toBeVisible();
  expect(await top('#readoutFore')).toBeLessThan(await top('#noFlyWarning'));
  expect(await top('#readoutFore')).toBeLessThan(await top('#forecastStrip'));
  // The no-fly text refers to "the altitude or path shown above".
  await expect(page.locator('#noFlyWarning')).toContainText('shown above');
});

test('when no height is safe, that warning comes before everything else', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro', { windMul: 6 });
  await waitForResult(page);

  const top = async sel => (await page.locator(sel).boundingBox()).y;
  expect(await top('#flyWarning')).toBeLessThan(await top('#readoutFore'));
});

test('payload is a weight: older links with a weight factor are converted, and the max takeoff weight is checked', async ({ page }) => {
  // An older link: payload=2 means carrying the drone's own weight again (Neo 2: 151 g).
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=neo2&payload=2&payloadback=1');
  await expect(page.locator('#payloadKg')).toHaveValue('0.151');
  await expect(page.locator('#payloadBackKg')).toHaveValue('0');
  await expect(page.locator('#payloadNote')).toContainText('over 250 g');

  // The Matrice 300 RTK publishes a 9 kg max takeoff weight: 6.3 + 3 kg is over it.
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=matrice300&payloadKg=3&payloadBackKg=0');
  await waitForResult(page);
  await expect(page.locator('#mtow')).toHaveValue('9');
  await expect(page.locator('#weightWarning')).toContainText('over its 9 kg max takeoff weight');
  await expect(page.locator('#payloadNote')).toContainText('over its 9 kg max takeoff weight');
  await page.locator('#droneConfigPanel > summary').click();
  await page.locator('#payloadKg').fill('2');
  await expect(page.locator('#payloadNote')).toBeHidden();
});

test('Add to home screen: offered when the browser can install the site, and replays its prompt', async ({ page }) => {
  await openSite(page, HAIFA, null, '');
  const btn = page.locator('#installBtn');
  await expect(btn).toBeHidden();   // this browser hasn't offered to install
  await page.evaluate(() => {
    const e = new Event('beforeinstallprompt');
    e.prompt = () => { window.__prompted = true; };
    e.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(e);
  });
  await expect(btn).toBeVisible();
  await btn.click();
  expect(await page.evaluate(() => window.__prompted)).toBe(true);
  await expect(btn).toBeHidden();
});

test('Add to home screen on an iPhone explains the Share button', async ({ browser }) => {
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await openSite(page, HAIFA, null, '');
  await page.locator('#installBtn').click();
  await expect(page.locator('#installNotice')).toContainText('Add to Home Screen');
  await ctx.close();
});

test('new visitor: mission and drone come first, Calculate is always on screen, and a destination tap calculates', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSite(page, HAIFA, null, '');
  await page.evaluate(() => history.replaceState(null, '', location.pathname));
  await page.reload();
  // Step 1 is visible above the map.
  await expect(page.locator('.setup-panel #mission')).toBeVisible();
  await expect(page.locator('.setup-panel #droneModel')).toBeVisible();
  // The Calculate button is in view without scrolling.
  await expect(page.locator('#calcBtn')).toBeInViewport();
  // Start, then destination: the result comes without pressing anything.
  const map = await page.locator('#map').boundingBox();
  await page.mouse.click(map.x + map.width * 0.4, map.y + map.height * 0.6);
  await page.mouse.click(map.x + map.width * 0.6, map.y + map.height * 0.4);
  await waitForResult(page);
  await expect(page.locator('#heightfore')).toHaveText(/^\d+$/);
  // The two pins are told apart: A Start, B Destination.
  await expect(page.locator('.route-pin-start')).toHaveText('AStart');
  await expect(page.locator('.route-pin-end')).toHaveText('BDestination');
});

test('Calculate can be pressed again while it runs: the old calculation is dropped and the new one wins', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro', { overpassDelayMs: 1500 });
  const btn = page.locator('#calcBtn');
  await expect(btn).toHaveText('Calculating… (tap to restart)');
  await expect(btn).toBeEnabled();
  // Change the payload while it runs, then restart.
  await page.locator('#droneConfigPanel > summary').click();
  await page.locator('#payloadKg').fill('0.1');
  await btn.click();
  await waitForResult(page);
  await expect(btn).toHaveText('Find Optimal Route');
  await expect(page.locator('#heightfore')).toHaveText(/^\d+$/);
  expect(page.url()).toContain('payloadKg=0.1');
});

test('Start over during a calculation cancels it', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro', { overpassDelayMs: 1500 });
  await expect(page.locator('#calcProgress')).toBeVisible();
  await page.locator('#resetBtn').click();
  await expect(page.locator('#calcProgress')).toBeHidden();
  await expect(page.locator('#calcBtn')).toHaveText('Find Optimal Route');
  await page.waitForTimeout(3500);   // the lookups finish: nothing is drawn
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(0);
});

test('number fields open a numeric keypad on phones', async ({ page }) => {
  await openSite(page, HAIFA, null, 'drone=mini4pro');
  const fields = ['dwell', 'cruise', 'hor', 'asc', 'des', 'windres', 'batt', 'ftime', 'mass', 'mtow', 'health', 'drag', 'payloadKg', 'payloadBackKg'];
  for (const id of fields) await expect(page.locator('#' + id)).toHaveAttribute('inputmode', 'decimal');
  await expect(page.getByRole('textbox', { name: 'Search a place or address' })).toBeVisible();
});

test('Calculate without a start point says so in the page', async ({ page }) => {
  await openSite(page, HAIFA, null, '');
  await page.evaluate(() => history.replaceState(null, '', location.pathname)); // no shared route
  await page.reload();
  await page.locator('#calcBtn').click();
  await expect(page.locator('#calcNotice')).toBeVisible();
  await expect(page.locator('#calcNotice')).toContainText('Choose a start point first');
  await expect(page.locator('#result')).toBeHidden();
  await page.locator('#calcNotice .notice-close').click();
  await expect(page.locator('#calcNotice')).toBeHidden();
});

test('place search: no result is reported in the page, and the query is shown as text', async ({ page }) => {
  await openSite(page, HAIFA, null, '', { places: { 'Haifa port': [32.82, 35.0] } });
  const notice = page.locator('#searchNotice');

  await page.locator('#locationSearchInput').fill('<img src=x onerror="window.__xss=1">Nowhere');
  await page.locator('#locationSearchInput').press('Enter');
  await expect(notice).toContainText('No location found for "<img src=x onerror="window.__xss=1">Nowhere"');
  await expect(notice.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();

  // A successful search clears the message.
  await page.locator('#locationSearchInput').fill('Haifa port');
  await page.locator('#locationSearchBtn').click();
  await expect(notice).toBeHidden();
});

test('Use my location without permission explains what to do instead', async ({ page }) => {
  await openSite(page, HAIFA, null, '');
  await page.context().clearPermissions();
  await page.getByRole('button', { name: 'Use my location' }).click();
  await expect(page.locator('#searchNotice')).toContainText("Couldn't get your location");
});

test('if the link cannot be copied, Share shows it ready to copy', async ({ page }) => {
  await page.context().addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('blocked')) } });
  });
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro');
  await waitForResult(page);
  await page.locator('#shareRouteBtn').click();

  const notice = page.locator('#resultNotice');
  await expect(notice).toContainText('Copy this link to share the route');
  await expect(notice.locator('input')).toHaveValue(/from=32\.79400,34\.98900&to=32\.80300,35\.00100/);
  await expect(notice.locator('input')).toBeFocused();
});

test('the side view shows both legs', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro');
  await waitForResult(page);

  const chart = page.locator('#terrainProfile svg');
  await expect(chart).toContainText('ALTITUDE ABOVE SEA LEVEL (m) — OUTBOUND & RETURN');
  await expect(chart.locator('path.flight-out')).toHaveCount(1);
  await expect(chart.locator('path.flight-return')).toHaveCount(1);
  const back = await page.locator('#heightback').textContent();
  await expect(chart).toContainText('return (≥' + back + ' m AGL)');
});

// Last point of an SVG path's d attribute, as [x, y].
function lastPoint(d){
  const nums = d.replace(/Z\s*$/, '').trim().split(/[ML ,]+/).filter(Boolean).map(Number);
  return nums.slice(-2);
}

test('photo missions turn around in the air: the side view doesn\'t land at the destination', async ({ page }) => {
  for (const [mission, lands] of [['delivery', true], ['photo', false]]){
    await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro&mission=' + mission, { hazards: [], windMul: 0.3 });
    await waitForResult(page);
    const chart = page.locator('#terrainProfile svg');
    const ground = await chart.locator('path[fill-opacity="0.28"]').getAttribute('d');
    // The ground outline ends with the destination, then the bottom corner.
    const pts = ground.replace(/Z\s*$/, '').trim().split(' L');
    const groundY = Number(pts[pts.length - 2].split(',')[1]);
    const [, outY] = lastPoint(await chart.locator('path.flight-out').getAttribute('d'));
    if (lands) expect(Math.abs(outY - groundY)).toBeLessThan(0.5);
    else expect(groundY - outY).toBeGreaterThan(5);   // still well above the ground there
    const info = await page.locator('#terrainInfo').textContent();
    const [, up, down] = info.match(/climbs (\d+) m and descends (\d+) m/).map(Number);
    if (lands) expect(down).toBeGreaterThan(0);
    else expect(down).toBeLessThan(up);
  }
});

test('when both legs fly the same altitudes, the side view draws one line and says so', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=neo2', { windMul: 0.05, hazards: [], flatGround: true });
  await waitForResult(page);

  await expect(page.locator('#heightfore')).toHaveText(await page.locator('#heightback').textContent());
  const chart = page.locator('#terrainProfile svg');
  await expect(chart).toContainText('outbound & return, same height');
  await expect(chart.locator('path.flight-out')).toHaveCount(1);
  await expect(chart.locator('path.flight-return')).toHaveCount(0);
});

test('on a narrow phone the mission fields fit the screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openSite(page, HAIFA, null, '');
  const panel = await page.locator('#mission').locator('xpath=ancestor::section[1]').boundingBox();
  for (const id of ['#mission', '#dwell']){
    const box = await page.locator(id).locator('xpath=..').boundingBox();   // the field's box
    expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width);
  }
});

test('Start over clears the points, the route and the result', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro');
  await waitForResult(page);
  const reset = page.getByRole('button', { name: 'Start over' });
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(2);

  await reset.click();
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(0);
  await expect(page.locator('.leaflet-overlay-pane path')).toHaveCount(2);   // just the (now empty) route and suggestion lines
  expect(new URL(page.url()).search).toBe('');
  await expect(reset).toBeHidden();

  // The next map click is a new start point, and Calculate works from it.
  await page.locator('#map').click();   // waits for the scroll back to the map
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(1);
  await expect(reset).toBeVisible();
  await page.locator('#calcBtn').click();
  await waitForResult(page);
  await expect(page.locator('#heightfore')).toHaveText(/^\d+$/);
});

test('Start over is only offered once there is a point on the map', async ({ page }) => {
  await openSite(page, HAIFA, null, '');
  await page.evaluate(() => history.replaceState(null, '', location.pathname));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Start over' })).toBeHidden();
});

test('a failed wind forecast is reported, with Try again', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro', { forecastFail: true });
  const notice = page.locator('#calcNotice');
  await expect(notice).toContainText("Couldn't load the wind forecast", { timeout: 45000 });
  await expect(notice.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.locator('#result')).toBeHidden();
});

const require = createRequire(import.meta.url);
for (const scheme of ['light', 'dark']){
  test('no accessibility problems found by axe (' + scheme + ' theme)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro');
    await waitForResult(page);
    await page.locator('details').evaluateAll(ds => ds.forEach(d => { d.open = true; }));
    await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
    const violations = await page.evaluate(async () => {
      // The map's own controls and tiles are Leaflet's; the share buttons are AddToAny's.
      const r = await window.axe.run({ exclude: [['#map'], ['.a2a_kit']] }, { runOnly: ['wcag2a', 'wcag2aa', 'best-practice'], rules: { region: { enabled: false } } });
      return r.violations.map(v => v.id + ': ' + v.nodes.map(n => n.target.join(' ')).slice(0, 4).join(', '));
    });
    expect(violations).toEqual([]);
  });
}

test('JSZip is only downloaded once there is a flight plan to offer', async ({ page }) => {
  const jszipRequests = [];
  page.on('request', r => { if (r.url().includes('jszip')) jszipRequests.push(r.url()); });
  // The fake forecast varies by hour; at some hours the hover is too windy at the mission speed.
  const noon = new Date(); noon.setUTCHours(12, 30, 0, 0);
  await page.clock.setFixedTime(noon);
  await openSite(page, HAIFA, null, '');
  await page.waitForLoadState('load');
  expect(jszipRequests).toEqual([]);

  await page.locator('#calcBtn').click();
  await waitForResult(page);
  await expect.poll(() => jszipRequests.length).toBe(1);
  const kmz = await downloadMission(page);
  expect(kmz.files).toContain('wpmz/waylines.wpml');
});

test('if JSZip cannot be downloaded, the flight-plan download says so', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro', { jszipFail: true });
  await waitForResult(page);
  await page.locator('#wpmlButtons button').first().click();
  await expect(page.locator('#resultNotice')).toContainText("Couldn't load the file-packaging library");
});

// Events sent to Google Analytics (gtag pushes them onto window.dataLayer).
const gaEvents = page => page.evaluate(() => (window.dataLayer || []).filter(a => a[0] === 'event').map(a => [a[1], a[2]]));

test('usage events are sent to analytics, without coordinates', async ({ page }) => {
  await page.context().addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.resolve() } });
  });
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro');
  await waitForResult(page);
  await page.locator('#planEcoBtn').click();
  await page.locator('#forecastStrip [data-arg="3"]').click();
  await waitForResult(page);
  await downloadMission(page);
  await page.locator('#shareRouteBtn').click();
  await page.getByRole('button', { name: 'Start over' }).click();
  await page.locator('#calcBtn').click();

  const events = await gaEvents(page);
  const names = events.map(e => e[0]);
  expect(names).toEqual(expect.arrayContaining(['open_shared_link', 'calculate', 'select_plan', 'select_forecast_hour',
    'download_flight_plan', 'share_route', 'start_over']));
  const calcs = events.filter(e => e[0] === 'calculate').map(e => e[1]);
  expect(calcs[0]).toEqual({ result: 'ok', drone: 'mini4pro', mission: 'delivery', speed_mode: 'ground', country: 'IL', points: 2, distance_km: expect.any(Number), range_km: expect.any(Number) });
  expect(calcs[calcs.length - 1]).toEqual({ result: 'no_start' });
  expect(events.find(e => e[0] === 'select_plan')[1]).toEqual({ plan: 'eco' });
  expect(events.find(e => e[0] === 'share_route')[1]).toEqual({ method: 'copy' });
  // Nothing that locates the person: no coordinates in any event.
  expect(JSON.stringify(events)).not.toMatch(/32\.79|34\.98|35\.00|32\.80/);
});

for (const guide of ['guides/', 'guides/best-drone-altitude-in-wind.html', 'guides/drone-battery-in-wind.html', 'guides/is-the-straight-line-the-best-drone-route.html', 'guides/how-far-can-my-drone-fly-and-return.html']){
  for (const scheme of ['light', 'dark']){
    test('guide page ' + guide + ' has no accessibility problems (' + scheme + ')', async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openSite(page, HAIFA, null, '');     // installs the fakes
      await page.goto('https://flytimizer.test/' + guide);
      await expect(page.locator('h1')).toBeVisible();
      await expect(page.locator('a.cta')).toHaveAttribute('href', '../');
      await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
      const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'best-practice'] }))
        .violations.map(v => v.id + ': ' + v.nodes.map(n => n.target.join(' ')).slice(0, 4).join(', ')));
      expect(violations).toEqual([]);
    });
  }
}

test('the main page links to the guides', async ({ page }) => {
  await openSite(page, HAIFA, null, '');
  await page.getByRole('link', { name: 'Wind changes with height' }).click();
  await expect(page.locator('h1')).toHaveText('What altitude should I fly my drone in wind?');
  await page.locator('a.cta').click();
  await expect(page.locator('#map')).toBeVisible();
});

test('speed in wind: ground speed is the default, air speed changes the result and is shared', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro');
  await waitForResult(page);
  await expect(page.locator('#speedMode')).toHaveValue('ground');
  expect(page.url()).toContain('speedMode=ground');
  const groundTimes = await page.locator('.wind-table').textContent();

  await page.locator('#speedMode').selectOption('air');
  await page.locator('#calcBtn').click();
  await waitForResult(page);
  expect(page.url()).toContain('speedMode=air');
  // Somewhere on this route one leg has the wind behind it, so holding
  // airspeed makes that leg faster than holding ground speed.
  expect(await page.locator('.wind-table').textContent()).not.toBe(groundTimes);

  // A shared link brings the mode with it.
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro&speedMode=air');
  await waitForResult(page);
  await expect(page.locator('#speedMode')).toHaveValue('air');
});

test('buildings along the route slow the wind used for the times, and the setting switches it off', async ({ page }) => {
  // A model that leaves half the wind everywhere it's fully built up.
  const urbanModel = { init: Math.log(0.5), lr: 0.1, w_full: 0.25, trees: [] };
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro', { ghsl: 20, builtS: 0.4, urbanModel, hazards: [], flatGround: true });
  await waitForResult(page);
  const info = page.locator('#urbanWindInfo');
  await expect(info).toHaveCSS('display', 'block');
  await expect(info).toContainText('Buildings along the route: the wind is about 50% weaker than over open ground at 30 m');
  await expect(info).toContainText('the gust and crosswind checks keep the forecast wind');
  const ws30 = async () => Number((await page.locator('#ws30').textContent()).match(/[\d.]+/)[0]);
  const slowed = await ws30();

  await page.evaluate(() => { document.getElementById('droneConfigPanel').open = true; });
  await page.locator('#urbanWind').uncheck();
  await expect(info).toHaveCSS('display', 'none');
  await expect.poll(ws30).toBeGreaterThan(slowed * 1.5);
  // Half the wind, within the rounding of the numbers shown.
  const ratio = slowed / await ws30();
  expect(ratio).toBeGreaterThan(0.42);
  expect(ratio).toBeLessThan(0.58);
});

test('without the building data the forecast wind is used as it is', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=mini4pro', { ghsl: 20, hazards: [], flatGround: true,
    urbanModel: { init: Math.log(0.5), lr: 0.1, w_full: 0.25, trees: [] } });
  await waitForResult(page);
  await expect(page.locator('#urbanWindInfo')).toHaveCSS('display', 'none');
});
