// A small GeoTIFF laid out like the GHSL building-height file (little-
// endian BigTIFF, tiled, one deflated float32 band), for the tests.
// value(lat, lng) gives each cell's height; cells are `dx` degrees.
import zlib from 'node:zlib';

export function makeGhslTiff({ x0, y0, dx, width, height, tile = 16, value }){
  const across = Math.ceil(width / tile), down = Math.ceil(height / tile);
  const tiles = [];
  for (let tr = 0; tr < down; tr++){
    for (let tc = 0; tc < across; tc++){
      const f = new Float32Array(tile * tile);
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
  const extra = { scale: Buffer.alloc(24), tie: Buffer.alloc(48), offsets: Buffer.alloc(8 * n), counts: Buffer.alloc(4 * n) };
  extra.scale.writeDoubleLE(dx, 0); extra.scale.writeDoubleLE(dx, 8);
  extra.tie.writeDoubleLE(x0, 24); extra.tie.writeDoubleLE(y0, 32);
  const entries = [[256, 4, 1, width], [257, 4, 1, height], [258, 3, 1, 32], [259, 3, 1, 8], [277, 3, 1, 1],
    [322, 3, 1, tile], [323, 3, 1, tile], [324, 16, n, 'offsets'], [325, 4, n, 'counts'], [339, 3, 1, 3],
    [33550, 12, 3, 'scale'], [33922, 12, 6, 'tie']];
  const ifdAt = 16, ifdSize = 8 + entries.length * 20 + 8;
  let at = ifdAt + ifdSize;
  const where = {};
  for (const k of ['scale', 'tie', 'offsets', 'counts']){ where[k] = at; at += extra[k].length; }
  tiles.forEach((t, i) => { extra.offsets.writeBigUInt64LE(BigInt(at), i * 8); extra.counts.writeUInt32LE(t.length, i * 4); at += t.length; });
  const head = Buffer.alloc(ifdAt + ifdSize);
  head.write('II', 0, 'latin1'); head.writeUInt16LE(43, 2); head.writeUInt16LE(8, 4); head.writeBigUInt64LE(BigInt(ifdAt), 8);
  head.writeBigUInt64LE(BigInt(entries.length), ifdAt);
  entries.forEach(([tag, type, count, v], i) => {
    const e = ifdAt + 8 + i * 20;
    head.writeUInt16LE(tag, e); head.writeUInt16LE(type, e + 2); head.writeBigUInt64LE(BigInt(count), e + 4);
    if (typeof v === 'string'){
      const size = { 3: 2, 4: 4, 12: 8, 16: 8 }[type] * count;
      if (size <= 8) extra[v].copy(head, e + 12); else head.writeBigUInt64LE(BigInt(where[v]), e + 12);
    } else if (type === 3) head.writeUInt16LE(v, e + 12);
    else head.writeUInt32LE(v, e + 12);
  });
  return Buffer.concat([head, extra.scale, extra.tie, extra.offsets, extra.counts, ...tiles]);
}

// Serves a byte range of `buf` the way S3 does.
export function rangeOf(buf, header){
  const m = /bytes=(\d+)-(\d+)/.exec(header || '');
  if (!m) return null;
  return buf.subarray(Number(m[1]), Math.min(Number(m[2]) + 1, buf.length));
}
