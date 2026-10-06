import * as base from '@playwright/test';
import JSZip from 'jszip';
import fs from 'node:fs';
import { openSite, waitForResult } from './site.js';

// Every test fails on an uncaught page error or console error.
const test = base.test.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
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
