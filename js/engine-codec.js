// How the engine's requests and results travel as JSON: JSON can't
// carry Infinity or NaN, which the plans use for "can't", so they go as
// { $n: 'Infinity' } and come back as numbers.

export function encodeResult(x){
  return JSON.stringify(x, function(k, v){
    if (typeof v === 'number' && !isFinite(v)) return { $n: String(v) };
    return v;
  });
}
export function decodeResult(s){
  return JSON.parse(s, function(k, v){
    if (v && typeof v === 'object' && typeof v.$n === 'string' && Object.keys(v).length === 1) return Number(v.$n);
    return v;
  });
}
