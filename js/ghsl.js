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
//
// The same reader serves GHS-POP R2023A (people living in each cell,
// 2025 estimate, same grid and licence) for counting how many people
// live under a route (people.js).

export var GHSL_URL = 'https://jrc-ghsl.s3.eu-central-1.amazonaws.com/ghs-built-h-anbh/r2023a/4326/3asec/2018/GHS_BUILT_H_ANBH_E2018_GLOBE_R2023A_4326_3ss_V1_0.tif';
export var GHSL_POP_URL = 'https://jrc-ghsl.s3.eu-central-1.amazonaws.com/ghs-pop/r2023a/4326/3asec/2025/GHS_POP_E2025_GLOBE_R2023A_4326_3ss_V1_0.tif';
// GHS-BUILT-S R2023A: square metres of buildings in each cell (2020),
// same grid - with the heights it gives how built-up the area around
// the route is, for the building effect on the wind (urbanwind.js).
export var GHSL_BUILT_S_URL = 'https://jrc-ghsl.s3.eu-central-1.amazonaws.com/ghs-built-s/r2023a/4326/3asec/2020/GHS_BUILT_S_E2020_GLOBE_R2023A_4326_3ss_V1_0.tif';
export var GHSL_FETCH_TIMEOUT_MS = 10000;
export var GHSL_HEADER_BYTES = 16384;
var GHSL_TILE_CACHE_MAX = 4;

