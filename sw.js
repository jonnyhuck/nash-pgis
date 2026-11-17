/* ─────────────────────────────────────────────────────────────────
   sw.js  –  service worker: the survey keeps working without signal

   Three jobs:
     1. App shell. Every page, script and stylesheet is stored on install
        and served from the device, so the survey opens and runs with no
        connection at all once it has been loaded online one time.
     2. Map tiles. Google Satellite tiles are served from the device when
        they have been seen (or pre-downloaded on the setup page) before,
        and stored on the way through when they have not.
     3. Background Sync. Where the browser supports it (Chrome on Android),
        the queued survey data is uploaded as soon as a connection appears,
        even if the survey tab was closed long ago.

   IMPORTANT: bump SHELL_VERSION whenever any file in SHELL_FILES changes,
   or devices will keep running the old copy. The tile cache is separate
   and survives version bumps.
   ───────────────────────────────────────────────────────────────── */

importScripts('config.js', 'outbox.js');

const SHELL_VERSION = 'ticks-shell-v2';

const SHELL_FILES = [
    './',
    'index.html',
    'map1.html',
    'map2.html',
    'thankyou.html',
    'setup.html',
    'style.css',
    'config.js',
    'outbox.js',
    'api.js',
    'mappage.js',
    'boundary.js',
    'spray.js',
    // The study-area outline every map opens on (named in config.js).
    self.SURVEY_CONFIG.BOUNDARY_URL,
    'manifest.json',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'vendor/leaflet/leaflet.js',
    'vendor/leaflet/leaflet.css'
];

const { TILE_CACHE, tileKeyFromUrl } = self.SURVEY_CONFIG;


/* ── Install: store the app shell ─────────────────────────────────── */

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_VERSION);
        // cache: 'reload' bypasses the HTTP cache, so a version bump always
        // stores the files as they are now on the server, not a stale copy.
        await cache.addAll(SHELL_FILES.map(f => new Request(f, { cache: 'reload' })));
        // Take over straight away rather than waiting for every tab to close.
        await self.skipWaiting();
    })());
});


/* ── Activate: drop old app-shell versions, never the tiles ────────── */

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys
            .filter(k => k.startsWith('ticks-shell-') && k !== SHELL_VERSION)
            .map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});


/* ── Fetch ─────────────────────────────────────────────────────────── */

self.addEventListener('fetch', event => {
    const req = event.request;

    // Writes to the API are never touched: they go through the outbox,
    // which handles failure itself.
    if (req.method !== 'GET') return;

    const tileKey = tileKeyFromUrl(req.url);
    if (tileKey) {
        event.respondWith(serveTile(req, tileKey));
        return;
    }

    const url = new URL(req.url);
    if (url.origin === self.location.origin && !url.pathname.includes('/api/')) {
        event.respondWith(serveShell(req));
    }
});

/**
 * App shell: cache first, so a page opens instantly and identically with
 * or without signal. Query strings are ignored, so index.html?x=1 is still
 * found, and any navigation to an unknown page falls back to the start.
 */
async function serveShell(req) {
    const cache  = await caches.open(SHELL_VERSION);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;

    try {
        return await fetch(req);
    } catch (e) {
        if (req.mode === 'navigate') {
            const start = await cache.match('index.html');
            if (start) return start;
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
}

/**
 * Map tiles: cache first, then network, keeping a copy of anything fetched.
 * A tile that is neither cached nor reachable returns an empty 404, which
 * Leaflet simply leaves blank.
 */
async function serveTile(req, key) {
    const cache  = await caches.open(TILE_CACHE);
    const cached = await cache.match(key);
    if (cached) return cached;

    try {
        // Fetched as CORS (Google allows it), never no-cors: an opaque reply
        // is counted against storage at several megabytes per tile in Chrome
        // and would fill the quota after a few hundred tiles.
        const res = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
        if (res.ok) {
            cache.put(key, res.clone()).catch(e => console.warn('Tile not cached:', e));
        }
        return res;
    } catch (e) {
        return new Response('', { status: 404, statusText: 'Tile not available offline' });
    }
}


/* ── Background Sync ───────────────────────────────────────────────── */

self.addEventListener('sync', event => {
    if (event.tag !== Outbox.SYNC_TAG) return;
    // A rejection tells the browser to try again later, with its own backoff.
    event.waitUntil(Outbox.drain());
});
