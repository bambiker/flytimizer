// Serves the site from disk and fakes every external service, so the
// app runs offline and deterministically.
//
// Scenario options:
//   windMul       multiply all forecast wind speeds and gusts
//   overpassFail  Overpass answers HTTP 500
//   elevFail      the elevation API answers HTTP 500
//   flatGround    every elevation is 40 m
//   forecastFail  the forecast API answers HTTP 500
//   jszipFail     the JSZip script can't be downloaded
//   hazards       restricted sites near the route (default: a set
//                 including one with an HTML-injection name)
//   buildings     'nearby' (default), 'mixed' or 'many' on the line
//   country       ISO code Nominatim reports (default 'il')
//   imperial      saved unit preference
//   places        place-search results: { 'query text': [lat, lng] }
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const MODULES = path.join(ROOT, 'node_modules');
const SITE = 'https://flytimizer.test';
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.xml': 'application/xml' };

const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

function forecast(windMul){
  const t0 = new Date(); t0.setUTCHours(0, 0, 0, 0);
  const h = { time: [] };
  ['wind_speed_10m', 'wind_speed_80m', 'wind_speed_120m', 'wind_speed_180m', 'wind_direction_10m', 'wind_direction_80m',
   'wind_direction_120m', 'wind_direction_180m', 'wind_gusts_10m', 'visibility', 'precipitation_probability',
   'precipitation', 'temperature_2m'].forEach(k => { h[k] = []; });
  for (let i = 0; i < 72; i++){
    h.time.push(new Date(t0.getTime() + i * 3600e3).toISOString().slice(0, 16));
    h.wind_speed_10m.push(windMul * (10 + i % 5));
    h.wind_speed_80m.push(windMul * (18 + i % 7));
    h.wind_speed_120m.push(windMul * (24 + i % 3));
    h.wind_speed_180m.push(windMul * 28);
    h.wind_direction_10m.push(240 + (i % 3) * 40);
    h.wind_direction_80m.push(250 + (i % 4) * 10);
    h.wind_direction_120m.push(70 + (i % 5) * 30);
    h.wind_direction_180m.push(80);
    h.wind_gusts_10m.push(windMul * (20 + i % 6));
    h.visibility.push(20000 - (i % 4) * 3000);
    h.precipitation_probability.push((i * 7) % 60);
    h.precipitation.push(i % 9 === 0 ? 0.4 : 0);
    h.temperature_2m.push((i % 4) * 6 - 3);
  }
  return { hourly: h };
}

function square(c, d){
  return [{ lat: c.lat - d, lon: c.lon - d }, { lat: c.lat + d, lon: c.lon - d }, { lat: c.lat + d, lon: c.lon + d },
          { lat: c.lat - d, lon: c.lon + d }, { lat: c.lat - d, lon: c.lon - d }];
}

