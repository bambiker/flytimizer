// "Add to home screen": installs the site like an app.
//
// Chrome, Edge and Samsung Internet offer it through the
// beforeinstallprompt event, which we keep and replay when the button
// is pressed. Safari on iPhone and iPad has no such event, so there the
// button explains the two taps (Share, then Add to Home Screen). Other
// browsers, and the site already opened from the home screen, get no
// button.

import { track } from './analytics.js';
import { hideNotice, showNotice } from './notice.js';

var deferredPrompt = null;

export function isStandalone(){
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
}

export function isIos(ua, maxTouchPoints){
  ua = ua === undefined ? navigator.userAgent : ua;
  maxTouchPoints = maxTouchPoints === undefined ? navigator.maxTouchPoints : maxTouchPoints;
  // iPadOS reports itself as a Mac, but with a touch screen.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}

function button(){ return document.getElementById('installBtn'); }

export function initInstall(){
  var btn = button();
  if (!btn || isStandalone()) return;
  if (isIos()) btn.hidden = false;
  window.addEventListener('beforeinstallprompt', function(e){
    e.preventDefault();
    deferredPrompt = e;
    btn.hidden = false;
  });
  window.addEventListener('appinstalled', function(){
    deferredPrompt = null;
    btn.hidden = true;
    hideNotice('installNotice');
    track('app_installed', {});
  });
}

export async function addToHomeScreen(){
  if (deferredPrompt){
    var prompt = deferredPrompt;
    deferredPrompt = null;
    prompt.prompt();
    var choice = await prompt.userChoice.catch(function(){ return null; });
    track('install_prompt', { outcome: choice ? choice.outcome : 'unknown' });
    if (choice && choice.outcome === 'accepted') button().hidden = true;
    return;
  }
  track('install_prompt', { outcome: 'instructions' });
  showNotice('installNotice', isIos()
    ? 'To add Flytimizer to your home screen: tap the Share button (the square with an arrow) in Safari, then “Add to Home Screen”.'
    : 'To add Flytimizer to your home screen, open your browser’s menu and choose “Install app” or “Add to Home screen”.');
}
