/* ─────────────────────────────────────────────────────────────────
   api.js  –  client-side interface to the PHP / MySQL backend

   Import this from each page's <script type="module"> block, after the
   classic config.js and outbox.js. It is the only file that knows the
   shape of the server API; everything else deals in the functions
   exported here.

   Nothing here talks to the server directly. Every write is stored in
   the outbox (outbox.js) first and uploaded from there, in order, when
   there is signal — so a participant can complete the whole survey with
   no connection at all, and no page ever waits on the network before
   moving on. Importing this module also registers the service worker
   and starts the upload loop.
   ───────────────────────────────────────────────────────────────── */

/* ── Settings ──────────────────────────────────────────────────── */

// localStorage keys. The survey blob is the working copy of the answers, used
// to pre-fill a page the participant steps back to; the session ID is what
// ties this participant's writes to one database row.
const SURVEY_KEY  = 'ticks_survey';
const SESSION_KEY = 'ticks_session_id';

// How often to retry uploading while a page is open and something is queued,
// doubling after each failure up to the maximum.
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 120000;

const Outbox = window.Outbox;


/* ════════════════════════════════════════════════════════════════
   SERVICE WORKER
   ════════════════════════════════════════════════════════════════ */

/* Registered from every page, so whichever one a device opens first makes
   the whole survey available offline from then on. Needs HTTPS (or
   localhost); on plain HTTP this quietly does nothing and the survey still
   works, just not offline. updateViaCache: 'none' makes the browser check
   config.js and outbox.js for changes too, not only sw.js. */
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
        .catch(e => console.warn('Service worker not registered:', e));
}

/* Ask the browser not to evict the survey's storage when the device runs
   low on space. Without this, queued responses and the downloaded map are
   both "best effort" and can be silently cleared. Chrome grants it to
   installed or frequently used sites; the setup page reports the result. */
export const requestPersistence = () =>
    (navigator.storage && navigator.storage.persist)
        ? navigator.storage.persist().catch(() => false)
        : Promise.resolve(false);

requestPersistence();


/* ════════════════════════════════════════════════════════════════
   SESSION
   ════════════════════════════════════════════════════════════════ */