// Reads `length` bytes from `start` of the file at `url`. Tests swap
// ghslIO.fetchRange.
async function fetchRange(start, length, url){
  var controller = new AbortController();
  var timer = setTimeout(function(){ controller.abort(); }, GHSL_FETCH_TIMEOUT_MS);
  try {
    var response = await fetch(url || GHSL_URL, { headers: { Range: 'bytes=' + start + '-' + (start + length - 1) }, signal: controller.signal });
    if (response.status !== 206) throw new Error('GHSL HTTP ' + response.status);
    return await response.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

export var ghslIO = { fetchRange: fetchRange };

// The parts of a little-endian BigTIFF header we need. Throws if the
// file isn't laid out the way this reader expects (tiled, one band of
// 32- or 64-bit floats or 8-, 16- or 32-bit integers, deflate or no
// compression, no predictor).
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
  var bits = values(258)[0];
  var format = tags[339] ? values(339)[0] : 1;          // 1 unsigned, 2 signed, 3 float
  var sample = { '3:32': 'f32', '3:64': 'f64', '1:8': 'u8', '1:16': 'u16', '1:32': 'u32', '2:16': 'i16', '2:32': 'i32' }[format + ':' + bits];
  if (!sample) throw new Error('GHSL: expected 32- or 64-bit float samples');
  if (compression !== 1 && compression !== 8 && compression !== 32946) throw new Error('GHSL: unsupported compression ' + compression);
  if (tags[317] && values(317)[0] !== 1) throw new Error('GHSL: predictors not supported');
  var scale = values(33550), tie = values(33922);
  var counts = tags[325];
  return {
    width: values(256)[0], height: values(257)[0],
    tileW: values(322)[0], tileH: values(323)[0],
    deflate: compression !== 1, bits: bits, sample: sample,
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

var headerPromises = new Map();
var tileCache = new Map();

// Forget the cached headers and tiles (tests, or after a failure).
export function resetGhsl(){
  headerPromises.clear();
  tileCache.clear();
}

function getHeader(url){
  if (!headerPromises.has(url)){
    var p = ghslIO.fetchRange(0, GHSL_HEADER_BYTES, url).then(parseGhslHeader);
    p.catch(function(){ headerPromises.delete(url); });
    headerPromises.set(url, p);
  }
  return headerPromises.get(url);
}

async function getTile(url, h, tileRow, tileCol){
  var key = url + '|' + tileRow + ',' + tileCol;
  if (tileCache.has(key)) return tileCache.get(key);
  var idx = tileRow * Math.ceil(h.width / h.tileW) + tileCol;
  var where = await Promise.all([ghslIO.fetchRange(h.offsetsAt + idx * 8, 8, url), ghslIO.fetchRange(h.countsAt + idx * h.countsSize, h.countsSize, url)]);
  var offset = Number(new DataView(where[0]).getBigUint64(0, true));
  var length = h.countsSize === 8 ? Number(new DataView(where[1]).getBigUint64(0, true)) : new DataView(where[1]).getUint32(0, true);
  var data = null;   // an empty tile (open sea) is stored with length 0
  if (length > 0){
    var raw = await ghslIO.fetchRange(offset, length, url);
    var bytes = h.deflate ? await inflate(raw) : raw;
    var Arr = { f32: Float32Array, f64: Float64Array, u8: Uint8Array, u16: Uint16Array, u32: Uint32Array, i16: Int16Array, i32: Int32Array }[h.sample || (h.bits === 64 ? 'f64' : 'f32')];
    data = new Arr(bytes);
  }
  tileCache.set(key, data);
  if (tileCache.size > GHSL_TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  return data;
}

// The value of the cell under each point - or, with `neighbours`, the
// highest of that cell and the ones around it (within the same tile).
// 0 where the data is empty, null outside it. Rejects if the file
// can't be read. Also returns the file's cell size in degrees.
export async function ghslCells(url, points, neighbours){
  var h = await getHeader(url);
  var tiles = new Map();
  var cells = points.map(function(p){
    var col = Math.floor((p.lng - h.x0) / h.dx), row = Math.floor((h.y0 - p.lat) / h.dy);
    if (col < 0 || row < 0 || col >= h.width || row >= h.height) return null;
    var key = Math.floor(row / h.tileH) + ',' + Math.floor(col / h.tileW);
    if (!tiles.has(key)) tiles.set(key, getTile(url, h, Math.floor(row / h.tileH), Math.floor(col / h.tileW)));
    return { key: key, r: row % h.tileH, c: col % h.tileW };
  });
  var loaded = {};
  var keys = Array.from(tiles.keys());
  var data = await Promise.all(keys.map(function(k){ return tiles.get(k); }));
  keys.forEach(function(k, i){ loaded[k] = data[i]; });
  var span = neighbours ? 1 : 0;
  var values = cells.map(function(cell){
    if (!cell) return null;
    var t = loaded[cell.key];
    if (!t) return 0;
    var best = 0;
    for (var dr = -span; dr <= span; dr++){
      for (var dc = -span; dc <= span; dc++){
        var r = cell.r + dr, c = cell.c + dc;
        if (r < 0 || c < 0 || r >= h.tileH || c >= h.tileW) continue;
        var v = t[r * h.tileW + c];
        if (v > best && isFinite(v)) best = v;
      }
    }
    return best;
  });
  return { values: values, dx: h.dx, dy: h.dy };
}

// Average building height (m) around each point: the highest of the
// cell it's in and the cells next to it, since a building's centre can
// sit at a cell edge. 0 where there are no buildings, null outside the
// data. Rejects if the data can't be read.
export async function ghslHeights(points){
  return (await ghslCells(GHSL_URL, points, true)).values;
}

// Every cell of the file between the given latitudes and longitudes, as
// one grid (rows north to south): { values, rows, cols, top, left, dy,
// dx }, top/left being the outer corner of the first cell. Empty tiles
// read as 0, cells outside the file as NaN. Rejects if the file can't
// be read, or if the area is larger than maxCells.
export async function ghslGrid(url, south, west, north, east, maxCells){
  var h = await getHeader(url);
  var c0 = Math.floor((west - h.x0) / h.dx), c1 = Math.floor((east - h.x0) / h.dx);
  var r0 = Math.floor((h.y0 - north) / h.dy), r1 = Math.floor((h.y0 - south) / h.dy);
  var rows = r1 - r0 + 1, cols = c1 - c0 + 1;
  if (rows * cols > (maxCells || 400000)) throw new Error('GHSL: area too large');
  var values = new Float32Array(rows * cols).fill(NaN);
  var jobs = [];
  for (var tr = Math.floor(Math.max(r0, 0) / h.tileH); tr <= Math.floor(Math.min(r1, h.height - 1) / h.tileH); tr++){
    for (var tc = Math.floor(Math.max(c0, 0) / h.tileW); tc <= Math.floor(Math.min(c1, h.width - 1) / h.tileW); tc++){
      jobs.push({ tr: tr, tc: tc, data: getTile(url, h, tr, tc) });
    }
  }
  var datas = await Promise.all(jobs.map(function(j){ return j.data; }));
  jobs.forEach(function(j, k){
    var t = datas[k];
    for (var r = 0; r < h.tileH; r++){
      var row = j.tr * h.tileH + r;
      if (row < r0 || row > r1 || row >= h.height) continue;
      for (var c = 0; c < h.tileW; c++){
        var col = j.tc * h.tileW + c;
        if (col < c0 || col > c1 || col >= h.width) continue;
        var v = t ? t[r * h.tileW + c] : 0;
        values[(row - r0) * cols + (col - c0)] = isFinite(v) ? v : 0;
      }
    }
  });
  return { values: values, rows: rows, cols: cols, top: h.y0 - r0 * h.dy, left: h.x0 + c0 * h.dx, dy: h.dy, dx: h.dx };
}
