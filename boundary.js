/* ─────────────────────────────────────────────────────────────────
   boundary.js  –  the study-area outline, shared by every map

   Loads the boundary GeoJSON named in config.js, draws it as an outline,
   and fits the map to it. Used by the map pages and the setup page, so
   both open on exactly the same view.
   ───────────────────────────────────────────────────────────────── */

const { BOUNDARY_URL } = window.SURVEY_CONFIG;

/* Used only if the boundary cannot be loaded at all (a device that has
   never been online with HTTPS, say): the whole of Kenya, so the map is at
   least never blank. */
const FALLBACK_CENTRE = [0.02, 37.90];
const FALLBACK_ZOOM   = 6;

// Give up on the file after this long. It normally comes from the device
// itself in milliseconds; this only matters without the service worker.
const TIMEOUT_MS = 10000;

/**
 * Draw the boundary on `map` and zoom to it. The map should not have a view
 * yet: none is set until the outline is ready, so no imagery is requested
 * for a view that is about to be replaced.
 *
 * Resolves with a function that returns the map to the boundary view, for
 * the "Reset map" button.
 */
export async function addBoundary(map) {
    let bounds = null;

    try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        const res   = await fetch(BOUNDARY_URL, { signal: ctrl.signal });
        clearTimeout(timer);
        const geojson = await res.json();

        /* Two strokes, a dark one under a bright one, so the line stays
           visible over pale bare ground and dark vegetation alike. Neither
           is filled, and neither is interactive, so the outline never
           catches the touches the spraycan needs. */
        const style = (color, weight, opacity) => ({
            color, weight, opacity, fill: false, interactive: false
        });
        L.geoJSON(geojson, { style: style('#000', 5, 0.5) }).addTo(map);
        const outline = L.geoJSON(geojson, { style: style('#facc15', 2.5, 1) }).addTo(map);

        bounds = outline.getBounds();

    } catch (e) {
        console.warn('Study-area boundary not loaded:', e);
    }

    const reset = bounds
        ? () => map.fitBounds(bounds, { padding: [10, 10] })
        : () => map.setView(FALLBACK_CENTRE, FALLBACK_ZOOM);

    reset();
    return reset;
}
