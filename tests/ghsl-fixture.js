// A small GeoTIFF laid out like the GHSL files (little-endian, tiled,
// one deflated float32 band), for the tests: BigTIFF like building
// height and population, or with `classic` a classic TIFF like built-up
// surface. value(lat, lng) gives each cell's value; cells are `dx` degrees.
import zlib from 'node:zlib';

export function makeGhslTiff({ x0, y0, dx, width, height, tile = 16, value, bits = 32, classic = false }){
  const across = Math.ceil(width / tile), down = Math.ceil(height / tile);
  const tiles = [];
  for (let tr = 0; tr < down; tr++){
    for (let tc = 0; tc < across; tc++){
      const f = bits === 64 ? new Float64Array(tile * tile) : new Float32Array(tile * tile);
      for (let r = 0; r < tile; r++){
        for (let c = 0; c < tile; c++){
          const row = tr * tile + r, col = tc * tile + c;
          f[r * tile + c] = (row < height && col < width) ? value(y0 - (row + 0.5) * dx, x0 + (col + 0.5) * dx) : 0;
        }
      }
      tiles.push(zlib.deflateSync(Buffer.from(f.buffer)));
    }
  }
  // Entries: [tag, type, count, inline value or 'off:<name>']
  const n = tiles.length;
  const offSize = classic ? 4 : 8;
  const extra = { scale: Buffer.alloc(24), tie: Buffer.alloc(48), offsets: Buffer.alloc(offSize * n), counts: Buffer.alloc(4 * n) };
  extra.scale.writeDoubleLE(dx, 0); extra.scale.writeDoubleLE(dx, 8);
  extra.tie.writeDoubleLE(x0, 24); extra.tie.writeDoubleLE(y0, 32);
  const entries = [[256, 4, 1, width], [257, 4, 1, height], [258, 3, 1, bits], [259, 3, 1, 8], [277, 3, 1, 1],
    [322, 3, 1, tile], [323, 3, 1, tile], [324, classic ? 4 : 16, n, 'offsets'], [325, 4, n, 'counts'], [339, 3, 1, 3],
    [33550, 12, 3, 'scale'], [33922, 12, 6, 'tie']];
  // BigTIFF: 8-byte offsets, 20-byte entries; classic: 4 and 12.
  const entrySize = classic ? 12 : 20, inline = classic ? 4 : 8;
  const ifdAt = 16, ifdSize = classic ? 2 + entries.length * 12 + 4 : 8 + entries.length * 20 + 8;
  let at = ifdAt + ifdSize;
  const where = {};
  for (const k of ['scale', 'tie', 'offsets', 'counts']){ where[k] = at; at += extra[k].length; }
  tiles.forEach((t, i) => {
    if (classic) extra.offsets.writeUInt32LE(at, i * 4); else extra.offsets.writeBigUInt64LE(BigInt(at), i * 8);
    extra.counts.writeUInt32LE(t.length, i * 4);
    at += t.length;
  });
  const head = Buffer.alloc(ifdAt + ifdSize);
  head.write('II', 0, 'latin1');
  if (classic){
    head.writeUInt16LE(42, 2); head.writeUInt32LE(ifdAt, 4);
    head.writeUInt16LE(entries.length, ifdAt);
  } else {
    head.writeUInt16LE(43, 2); head.writeUInt16LE(8, 4); head.writeBigUInt64LE(BigInt(ifdAt), 8);
    head.writeBigUInt64LE(BigInt(entries.length), ifdAt);
  }
  entries.forEach(([tag, type, count, v], i) => {
    const e = ifdAt + (classic ? 2 : 8) + i * entrySize, valueAt = e + (classic ? 8 : 12);
    head.writeUInt16LE(tag, e); head.writeUInt16LE(type, e + 2);
    if (classic) head.writeUInt32LE(count, e + 4); else head.writeBigUInt64LE(BigInt(count), e + 4);
    if (typeof v === 'string'){
      const size = { 3: 2, 4: 4, 12: 8, 16: 8 }[type] * count;
      if (size <= inline) extra[v].copy(head, valueAt);
      else if (classic) head.writeUInt32LE(where[v], valueAt);
      else head.writeBigUInt64LE(BigInt(where[v]), valueAt);
    } else if (type === 3) head.writeUInt16LE(v, valueAt);
    else head.writeUInt32LE(v, valueAt);
  });
  return Buffer.concat([head, extra.scale, extra.tie, extra.offsets, extra.counts, ...tiles]);
}

// Serves a byte range of `buf` the way S3 does.
export function rangeOf(buf, header){
  const m = /bytes=(\d+)-(\d+)/.exec(header || '');
  if (!m) return null;
  return buf.subarray(Number(m[1]), Math.min(Number(m[2]) + 1, buf.length));
}
