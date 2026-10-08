// Imports the site's modules and merges their exports into one object,
// so tests can call site.forecastAt(...) etc. Module top levels only
// declare things (start-up work happens in app.js), so they load in
// Node without a DOM or Leaflet.
const FILES = ['core', 'units', 'osm', 'routing', 'terrain', 'battery', 'calc', 'range', 'rules'];

export async function loadSite(){
  const site = {};
  for (const name of FILES) Object.assign(site, await import('../../js/' + name + '.js'));
  return site;
}
