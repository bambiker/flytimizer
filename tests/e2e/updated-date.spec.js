const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { openSite } = require('./site');

// The "Updated" date in the footer counts calendar days in the
// visitor's time zone, not 24-hour periods. (GitHub is unreachable in
// the tests, so it shows the date written in index.html.)
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const written = html.match(/data-updated="(\d{4}-\d{2}-\d{2})"/)[1];

// The browser runs in UTC, so these are its local times too.
function utcTime(dayOffset, hhmm){
  const d = new Date(written + 'T' + hhmm + ':00Z');
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d;
}

test.use({ timezoneId: 'UTC' });

for (const [label, dayOffset, hhmm, expected] of [
  ['the same day', 0, '23:30', '(today)'],
  ['early the next morning', 1, '07:00', '(yesterday)'],
  ['late the next evening', 1, '23:30', '(yesterday)'],
  ['two days later, just after midnight', 2, '00:10', '(2 days ago)']
]){
  test('updated date reads ' + expected + ' ' + label, async ({ page }) => {
    await page.clock.setFixedTime(utcTime(dayOffset, hhmm));
    await openSite(page, [32.794, 34.989], null, '');
    await expect(page.locator('#lastUpdatedDate')).toContainText(expected);
  });
}