// Opens index.html?<query> with the fakes installed.
export async function openSite(page, from, to, query, sc = {}){
  const [fla, flo] = from;
  const [tla, tlo] = to || from;
  const along = t => ({ lat: fla + (tla - fla) * t, lon: flo + (tlo - flo) * t });
  const ctx = page.context();

  if (sc.imperial !== undefined){
    await ctx.addInitScript(imp => { localStorage.setItem('flytimizerUnits', JSON.stringify(imp ? 'imperial' : 'metric')); }, sc.imperial);
  }
  // Anything not handled below (tiles, fonts, analytics, share buttons) is blocked.
  await ctx.route(/./, r => r.abort());
  await ctx.route(SITE + '/**', r => {
    let file = path.join(ROOT, decodeURIComponent(new URL(r.request().url()).pathname));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');   // like GitHub Pages
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) return r.fulfill({ status: 404 });
    r.fulfill({ status: 200, body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
  });
  await ctx.route(/^https:\/\/unpkg\.com\/(leaflet|jszip)@[^/]+\/(.*)$/, r => {
    const m = r.request().url().match(/unpkg\.com\/(leaflet|jszip)@[^/]+\/(.*)$/);
    if (m[1] === 'jszip' && sc.jszipFail) return r.fulfill({ status: 503, body: 'error' });
    const file = path.join(MODULES, m[1], m[2]);
    r.fulfill({ status: 200, body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] });
  });
  await ctx.route(/api\.open-meteo\.com\/v1\/forecast/, r => sc.forecastFail ? r.fulfill({ status: 500, body: 'error' }) : json(r, forecast(sc.windMul || 1)));
  await ctx.route(/api\.open-meteo\.com\/v1\/elevation/, r => {
    if (sc.elevFail) return r.fulfill({ status: 500, body: 'error' });
    const u = new URL(r.request().url());
    const la = u.searchParams.get('latitude').split(',').map(Number);
    const lo = u.searchParams.get('longitude').split(',').map(Number);
    json(r, { elevation: la.map((a, i) => sc.flatGround ? 40 : Math.round(40 + 3000 * (a - fla) + 25 * Math.sin((lo[i] - flo) * 900))) });
  });
  await ctx.route(/nominatim\.openstreetmap\.org\/search/, r => {
    const q = new URL(r.request().url()).searchParams.get('q');
    const hit = (sc.places || {})[q];
    json(r, hit ? [{ lat: String(hit[0]), lon: String(hit[1]), display_name: q }] : []);
  });
  await ctx.route(/nominatim\.openstreetmap\.org\/reverse/, r => json(r, { address: { country_code: sc.country || 'il', country: sc.country === 'us' ? 'United States' : 'Israel' } }));
  await ctx.route(/overpass|maps\.mail\.ru/, r => {
    if (sc.overpassFail) return r.fulfill({ status: 500, body: 'error' });
    const body = decodeURIComponent((r.request().postData() || r.request().url()).replace(/\+/g, ' '));
    if (/building/.test(body) && !/amenity/.test(body)){
      const kind = sc.buildings || 'nearby';
      let els;
      if (kind === 'mixed'){
        els = [0.3, 0.5, 0.7].map((t, k) => ({ type: 'way', id: 100 + k, center: along(t), geometry: square(along(t), 0.00008), tags: { building: 'yes', height: ['12', '200', '25'][k] } }));
      } else if (kind === 'many'){
        els = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((t, k) => ({ type: 'way', id: 200 + k, center: along(t), geometry: square(along(t), 0.00008), tags: { building: 'yes', height: String(8 + k * 5) } }));
      } else {
        const off = c => ({ lat: c.lat + 0.004, lon: c.lon });
        els = [{ type: 'way', id: 1, center: off(along(0.4)), geometry: square(off(along(0.4)), 0.0001), tags: { building: 'apartments', height: '45' } },
               { type: 'way', id: 2, center: off(along(0.6)), geometry: square(off(along(0.6)), 0.0001), tags: { building: 'yes', 'building:levels': '4' } }];
      }
      return json(r, { elements: els });
    }
    const hazards = sc.hazards !== undefined ? sc.hazards : [
      { type: 'node', id: 10, lat: fla + (tla - fla) * 0.18, lon: flo + (tlo - flo) * 0.18 + 0.0003, tags: { amenity: 'school', name: '<img src=x onerror="window.__xss=1">Evil School' } },
      { type: 'way', id: 11, center: along(0.7), geometry: square(along(0.7), 0.0004), tags: { amenity: 'hospital', name: 'Rambam & <b>Sons</b>' } },
      { type: 'node', id: 12, lat: fla + (tla - fla) * 0.5 + 0.001, lon: flo + (tlo - flo) * 0.5, tags: { aeroway: 'heliport', name: 'Pad' } }
    ];
    json(r, { elements: hazards });
  });

  const q = 'from=' + from.join(',') + (to ? '&to=' + to.join(',') : '') + (query ? '&' + query : '');
  await page.goto(SITE + '/index.html?' + q);
}

// Waits until a calculation has finished and its result is shown.
export async function waitForResult(page){
  await page.waitForFunction(() => {
    const result = document.getElementById('result');
    const progress = document.getElementById('calcProgress');
    return result && result.style.display === 'block' && progress && progress.hidden;
  }, null, { timeout: 45000 });
}

