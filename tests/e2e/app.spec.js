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
  await expect(page.locator('#buildingInfo')).toContainText('taller than');
  const kmz = await downloadMission(page);
  expect(kmz.name).toBe('flytimizer-round-trip.kmz');
});

test('many buildings on the line are climbed over instead of zigzagging round them', async ({ page }) => {
  await openSite(page, HAIFA, HAIFA_DEST, 'drone=matrice300&payload=1.3&payloadback=1', { hazards: [], buildings: 'many' });
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
  const map = await page.locator('#map').boundingBox();
  await expect.poll(async () => (await outline.boundingBox()).height).toBeGreaterThan(map.height * 0.4);
  const box = await outline.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(map.x);
  expect(box.y).toBeGreaterThanOrEqual(map.y);
  expect(box.x + box.width).toBeLessThanOrEqual(map.x + map.width);
  expect(box.y + box.height).toBeLessThanOrEqual(map.y + map.height);

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

test('number fields open a numeric keypad on phones', async ({ page }) => {
  await openSite(page, HAIFA, null, 'drone=mini4pro');
  const fields = ['dwell', 'hor', 'asc', 'des', 'windres', 'batt', 'ftime', 'mass', 'health', 'drag', 'payload', 'payloadback'];
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
  await expect(page.locator('.leaflet-overlay-pane path')).toHaveCount(1);   // just the (now empty) route line
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

for (const guide of ['guides/', 'guides/best-drone-altitude-in-wind.html', 'guides/drone-battery-in-wind.html', 'guides/is-the-straight-line-the-best-drone-route.html']){
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
