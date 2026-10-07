// Offline support. The shell and data are cached on install; audio is cached
// by the page ("下载全部音频") or lazily on first play; map tiles are cached as
// they are viewed, so streets you have already looked at keep working offline.
const SHELL = 'feast-shell-v3';
const AUDIO = 'feast-audio-v3';
const TILES = 'feast-tiles-v1';
const SHELL_FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'data/places.json', 'data/metro.json'];
const TILE_HOSTS = ['tile.openstreetmap.org', 'basemaps.cartocdn.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, AUDIO, TILES].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Safari asks for audio with Range headers and refuses a plain 200 from the
// cache, so slice the cached body ourselves.
async function ranged(request, cached) {
  const m = /bytes=(\d+)-(\d*)/.exec(request.headers.get('range') || '');
  if (!m) return cached;
  const buf = await cached.arrayBuffer();
  const start = +m[1];
  const end = m[2] ? Math.min(+m[2], buf.byteLength - 1) : buf.byteLength - 1;
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': cached.headers.get('Content-Type') || 'audio/mp4',
      'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

async function audioResponse(request) {
  const cache = await caches.open(AUDIO);
  let cached = await cache.match(request.url, { ignoreSearch: true });
  if (!cached) {
    // Fetch the whole file (no Range) so the cache holds a complete copy.
    const full = await fetch(request.url);
    if (!full.ok) return full;
    await cache.put(request.url, full.clone());
    cached = full;
  }
  return ranged(request, cached);
}

async function tileResponse(request) {
  const cache = await caches.open(TILES);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  // Tiles load through <img>, so the response is opaque; cache it as is.
  if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (TILE_HOSTS.some((h) => url.hostname.endsWith(h))) {
    e.respondWith(tileResponse(e.request));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.includes('/audio/')) {
    e.respondWith(audioResponse(e.request));
    return;
  }
  // Network first so a redeploy shows up immediately; cache when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
