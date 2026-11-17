/* ─────────────────────────────────────────────────────────────────
   spray.js  –  Leaflet spraycan interface

   Loaded as a classic script, so everything declared here is global and
   can be called from the inline onclick handlers in the map pages.

   Expects the host page (mappage.js) to have set, before any of these
   functions are called:
     window.map            – L.Map instance
     window.colourMap      – { typeName: hexFillColour, … }
     window.dotStore       – dot buffer from api.js  (optional)
     window.activePlaceKey – id of the spray round currently in progress

   A participant may mark several places per question by pressing "Spray
   again", so paint on the map comes in two states: the round currently being
   painted (active — full colour, editable by Undo/Clear), and every earlier
   round they have already saved (committed — dimmed, locked, kept on screen
   for spatial context but otherwise inert). commitSpray() is what moves the
   active round into the committed state once its follow-up form is saved.
   ───────────────────────────────────────────────────────────────── */

/* ── Settings ──────────────────────────────────────────────────── */

// Radius of the spray circle in screen pixels: how wide the "nozzle" is.
const spreadPx    = 25;

// Radius of each individual paint dot in screen pixels.
const dotRadiusPx = 4;

// How many dots one press of Undo removes. Because the loop emits ~83 dots a
// second, removing one at a time would feel like nothing had happened at all.
const undoNum     = 20;

// Opacity of a dot once its place has been saved and locked. Faded enough to
// read as "already recorded" rather than "still being painted", but not so
// faint that the participant loses track of where their earlier places are.
const committedOpacity = 0.35;

/* ── Constants ─────────────────────────────────────────────────── */

// Precomputed because the spray loop uses it 83 times a second.
const twoPi = Math.PI * 2;

/* ── State ─────────────────────────────────────────────────────── */

// setTimeout handle for the spray loop; null when the loop is not running.
let loopTimer            = null;

// Current cursor / fingertip position as an L.LatLng.
let currentSprayLocation = null;

// Whether the spraycan is armed (map dragging disabled, listeners attached).
let sprayIsOn            = false;

// Which colour button is selected, e.g. 'ticks' — null when none is.
let activeColour         = null;

// Every dot ever drawn on this page load: { marker, type, seq, committed }[].
// `seq` is this dot's position within its place (see window.activePlaceKey),
// and is what Undo hands back to the dot buffer to delete a specific dot.
let paint                = [];

/* Named references to the touch handlers. removeEventListener can only
   detach a handler it can name, so anonymous functions would leak listeners
   every time the spraycan was switched off and on again. */
let _touchStart = null;
let _touchMove  = null;
let _touchEnd   = null;


/* ════════════════════════════════════════════════════════════════
   PUBLIC API
   ════════════════════════════════════════════════════════════════ */

/**
 * Select a paint colour and arm the spraycan.
 * Tapping the already-active colour switches the spray off again, which is
 * how the participant gets back to panning and zooming the map.
 */
