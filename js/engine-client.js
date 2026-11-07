// The calculation on the engine server (see the flytimizer-engine
// repository): the same computePlan(req, hooks) as engine.js, over
// HTTP. ENGINE_URL empty means the engine runs here in the page.
//
// The server answers one JSON object per line as the calculation goes:
// progress stages, a busy map server, the result, then the people
// updates and 'done'.

import { decodeResult, encodeResult } from './engine-codec.js';

export var ENGINE_URL = (typeof window !== 'undefined' && window.FLYTIMIZER_ENGINE_URL) || '';

// A sleeping free server takes up to a minute to start: ask it to wake
// as soon as the page opens, so it's up by the time it's needed.
export function wakeEngine(){
  if (!ENGINE_URL) return;
  try { fetch(ENGINE_URL + '/health', { cache: 'no-store' }).catch(function(){}); } catch (e){}
}

// hooks: as computePlan's, plus retrying(msg). Resolves to the result,
// or { error: 'engine' | 'busy' } when the server can't be reached or
// is refusing calculations for now.
export async function remoteComputePlan(req, hooks){
  var controller = new AbortController();
  // A newer calculation replaced this one: stop listening.
  var watch = setInterval(function(){ if (hooks.stale && hooks.stale()) controller.abort(); }, 300);
  var resolved = false, resolveResult;
  var result = new Promise(function(resolve){ resolveResult = function(r){ if (!resolved){ resolved = true; resolve(r); } }; });
  function handle(m){
    if (m.t === 'stage' && hooks.stage) hooks.stage(m.key);
    else if (m.t === 'retry' && hooks.retrying) hooks.retrying(m.msg);
    else if (m.t === 'result') resolveResult(m.r);
    else if (m.t === 'people' && hooks.onPeople) hooks.onPeople(m.u);
    else if (m.t === 'done' && hooks.done) hooks.done(m.r);
  }
  (async function(){
    var res;
    try {
      res = await fetch(ENGINE_URL + '/plan', { method: 'POST', body: encodeResult(req), signal: controller.signal,
        headers: { 'Content-Type': 'application/json' } });
    } catch (err){
      resolveResult(controller.signal.aborted ? { stale: true } : { error: 'engine' });
      return;
    }
    if (!res.ok || !res.body){
      resolveResult({ error: res.status === 429 ? 'busy' : 'engine' });
      return;
    }
    var reader = res.body.getReader(), decoder = new TextDecoder(), buf = '';
    try {
      for (;;){
        var chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        var nl;
        while ((nl = buf.indexOf('\n')) >= 0){
          var line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) handle(decodeResult(line));
        }
      }
    } catch (err){
      if (!controller.signal.aborted) console.warn('Engine stream broke off:', err);
    }
    resolveResult(controller.signal.aborted ? { stale: true } : { error: 'engine' });
  })().finally(function(){ clearInterval(watch); });
  return result;
}
