/* Taifas 2 — service worker
   Pagina vine din rețea întâi (versiunea nouă se vede imediat), cache-ul e doar plasă offline.
   API-urile și orice alt domeniu trec direct la rețea. */
const CACHE = 'taifas2-v69';   // ↑ crește la fiecare versiune
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-512-maskable.png', './icon-180.png', './fonts/pjs-latin.woff2', './fonts/pjs-latin-ext.woff2', './fonts/pjs-latin-italic.woff2', './fonts/pjs-latin-ext-italic.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE && k !== 'taifas-cfg') await caches.delete(k);
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

/* 8.6: notificări. Worker-ul trimite o notificare goală; titlul vine de la /v1/push/pending. */
async function cfg() { try { const r = await (await caches.open('taifas-cfg')).match('cfg'); return r ? await r.json() : null } catch (e) { return null } }
self.addEventListener('message', e => {
  if (e.data && e.data.cfg) e.waitUntil(caches.open('taifas-cfg').then(c => c.put('cfg', new Response(JSON.stringify(e.data.cfg)))));
});
self.addEventListener('push', e => e.waitUntil((async () => {
  const c = await cfg();
  let items = [];
  if (c && c.wk) { try { const r = await fetch(c.wk + '/push/pending', { headers: c.tok ? { authorization: 'Bearer ' + c.tok } : {} }); items = (await r.json()).items || [] } catch (er) {} }
  const open = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).some(w => w.visibilityState === 'visible');
  if (open) return;                                   // aplicația e pe ecran: nu deranjăm
  if (!items.length) items = [{ id: 'msg', title: 'Taifas', body: '💬 Ai un mesaj nou', url: './' }];
  for (const it of items) await self.registration.showNotification(it.title || 'Taifas', { body: it.body || '', icon: 'icon-512-maskable.png', badge: 'icon-192.png', tag: it.id || 'taifas', renotify: true, data: { url: it.url || './' } });
})()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
    const go = new URL(url).searchParams.get('go');
    for (const w of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) { if ('focus' in w) { await w.focus(); if (go) w.postMessage({ go }); return } }
    await self.clients.openWindow(url);
  })());
});
