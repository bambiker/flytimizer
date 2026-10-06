// Usage analytics: named events sent to Google Analytics (the gtag set
// up in index.html), to see which features people use and where they
// stop. Never sends coordinates or anything typed - only what was done
// plus a few coarse details (drone model, mission type, country code,
// route length in km). Does nothing if analytics didn't load.
export function track(name, params){
  try {
    if (typeof window.gtag === 'function') window.gtag('event', name, params || {});
  } catch (e){}
}