/** Generate a fresh unique ID (UUID where available, else a fallback). */
function _newId() {
    // crypto.randomUUID needs a secure context, which "localhost" counts as
    // but a bare LAN IP over plain HTTP does not — hence the fallback.
    return (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/**
 * Public alias for _newId(). mappage.js uses this to mint a fresh "place" id
 * for each spray-then-submit round.
 */
export const newId = _newId;

/**
 * Return this participant's session ID, creating one if there isn't one yet.
 * Stored in localStorage so every page of the survey writes under the same ID.
 */
export function getOrCreateSessionId() {
    let id = localStorage.getItem(SESSION_KEY);

    // First page load of a new response: mint an ID and keep it.
    if (!id) {
        id = _newId();
        localStorage.setItem(SESSION_KEY, id);
    }

    return id;
}

/**
 * Force a brand-new session and discard any previous answers.
 *
 * Called at the true start of a response (see index.html). On a shared device
 * the second participant would otherwise inherit the first participant's
 * session ID and overwrite their record. The previous participant's queued
 * writes are unaffected: each one carries its own session ID in the outbox.
 */
export function startNewSession() {
    localStorage.removeItem(SURVEY_KEY);
    const id = _newId();
    localStorage.setItem(SESSION_KEY, id);
    return id;
}


/* ════════════════════════════════════════════════════════════════
   QUEUEING
   ════════════════════════════════════════════════════════════════ */

// Tail of the enqueue chain. Writes are chained so they reach the outbox in
// exactly the order they were made, whatever IndexedDB's own timing.
let _chain = Promise.resolve();

/**
 * Store one write in the outbox, and nudge the uploader.
 *
 * The session ID is captured now, at call time, not when the write is
 * eventually sent. The returned promise resolves once the write is safely
 * on the device; it never rejects, so a storage error cannot freeze a
 * button, but it is logged and shown on the status line.
 */
function _queue(action, payload = {}) {
    const op = { action, sessionId: getOrCreateSessionId(), ...payload };

    _chain = _chain
        .then(() => Outbox.enqueue(op))
        .then(() => requestSync(1500))
        .catch(e => {
            console.error('Could not store write on this device:', e);
            _lastStoreError = e;
            refreshSyncStatus();
        });

    return _chain;
}

let _lastStoreError = null;

/**
 * Await a promise before navigating away, but never for longer than `ms`.
 * Storing a write on the device takes milliseconds; the timeout is only
 * there so a participant can never be trapped on a dead button if the
 * browser's storage misbehaves.
 */
export const settleWithin = (promise, ms = 4000) =>
    Promise.race([
        Promise.resolve(promise).catch(e => console.warn('Save failed:', e)),
        new Promise(res => setTimeout(res, ms))
    ]);


/* ════════════════════════════════════════════════════════════════
   WRITES
   ════════════════════════════════════════════════════════════════ */

/**
 * Save the demographics and consent from page 1. The moment of consent is
 * taken from the device clock, since the write may not reach the server for
 * days.
 */
export const saveMeta = (data) => _queue('meta', { ...data, startedAt: Date.now() });

/**
 * Save the follow-up answers for one completed place (one spray-then-submit
 * round). `placeKey` is the id minted client-side when that round of
 * spraying began, and `data` carries the place's answers.
 */
export const savePlace = (question, placeKey, data) =>
    _queue('place', { question, place: placeKey, ...data });

/** Final submit: stamps the completion time, from the device clock. */
export const submitSurvey = () => _queue('submit', { submittedAt: Date.now() });


/**
 * Buffered writer for spray dots.
 *
 * The spray loop produces a dot every 12 ms (~83 per second). Writing each
 * one to the outbox separately would mean thousands of tiny records, so
 * this collects dots — and the deletions that Undo produces — and stores
 * them as one outbox write every `flushMs`, or whenever a stroke ends.
 *
 * Every dot carries the "place" it belongs to (the id of the current
 * spray-then-submit round) and its own position within that place: 0, 1, 2,
 * … The pair is enough for Undo to name a specific dot and for a re-sent
 * batch to be harmless.
 */
export function createDotBuffer(question, flushMs = 500) {

    // Dots painted but not yet stored, keyed by "place:seq".
    let pendingAdd = new Map();

    // { place, seq } pairs already stored that Undo has since removed.
    let pendingRemove = [];

    // The next sequence number to hand out for each place currently in play.
    let nextSeq = new Map();

    // The flush timer, or null when no flush is scheduled.
    let timer = null;

    /** Store whatever is buffered, and return a promise for it being stored. */
    function send() {
        if (timer) { window.clearTimeout(timer); timer = null; }

        // Take the current buffers and reset them, so dots painted meanwhile
        // collect into the next write rather than this one.
        const add    = [...pendingAdd.values()];
        const remove = pendingRemove;
        pendingAdd    = new Map();
        pendingRemove = [];

        if (!add.length && !remove.length) return _chain;

        return _queue('dots', { question, add, remove });
    }

    /** Schedule a flush if one is not already pending. */
    function scheduleFlush() {
        if (!timer) timer = window.setTimeout(send, flushMs);
    }

    return {
        /**
         * Buffer one dot. Returns its sequence number within its place,
         * which is what the caller hands back to delete() if it is undone.
         */
        queue(pos, zoom, placeKey) {
            const seq = nextSeq.get(placeKey) ?? 0;
            nextSeq.set(placeKey, seq + 1);

            pendingAdd.set(placeKey + ':' + seq, {
                place: placeKey,
                seq,
                // Six decimal places (~0.1 m) matches the database column.
                lat: Number(pos.lat.toFixed(6)),
                lng: Number(pos.lng.toFixed(6)),
                zoom,
                // The moment this dot was sprayed, from the device clock.
                t: Date.now()
            });

            scheduleFlush();
            return seq;
        },

        /** Remove one dot: from the buffer if not yet stored, otherwise via the outbox. */
        delete(placeKey, seq) {
            const mapKey = placeKey + ':' + seq;

            // Still buffered: dropping it here saves storing and sending a dot
            // only to delete it again straight afterwards.
            if (pendingAdd.has(mapKey)) {
                pendingAdd.delete(mapKey);
                return;
            }

            pendingRemove.push({ place: placeKey, seq });
            scheduleFlush();
        },

        /**
         * Discard every dot belonging to one place. Scoped to a single spray
         * round, so "Clear all" cannot wipe out places already saved.
         */
        clear(placeKey) {
            for (const [mapKey, dot] of pendingAdd) {
                if (dot.place === placeKey) pendingAdd.delete(mapKey);
            }
            pendingRemove = pendingRemove.filter(r => r.place !== placeKey);
            if (timer && pendingAdd.size === 0 && pendingRemove.length === 0) {
                window.clearTimeout(timer);
                timer = null;
            }

            // Queued behind every earlier write, so dots already stored for
            // this place are deleted on the server after they have arrived.
            return _queue('clear', { question, place: placeKey });
        },

        /** Store anything still buffered; resolves once it is on the device. */
        flush() {
            return send();
        }
    };
}


/* ════════════════════════════════════════════════════════════════
   UPLOADING
   ════════════════════════════════════════════════════════════════ */

let _syncTimer = null;
let _retryMs   = RETRY_MIN_MS;
let _syncing   = false;

/**
 * Try to upload the outbox in `delay` ms, unless an attempt is already
 * scheduled sooner. Called after every write, and on every hint that a
 * connection may have come back.
 */
export function requestSync(delay = 0) {
    if (_syncTimer) return;
    _syncTimer = window.setTimeout(_runSync, delay);
}

async function _runSync() {
    _syncTimer = null;

    // An upload is still in flight on a slow connection: check back later
    // rather than stacking a second attempt behind it.
    if (_syncing) { requestSync(_retryMs); return; }

    _syncing = true;
    refreshSyncStatus();

    try {
        await Outbox.drain();
        _retryMs = RETRY_MIN_MS;
    } catch (e) {
        // Back off, so a phone sitting out of signal for hours is not
        // burning battery on a request every few seconds.
        _retryMs = Math.min(_retryMs * 2, RETRY_MAX_MS);
    } finally {
        _syncing = false;
    }

    const { pending } = await Outbox.counts();
    if (pending > 0) requestSync(_retryMs);
    refreshSyncStatus();
}

/* A connection coming back, or the participant returning to the tab, is the
   best moment to try again — no need to wait out the backoff. */
window.addEventListener('online', () => { _retryMs = RETRY_MIN_MS; requestSync(0); });
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestSync(0);
});

