/* ─────────────────────────────────────────────────────────────────
   config.js  –  settings shared by the pages and the service worker

   A classic script rather than a module, because the service worker
   loads it with importScripts() and the setup page, the map pages and
   sw.js all need to agree on exactly the same tile URLs and cache name.
   Everything lives on one global, SURVEY_CONFIG.
   ───────────────────────────────────────────────────────────────── */

(function (global) {

    /* ── Study area ────────────────────────────────────────────────
       The boundary drawn as an outline on every map, which the maps also
       open zoomed to. Stored on the device by sw.js along with the pages,
       so it is there offline. Spaces in the file name are written %20, so
       this is the same URL whether it is fetched or used as a cache key. */
    const BOUNDARY_URL = 'data/MUKOGODO%20EAST%20SHAPEFILE.geojson';

    // The closest the map can be zoomed. The setup page offers to
    // pre-download imagery up to this level.
    const MAX_ZOOM = 18;

    /* ── Base map ──────────────────────────────────────────────────
       Google Satellite (lyrs=s: imagery only, no labels). These are
       Google's raw tiles rather than the Maps JavaScript API, which is
       outside Google's Terms of Service for a public deployment — fine
       for a small academic study, but see the README. */
    const TILE_SUBDOMAINS = ['mt0', 'mt1', 'mt2', 'mt3'];
    const TILE_URL        = 'https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}';

    /* The Cache Storage bucket the tiles live in. Kept separate from the
       app-shell cache in sw.js, and deliberately not versioned with it, so
       that deploying a new version of the survey never throws away a
       gigabyte of imagery that took an afternoon on hotel wifi to download. */
    const TILE_CACHE = 'ticks-tiles-v1';

    /* Google serves the same tile from four hostnames. The cache is keyed on
       one canonical URL, so a tile fetched from mt2 is found again when
       Leaflet later asks mt0 for it. */
    function tileKey(x, y, z) {
        return `https://mt.google.com/vt/lyrs=s&x=${x}&y=${y}&z=${z}`;
    }

    /** A real, fetchable URL for one tile, spread across the subdomains. */
    function tileFetchUrl(x, y, z) {
        const s = TILE_SUBDOMAINS[(x + y) % TILE_SUBDOMAINS.length];
        return `https://${s}.google.com/vt/lyrs=s&x=${x}&y=${y}&z=${z}`;
    }

    /**
     * If `url` is a Google Satellite tile request, return its canonical
     * cache key; otherwise null. Used by the service worker to decide which
     * requests are tiles, so it must recognise every subdomain.
     */
    function tileKeyFromUrl(url) {
        const u = new URL(url);
        if (!/^mt\d?\.google\.com$/.test(u.hostname)) return null;

        // Google's tile URLs put '&'-joined parameters on the path itself
        // (/vt/lyrs=s&x=…) as well as in a normal query string (/vt?lyrs=s&x=…);
        // the template above produces the former, so both are handled.
        let query;
        if (u.pathname === '/vt')              query = u.search;
        else if (u.pathname.startsWith('/vt/')) query = u.pathname.slice(4);
        else return null;

        const params = new URLSearchParams(query);
        if (params.get('lyrs') !== 's') return null;

        const x = params.get('x'), y = params.get('y'), z = params.get('z');
        return (x && y && z) ? tileKey(x, y, z) : null;
    }

    global.SURVEY_CONFIG = {
        BOUNDARY_URL,
        MAX_ZOOM,
        TILE_SUBDOMAINS,
        TILE_URL,
        TILE_CACHE,
        tileKey,
        tileFetchUrl,
        tileKeyFromUrl,

        // The single write endpoint, relative to the site root (which is also
        // where sw.js lives, so it resolves the same way in both contexts).
        API_URL: new URL('api/survey.php', global.location.href).href
    };

})(self);
