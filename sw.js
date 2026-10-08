/* Taifas 2 — service worker
   Pagina vine din rețea întâi (versiunea nouă se vede imediat), cache-ul e doar plasă offline.
   API-urile și orice alt domeniu trec direct la rețea. */
const CACHE = 'taifas2-v13';   // ↑ crește la fiecare versiune
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-512-maskable.png', './icon-180.png', './fonts/pjs-latin.woff2', './fonts/pjs-latin-ext.woff2', './fonts/pjs-latin-italic.woff2', './fonts/pjs-latin-ext-italic.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req, {cache: 'no-cache'});
      if (res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    } catch (err) {
      return (await caches.match(req, {ignoreSearch: true})) || (await caches.match('./index.html')) || Response.error();
    }
  })());
});
