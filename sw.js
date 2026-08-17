/* Taifas service worker
   Reguli învățate: NU cache.addAll pe shell (all-or-nothing);
   NU intercepta manifestul (se servește din rețea, ca să nu rămână blocat);
   cross-origin și API-urile trec direct la rețea. */
const CACHE = 'taifas-v2';               // ↑ incrementează la fiecare versiune
const SHELL = ['./', './index.html', './icon-192.png', './icon-512.png', './icon-512-maskable.png', './icon-180.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // individual, tolerant: un fișier lipsă nu blochează instalarea SW-ului
    await Promise.all(SHELL.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('taifas-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  // doar same-origin GET; restul (Anthropic, Puter, esm.run, huggingface, Pollinations, POST) trece direct
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // nu atinge manifestul: mereu din rețea
  if (url.pathname.endsWith('.webmanifest')) return;
  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    } catch (err) {
      // fallback pentru navigări offline
      if (req.mode === 'navigate') return caches.match('./index.html');
      throw err;
    }
  })());
});
