/* Экмафиси — service worker. Оболочка (страница, код, значки, шрифты) — в кэш при установке, отдаётся из кэша.
   Тексты, словарь и звук сюда не попадают: их кладёт в свой кэш сама страница (sync.js) после входа. */
const VERSION = 'c05510cf21';  /* tools/app.py site ставит сюда отпечаток файлов оболочки */
const SHELL = 'ekmafisi-shell-' + VERSION;
const FILES = ['./', 'index.html', 'tokeny.css', 'app.js', 'sync.js', 'slovar.js', 'config.js', 'vendor/supabase.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('ekmafisi-shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin === location.origin) {
    /* переход по адресу (с ?code= после входа, с #экраном) — всегда одна страница */
    if (r.mode === 'navigate') { e.respondWith(caches.match('index.html', { ignoreSearch: true }).then(x => x || fetch(r))); return; }
    e.respondWith(caches.match(r, { ignoreSearch: true }).then(x => x || fetch(r)));
    return;
  }
  if (FONTS.test(r.url)) {  /* шрифты: первый раз из сети, дальше из кэша */
    e.respondWith(caches.open(SHELL).then(c => c.match(r).then(x => x || fetch(r).then(resp => { if (resp.ok || resp.type === 'opaque') c.put(r, resp.clone()); return resp; }))));
  }
  /* Supabase и прочее — мимо */
});
