// Building heights where OpenStreetMap has none, from the EU's Global
// Human Settlement Layer: GHS-BUILT-H R2023A, the average height of the
// buildings in each ~90 m cell (3 arc-seconds), 2018. Licence CC BY 4.0
// (credited in the page footer).
//
// The whole world is one 6 GB tiled GeoTIFF on a public S3 bucket that
// allows cross-origin range requests, so the browser reads just the
// header once and then only the 512 x 512 tile(s) the route crosses -
// typically one tile of a few hundred kB.
//
// It's a cell AVERAGE: a lone tower in a cell of low buildings comes
// out much lower than it is. So it only ever raises a building whose
// height OSM doesn't give (never lowers one), and the result says the
// height is an estimate.

export var GHSL_URL = 'https://jrc-ghsl.s3.eu-central-1.amazonaws.com/ghs-built-h-anbh/r2023a/4326/3asec/2018/GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_4326_3ss_V1_0.tif';
export var GHSL_FETCH_TIMEOUT_MS = 10000;
export var GHSL_HEADER_BYTES = 16384;
var GHSL_TILE_CACHE_MAX = 4;

// Reads `length` bytes from `start`. Tests swap ghslIO.fetchRange.
async function fetchRange(start, length){
  var controller = new AbortController();
  var timer = setTimeout(function(){ controller.abort(); }, GHSL_FETCH_TIMEOUT_MS);
  try {
    var response = await fetch(GHSL_URL, { headers: { Range: 'bytes=' + start + '-' + (start + length - 1) }, signal: controller.signal });
    if (response.status !== 206) throw new Error('GHSL HTTP ' + response.status);
    return await response.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

export var ghslIO = { fetchRange: fetchRange };

// The parts of a little-endian BigTIFF header we need. Throws if the
// file isn't laid out the way this reader expects (tiled, one 32-bit
// float band, deflate or no compression, no predictor).
export function parseGhslHeader(buf){
  var dv = new DataView(buf);
  if (dv.getUint16(0, true) !== 0x4949 || dv.getUint16(2, true) !== 43) throw new Error('GHSL: not a little-endian BigTIFF');
  var ifd = Number(dv.getBigUint64(8, true));
  var n = Number(dv.getBigUint64(ifd, true));
  var SIZE = { 3: 2, 4: 4, 12: 8, 16: 8 };
  var tags = {};
  for (var i = 0; i < n; i++){
    var e = ifd + 8 + i * 20;
    var tag = dv.getUint16(e, true), type = dv.getUint16(e + 2, true);
    var count = Number(dv.getBigUint64(e + 4, true));
    var size = SIZE[type];
    if (!size) continue;
    var at = size * count <= 8 ? e + 12 : Number(dv.getBigUint64(e + 12, true));
    tags[tag] = { type: type, count: count, at: at };
  }
  function values(tag){
    var t = tags[tag];
    if (!t) throw new Error('GHSL: missing TIFF tag ' + tag);
    if (t.type === 16) return { at: t.at, size: 8 };   // offsets arrays: read later, by tile
    if (t.at + SIZE[t.type] * t.count > buf.byteLength) throw new Error('GHSL: header larger than expected');
    var out = [];
    for (var k = 0; k < t.count; k++){
      var p = t.at + k * SIZE[t.type];
      out.push(t.type === 3 ? dv.getUint16(p, true) : t.type === 4 ? dv.getUint32(p, true) : dv.getFloat64(p, true));
    }
    return out;
  }
  var compression = values(259)[0];
  if (values(258)[0] !== 32 || values(339)[0] !== 3) throw new Error('GHSL: expected 32-bit float samples');
  if (compression !== 1 && compression !== 8 && compression !== 32946) throw new Error('GHSL: unsupported compression ' + compression);
  if (tags[317] && values(317)[0] !== 1) throw new Error('GHSL: predictors not supported');
  var scale = values(33550), tie = values(33922);
  var counts = tags[325];
  return {
    width: values(256)[0], height: values(257)[0],
    tileW: values(322)[0], tileH: values(323)[0],
    deflate: compression !== 1,
    offsetsAt: tags[324].at,
    countsAt: counts.at, countsSize: counts.type === 16 ? 8 : 4,
    // Top-left corner of the top-left pixel, and pixel size, in degrees.
    x0: tie[3] - tie[0] * scale[0], y0: tie[4] + tie[1] * scale[1], dx: scale[0], dy: scale[1]
  };
}

async function inflate(buf){
  var stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Response(stream).arrayBuffer();
}

var headerPromise = null;
var tileCache = new Map();

// Forget the cached header and tiles (tests, or after a failure).
export function resetGhsl(){
  headerPromise = null;
  tileCache.clear();
}

function getHeader(){
  if (!headerPromise){
    headerPromise = ghslIO.fetchRange(0, GHSL_HEADER_BYTES).then(parseGhslHeader);
    headerPromise.catch(function(){ headerPromise = null; });
  }
  return headerPromise;
}

async function getTile(h, tileRow, tileCol){
  var key = tileRow + ',' + tileCol;
  if (tileCache.has(key)) return tileCache.get(key);
  var idx = tileRow * Math.ceil(h.width / h.tileW) + tileCol;
  var where = await Promise.all([ghslIO.fetchRange(h.offsetsAt + idx * 8, 8), ghslIO.fetchRange(h.countsAt + idx * h.countsSize, h.countsSize)]);
  var offset = Number(new DataView(where[0]).getBigUint64(0, true));
  var length = h.countsSize === 8 ? Number(new DataView(where[1]).getBigUint64(0, true)) : new DataView(where[1]).getUint32(0, true);
  var data = null;   // an empty tile (open sea) is stored with length 0
  if (length > 0){
    var raw = await ghslIO.fetchRange(offset, length);
    data = new Float32Array(h.deflate ? await inflate(raw) : raw);
  }
  tileCache.set(key, data);
  if (tileCache.size > GHSL_TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  return data;
}

// Average building height (m) around each point: the highest of the
// cell it's in and the cells next to it (within the same tile), since
// a building's centre can sit at a cell edge. 0 where there are no
// buildings, null outside the data. Rejects if the data can't be read.
export async function ghslHeights(points){
  var h = await getHeader();
  var tiles = new Map();
  var cells = points.map(function(p){
    var col = Math.floor((p.lng - h.x0) / h.dx), row = Math.floor((h.y0 - p.lat) / h.dy);
    if (col < 0 || row < 0 || col >= h.width || row >= h.height) return null;
    var key = Math.floor(row / h.tileH) + ',' + Math.floor(col / h.tileW);
    if (!tiles.has(key)) tiles.set(key, getTile(h, Math.floor(row / h.tileH), Math.floor(col / h.tileW)));
    return { key: key, r: row % h.tileH, c: col % h.tileW };
  });
  var loaded = {};
  var keys = Array.from(tiles.keys());
  var data = await Promise.all(keys.map(function(k){ return tiles.get(k); }));
  keys.forEach(function(k, i){ loaded[k] = data[i]; });
  return cells.map(function(cell){
    if (!cell) return null;
    var t = loaded[cell.key];
    if (!t) return 0;
    var best = 0;
    for (var dr = -1; dr <= 1; dr++){
      for (var dc = -1; dc <= 1; dc++){
        var r = cell.r + dr, c = cell.c + dc;
        if (r < 0 || c < 0 || r >= h.tileH || c >= h.tileW) continue;
        var v = t[r * h.tileW + c];
        if (v > best && isFinite(v)) best = v;
      }
    }
    return best;
  });
}