function selectColour(type) {
    // Same button pressed twice: treat it as "stop".
    if (activeColour === type && sprayIsOn) {
        deactivateSpray();
        return;
    }

    activeColour = type;

    // Only attach the listeners if the can is not already armed.
    if (!sprayIsOn) _sprayOn();

    /* Highlight the chosen button. The .active class is what swaps its hint
       line to "tap to stop", so this is the participant's confirmation that
       the can is now in hand. */
    document.querySelectorAll('.draw-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('btn-' + type).classList.add('active');
}

/**
 * Disarm the spraycan and restore normal map navigation.
 * Call this before navigating away so the loop is stopped and the buffer sent.
 */
function deactivateSpray() {
    // Nothing to do if the can was never armed.
    if (!sprayIsOn) return;

    _sprayOff();

    // Drop the highlight, which returns the hint line to "tap to start".
    document.querySelectorAll('.draw-btn').forEach(b => b.classList.remove('active'));
    activeColour = null;

    /* Store any dots still buffered. Without this they would sit waiting
       for the next flush tick, and a participant who moves straight on would
       lose the last half-second of painting. */
    if (window.dotStore) window.dotStore.flush();
}

/**
 * Remove the last `undoNum` dots of the round currently being painted.
 * Committed dots from earlier, already-saved places are left alone — Undo
 * only ever touches the work that has not been submitted yet.
 */
function undoSpray() {
    const active = paint.filter(p => !p.committed);
    const n = Math.min(undoNum, active.length);

    for (let i = 0; i < n; i++) {
        // Newest first, so Undo peels back the stroke in the order it was made.
        const p = active[active.length - 1 - i];
        map.removeLayer(p.marker);

        // Every active dot belongs to the round currently in progress, so
        // window.activePlaceKey is always the right place to delete it from.
        if (p.seq != null && window.dotStore) {
            window.dotStore.delete(window.activePlaceKey, p.seq);
        }
    }

    // Drop the removed entries from the master list in one pass.
    const removed = new Set(active.slice(active.length - n));
    paint = paint.filter(p => !removed.has(p));
}

/**
 * Remove all paint from the round currently being painted, and delete those
 * dots from the database. Committed places from earlier are unaffected.
 */
function clearSpray() {
    const active = paint.filter(p => !p.committed);
    active.forEach(p => map.removeLayer(p.marker));
    paint = paint.filter(p => p.committed);

    // Scoped server-side to the active place only, so earlier saved places
    // on this question survive a "Clear all" on the round in progress.
    if (window.dotStore) window.dotStore.clear(window.activePlaceKey);
}

/**
 * Lock the round currently being painted: it stays on the map, dimmed, but
 * moves out of reach of Undo and Clear. Called once its follow-up form has
 * been saved, whether via "Spray again" (another round follows) or NEXT
 * (the participant is moving on).
 */
function commitSpray() {
    paint.forEach(p => {
        if (p.committed) return;
        p.committed = true;
        p.marker.setStyle({ fillOpacity: committedOpacity });
    });
}

/**
 * Serialise the round currently being painted, for saving alongside its
 * follow-up answers. Returns [{ lat, lng, type }, …] — the keys are left
 * out, as they are only meaningful to the page instance that created them.
 */
function getSprayData() {
    return paint.filter(p => !p.committed).map(({ marker, type }) => {
        const ll = marker.getLatLng();
        return { lat: ll.lat, lng: ll.lng, type };
    });
}

/**
 * Redraw one previously-saved place on the map in its locked, committed
 * style. Used when the page loads, to restore the visual history of places
 * already recorded on this question so the participant has spatial context
 * for whatever they mark next.
 */
function loadSprayData(data) {
    // Nothing saved, or something unexpected in localStorage.
    if (!Array.isArray(data) || !data.length) return;

    data.forEach(d => {
        // Drawn straight onto the map with no server write: these dots are
        // already stored, and re-sending them would duplicate every one.
        const marker = L.circleMarker([d.lat, d.lng], _dotStyle(d.type, true)).addTo(map);
        paint.push({ marker, type: d.type, seq: null, committed: true });
    });
}

/** How many dots are in the round currently being painted (not yet saved). */
function sprayCount() {
    return paint.filter(p => !p.committed).length;
}


/* ════════════════════════════════════════════════════════════════
   INTERNAL
   ════════════════════════════════════════════════════════════════ */

/** Build the Leaflet style object for one dot of a given colour type. */
function _dotStyle(type, committed) {
    return {
        // No outline: at 4 px a stroke would dominate the fill.
        color:       'none',
        // Falls back to grey if the page forgot to define this colour.
        fillColor:   (window.colourMap && window.colourMap[type]) || '#999',
        // Slightly translucent even when active, so overlapping passes build
        // up density and the imagery stays readable underneath; noticeably
        // fainter once committed, so a locked place reads as history rather
        // than as the thing currently being worked on.
        fillOpacity: committed ? committedOpacity : 0.8,
        radius:      dotRadiusPx,
        // Dots must never swallow the pointer events the spray loop needs.
        interactive: false,
    };
}

/** Arm the spraycan: suppress map navigation and attach the input handlers. */
function _sprayOn() {
    sprayIsOn = true;

    /* Dragging, pinch-zoom and double-click zoom are all disabled while
       painting: a drag across the map is now a brush stroke, and Leaflet would
       otherwise pan the map out from under the participant's finger. */
    map.dragging.disable();
    map.touchZoom.disable();
    map.doubleClickZoom.disable();

    // Visual confirmation on desktop that the pointer is now a brush.
    document.getElementById('map').style.cursor = 'crosshair';

    // Mouse events (desktop), through Leaflet's own event system.
    map.on('mousedown', _onMouseDown);
    map.on('mousemove', _onMouseMove);
    map.on('mouseup',   _onMouseUp);

    /* Touch events (mobile) are registered on the DOM container instead,
       because Leaflet does not normalise touchstart/touchend into mousedown
       and mouseup equivalents. */
    const container = map.getContainer();

    _touchStart = function(e) {
        // Stops the browser scrolling the page instead of painting.
        e.preventDefault();

        /* Ignore multi-touch. A second touchstart would call spray() again and
           start a parallel timer chain: loopTimer would be overwritten, so
           clearTimeout could never stop the first chain and the spray would be
           stuck on permanently. */
        if (e.touches.length !== 1) return;

        currentSprayLocation = map.mouseEventToLatLng(e.touches[0]);

        // Guard against starting a second chain if one is already running.
        if (!loopTimer) spray();
    };

    _touchMove = function(e) {
        e.preventDefault();

        // Track the finger only while it is the single touch on screen;
        // movement during a pinch is a gesture, not a stroke.
        if (e.touches.length === 1) {
            currentSprayLocation = map.mouseEventToLatLng(e.touches[0]);
        }
    };

    _touchEnd = function(e) {
        /* Stop only when every finger has lifted. If touches remain, one
           finger was released mid-pinch, and the touchstart guard above has
           already stopped the loop. */
        if (e.touches.length === 0) {
            window.clearTimeout(loopTimer);
            loopTimer = null;
            _strokeEnded();
        }
    };

    // passive:false is required, or the browser ignores the preventDefault
    // calls above and scrolls the page while the participant tries to paint.
    container.addEventListener('touchstart', _touchStart, { passive: false });
    container.addEventListener('touchmove',  _touchMove,  { passive: false });
    container.addEventListener('touchend',   _touchEnd,   { passive: false });
}

/** Disarm the spraycan: stop the loop, restore navigation, detach handlers. */
function _sprayOff() {
    sprayIsOn = false;

    // Kill any pending tick before the state it depends on is torn down.
    window.clearTimeout(loopTimer);
    loopTimer = null;

    // Hand the map's gestures back to Leaflet.
    map.dragging.enable();
    map.touchZoom.enable();
    map.doubleClickZoom.enable();
    document.getElementById('map').style.cursor = '';

    map.off('mousedown', _onMouseDown);
    map.off('mousemove', _onMouseMove);
    map.off('mouseup',   _onMouseUp);

    // Detach the touch handlers by name, then release them.
    const container = map.getContainer();
    if (_touchStart) container.removeEventListener('touchstart', _touchStart);
    if (_touchMove)  container.removeEventListener('touchmove',  _touchMove);
    if (_touchEnd)   container.removeEventListener('touchend',   _touchEnd);
    _touchStart = _touchMove = _touchEnd = null;
}

/** Mouse down: seed the position and start the loop. */
function _onMouseDown(e) {
    // Left button only; right and middle clicks are not painting.
    if (e.originalEvent.button !== 0) return;

    // Seeded from the click itself, so a single click with no movement still
    // paints — waiting for the first mousemove would drop it.
    currentSprayLocation = e.latlng;
    spray();
}

/** Mouse move: just track where the brush is. */
function _onMouseMove(e) {
    currentSprayLocation = e.latlng;
}

/** Mouse up: stop the loop, leaving the paint in place. */
function _onMouseUp() {
    window.clearTimeout(loopTimer);
    loopTimer = null;
    _strokeEnded();
}

/* A finished stroke is stored on the device straight away rather than at the
   next flush tick, so a phone locked or a tab closed right after painting
   loses nothing. */
function _strokeEnded() {
    if (window.dotStore) window.dotStore.flush();
}

/**
 * The spray loop: places one dot every 12 ms at a random offset within
 * spreadPx of the current position, then schedules itself again.
 */
function spray() {
    // Bail out if anything the loop depends on has gone away.
    if (!sprayIsOn || !currentSprayLocation || !activeColour) return;

    /* Scatter in screen space rather than in degrees, so the spray circle stays
       the same visual size at every zoom level and latitude — in degrees it
       would stretch east-west as the map moved north. */
    const centre    = map.latLngToLayerPoint(currentSprayLocation);
    const distance  = Math.random() * spreadPx;
    const direction = Math.random() * twoPi;

    // Convert the offset point back to a position on the ground.
    const pos = map.layerPointToLatLng(new L.Point(
        centre.x + Math.sin(direction) * distance,
        centre.y + Math.cos(direction) * distance
    ));

    // Draw it, and record it so Undo and Clear can find it again.
    const marker = L.circleMarker(pos, _dotStyle(activeColour, false)).addTo(map);
    const entry  = { marker, type: activeColour, seq: null, committed: false };
    paint.push(entry);

    /* Queue it for upload, tagged with the round it belongs to. The sequence
       number comes back immediately because it is assigned in the browser, so
       Undo can target this dot even before the batch it belongs to has been
       sent. Colour is not part of this at all — the server already knows
       which map (and so which single colour) a dot belongs to from the
       question, and only ever needed it for rendering, which happened above. */
    if (window.dotStore) {
        entry.seq = window.dotStore.queue(pos, map.getZoom(), window.activePlaceKey);
    }

    // ~83 dots a second: fast enough to feel like paint, slow enough that a
    // long stroke does not put tens of thousands of circles on the map.
    loopTimer = window.setTimeout(spray, 12);
}
