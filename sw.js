/* Taifas service worker
   Reguli învățate: NU cache.addAll pe shell (all-or-nothing);
   NU intercepta manifestul (se servește din rețea, ca să nu rămână blocat);
   cross-origin și API-urile trec direct la rețea. */
const CACHE = 'taifas-v26';               // ↑ incrementează la fiecare versiune
const SHELL = ['./', './index.html', './icon-192.png', './icon-512.png', './icon-512-maskable.png', './icon-180.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // individual, tolerant: un fișier lipsă nu blochează instalarea SW-ului
    await Promise.all(SHELL.map(u => c.add(u).catch(() => {})));
    // NU skipWaiting automat: noua versiune asteapta pana cand utilizatorul apasa "Actualizează"
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

  // Pagina: din rețea prima, cu cache-ul ca plasă de siguranță.
  // Inainte era cache-first, deci un index.html nou urcat pe server nu se vedea NICIODATA
  // pana cand utilizatorul apasa "Actualizează" — iar bara aceea nu apare daca browserul
  // n-a observat sw.js-ul nou. Rezultat: aplicatia ramanea pe versiunea veche.
  const esteNavigare = req.mode === 'navigate' || url.pathname.endsWith('/index.html');
  if (esteNavigare) {
    e.respondWith((async () => {
      try {
        const res = await Promise.race([
          fetch(req, { cache: 'no-store' }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('lent')), 3000))
        ]);
        if (res && res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); return res }
        throw new Error('raspuns nefolosibil');
      } catch (err) {
        // offline sau retea lenta: servim ce avem
        return (await caches.match(req, { cacheName: CACHE }))
            || (await caches.match('./index.html', { cacheName: CACHE }))
            || (await caches.match('./', { cacheName: CACHE }))
            || fetch(req);
      }
    })());
    return;
  }

  // Restul (iconite, fisiere statice): din cache, dar DOAR din cache-ul versiunii curente.
  // `caches.match` fara cacheName caută în toate cache-urile: în timpul cât versiunea nouă
  // aşteaptă, cea veche putea servi fişiere din cache-ul celei noi, amestecând versiunile.
  e.respondWith((async () => {
    const cached = await caches.match(req, { cacheName: CACHE });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    } catch (err) {
      throw err;
    }
  })());
});

// activarea noii versiuni la cererea paginii (butonul din bara de update)
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
