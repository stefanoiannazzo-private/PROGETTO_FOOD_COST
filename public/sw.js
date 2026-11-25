/*
 * Ricetta Quadra — service worker della web app installabile (PWA).
 *
 * Regole:
 *  - /api/* NON passa mai dalla cache: dati e sessioni arrivano sempre dal server.
 *  - Pagine: sempre dalla rete; senza rete la pagina "sei offline" (si ricarica da sola quando la rete torna).
 *  - File dell'interfaccia con hash nel nome (/app/assets/*) e immagini del marchio: dalla cache, poi la rete.
 * Cambiare VERSION svuota le cache vecchie.
 */
const VERSION = 'rq-2026-11-25-2'
const SHELL = `${VERSION}-shell`
const ASSETS = `${VERSION}-assets`
const PRECACHE = ['/offline.html', '/app/brand/logo.png', '/app/brand/mark.png', '/app/brand/icon-192.png', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  // dati, accesso, file scaricati: sempre dal server
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return

  // navigazione: sempre dalla rete; senza rete la pagina "sei offline" (l'app senza dati non servirebbe)
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(async () => (await caches.match('/offline.html')) || Response.error()))
    return
  }

  // file statici con hash e immagini del marchio: cache, poi rete
  if (url.pathname.startsWith('/app/assets/') || url.pathname.startsWith('/app/brand/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(ASSETS).then((c) => c.put(req, copy))
            }
            return res
          }),
      ),
    )
  }
})
