// Content script: bridges popup ↔ inject.js via chrome.storage + window.postMessage.
// Runs in ISOLATED world (has chrome.* APIs but can't touch page's navigator.mediaDevices directly).

// 1. Inject inject.js into the page's MAIN world so it can patch getUserMedia.
(function injectMain() {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('inject.js');
  s.dataset.extensionId = chrome.runtime.id;
  s.dataset.assetsBase = chrome.runtime.getURL('vendor/');
  (document.head || document.documentElement).appendChild(s);
  s.remove();
})();

// 2. Forward stored config to inject.js whenever it changes.
const POST_TYPE = 'BRUCE_EFFECT_CONFIG';

function broadcastConfig(cfg) {
  window.postMessage({ source: 'bruce-effect-camera', type: POST_TYPE, config: cfg }, '*');
}

chrome.storage.local.get(['config'], (res) => {
  if (res.config) broadcastConfig(res.config);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.config) {
    broadcastConfig(changes.config.newValue);
  }
});

// 3. inject.js can request the current config at startup.
window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  if (!ev.data || ev.data.source !== 'bruce-effect-camera-inject') return;
  if (ev.data.type === 'REQUEST_CONFIG') {
    chrome.storage.local.get(['config'], (res) => {
      broadcastConfig(res.config || { mode: 'none', blurRadius: 15, backgroundImage: null });
    });
  }
});
