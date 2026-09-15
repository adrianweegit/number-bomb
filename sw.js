// Number Bomb service worker.
//
// Network-first, deliberately. This page is served from GitHub Pages and
// updated by pushing to main, so a cache-first worker would happily serve a
// stale game for days. Online, you always get the current page; the cache
// exists only so pass-the-phone still works with no signal.
//
// Cross-origin requests are never touched — Firestore's realtime traffic and
// the Google Fonts stylesheet must reach the network untouched.

const CACHE = "number-bomb-v1";
const SHELL = [
  "./", "./index.html", "./config.js",
  "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      // allSettled: one missing file must not fail the whole install.
      .then(c => Promise.allSettled(SHELL.map(url => c.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok){
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match("./index.html")))
  );
});
