// Loads the site's classic scripts into one Node vm context, so their
// global functions can be unit-tested without a browser. Only files
// whose top-level code doesn't touch the DOM or Leaflet are loaded.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const FILES = ['core', 'units', 'osm', 'routing', 'terrain', 'battery', 'calc'];

function loadSite(){
  const ctx = vm.createContext({ console });
  for (const name of FILES){
    const file = path.join(__dirname, '..', '..', 'js', name + '.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  }
  return ctx;
}

module.exports = { loadSite };