// And straight away on every page load, for anything left from last time.
requestSync(500);


/* ════════════════════════════════════════════════════════════════
   STATUS LINE
   A small line on every page saying whether answers are safely uploaded
   or waiting on the device. It is mostly for the field team: it is how
   they know whether a phone needs to be taken somewhere with signal.
   ════════════════════════════════════════════════════════════════ */

export async function refreshSyncStatus() {
    const el = document.getElementById('sync-status');
    if (!el) return;

    let c;
    try { c = await Outbox.counts(); } catch (e) { c = { pending: 0, failed: 0, durable: false }; }

    let state, text;
    if (_lastStoreError || !c.durable) {
        state = 'warn';
        text  = 'This browser cannot save answers on the device. Keep the survey open until it has uploaded.';
    } else if (c.pending === 0) {
        state = 'ok';
        text  = 'All answers uploaded';
    } else if (_syncing) {
        state = 'busy';
        text  = `Uploading… ${c.pending} waiting`;
    } else {
        state = 'wait';
        text  = `Saved on this device · ${c.pending} waiting for signal`;
    }

    if (c.failed > 0) {
        state = 'warn';
        text += ` · ${c.failed} could not be uploaded (see Field setup)`;
    }

    el.dataset.state = state;
    el.textContent   = text;
}

/** Outbox counts for pages that show their own detail (thankyou, setup). */
export const outboxCounts = () => Outbox.counts();

window.setInterval(refreshSyncStatus, 3000);
refreshSyncStatus();


/* ════════════════════════════════════════════════════════════════
   LOCAL COPY
   ════════════════════════════════════════════════════════════════ */

/** Read the working copy of the answers out of localStorage. */
export function loadSurveyLocal() {
    try {
        return JSON.parse(localStorage.getItem(SURVEY_KEY) || '{}');
    } catch (e) {
        // Corrupted JSON should cost the participant nothing worse than their
        // pre-filled answers; a thrown error here would break the whole page.
        console.warn('Local survey copy unreadable:', e);
        return {};
    }
}

/**
 * Persist the survey blob to localStorage without ever throwing.
 *
 * This copy is only used to pre-fill pages and redraw earlier places; the
 * outbox holds the data that matters. A long spray session can still exceed
 * the ~5 MB quota, though, so on overflow each place's dots are dropped and
 * its answers kept. Returns true if anything was stored.
 */
export function saveSurveyLocal(d) {
    try {
        localStorage.setItem(SURVEY_KEY, JSON.stringify(d));
        return true;

    } catch (e) {
        try {
            const slim = { ...d };
            Object.keys(slim)
                  .filter(k => k.startsWith('places_'))
                  .forEach(k => {
                      slim[k] = slim[k].map(({ dots, ...rest }) => rest);
                  });

            localStorage.setItem(SURVEY_KEY, JSON.stringify(slim));
            console.warn('localStorage full — place geometry dropped from the ' +
                         'local copy (it is safe in the outbox).');
            return true;

        } catch (e2) {
            console.warn('Could not write to localStorage:', e2);
            return false;
        }
    }
}

/** Clear both the answers and the session ID (used by "Start Again"). */
export function clearSurveyLocal() {
    localStorage.removeItem(SURVEY_KEY);
    localStorage.removeItem(SESSION_KEY);
}
