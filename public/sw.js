// Kunla's service worker (KD-53). It exists so phones can install Kunla as an app, and so the
// app's own files still open on a bad connection. It never touches data: API, MCP, OAuth,
// webhook and task-link requests always go straight to the server, uncached.
// Pages and files are network-first, so a deploy shows up on the next load; the cache is
// only the fallback when the network fails.
const CACHE = 'kunla-shell-v1';
const SERVER_ONLY = /^\/(api|mcp|oauth|hooks|t|\.well-known)(\/|$)/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || SERVER_ONLY.test(url.pathname) || url.pathname === '/sw.js') return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      // A redirected response can't answer a navigation later, so only plain 200s are kept.
      if (res.ok && res.type === 'basic' && !res.redirected) {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await caches.match('/app/');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
