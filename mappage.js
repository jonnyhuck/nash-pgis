/* ─────────────────────────────────────────────────────────────────
   mappage.js  –  shared behaviour for the two map pages

   Loaded as a module, after config.js, outbox.js and spray.js. Each map
   page differs only in its question, its spray colour, its follow-up
   sheet, and where NEXT goes, so both share this file and supply the
   differences in a window.PAGE_CONFIG object defined inline just above:

     window.PAGE_CONFIG = {
         question: 'ticks',                 // database key
         colours:  { ticks: '#dc2626' },    // dot fill colour
         prev:     'index.html',            // PREV target
         next:     'map2.html',             // NEXT target
         isFinal:  false                    // last map? then submit
     };

   A participant may mark any number of places on a question, pressing
   "Spray again" after each one. Each round of spraying — from the moment the
   spraycan is first picked up to the moment its follow-up sheet is saved —
   is a "place", identified by a client-generated id (see api.js's newId()).
   That id tags every dot painted during the round, long before the round's
   own database row exists.

   The follow-up sheet is read generically rather than field by field:
   every control group inside #form-modal carries a data-field attribute
   naming the answer it produces, and data-required="true" if that answer
   is mandatory. Both map pages share every line of the code below.
   ───────────────────────────────────────────────────────────────── */

import {
    createDotBuffer, savePlace, submitSurvey, newId,
    settleWithin, loadSurveyLocal, saveSurveyLocal
} from './api.js';
import { addBoundary } from './boundary.js';


/* ── Configuration ─────────────────────────────────────────────── */

// Everything that varies between the two pages.
const CFG = window.PAGE_CONFIG;

// The base map, shared with the setup page and sw.js.
const { MAX_ZOOM, TILE_URL, TILE_SUBDOMAINS } = window.SURVEY_CONFIG;

// The localStorage key under which every place recorded for this question is
// kept: [{ place, trend, confidence, dots }, …].
const PLACES_KEY = 'places_' + CFG.question;


/* ── Consent guard ─────────────────────────────────────────────── */

/* Anyone who reaches a map page without having consented on page 1 is sent
   back there. Painting the map is data collection, and it must not start
   before consent has been given and recorded. */
const survey = loadSurveyLocal();

if (!survey.consent) {
    // replace() rather than href, so the map page does not become a Back-button
    // trap between the participant and the consent form.
    window.location.replace('index.html');

    /* Navigation is asynchronous, so without this the rest of the module would
       still run and arm a spraycan on a page the participant is leaving. A
       top-level await that never resolves halts module evaluation here. */
    await new Promise(() => {});
}


/* ── Map ───────────────────────────────────────────────────────── */

/* Exposed on window because spray.js is a classic script and cannot import
   from a module. The same goes for the colour lookup and the active-place id
   further down.

   No starting view here: addBoundary() below sets it by zooming to the
   study-area outline. Panning is deliberately unrestricted, since people
   may know areas well beyond the boundary. */
window.map = L.map('map', {
    zoomControl: false,
    // A slightly generous tap tolerance: fingers are less precise than mice.
    tap: true,
    tapTolerance: 15,
    maxZoom: MAX_ZOOM
});

// Local alias, purely so the rest of this file reads normally.
const map = window.map;

L.control.zoom({ position: 'topright' }).addTo(map);

// A scale bar gives the participant a sense of how large an area they are
// covering with each stroke, which shapes how precisely they paint.
L.control.scale({ imperial: false, metric: true, position: 'bottomright' }).addTo(map);

/* Google Satellite. The service worker serves each tile from the device if it
   has been seen or pre-downloaded before (see setup.html), so the map works
   without signal wherever the field team has prepared it.

   crossOrigin makes the tile requests CORS rather than opaque, which is what
   lets them be cached at their real size — see sw.js. */
L.tileLayer(TILE_URL, {
    subdomains:  TILE_SUBDOMAINS,
    attribution: 'Imagery &copy; Google',
    maxZoom:     MAX_ZOOM,
    crossOrigin: true,
    // Fewer tiles requested during a pinch: on a weak connection, tiles for
    // zoom levels flicked straight past are wasted bandwidth.
    updateWhenZooming: false
}).addTo(map);

// Outline the study area and open zoomed to it. Until it resolves, Reset map
// has nothing to return to, so it does nothing.
let resetToBoundary = () => {};
addBoundary(map).then(reset => { resetToBoundary = reset; });

/** Return the map to the study area, for anyone who gets lost. */
function resetView() {
    resetToBoundary();
}


/* ── Spray wiring ──────────────────────────────────────────────── */

// Colour lookup, read by spray.js when it styles each dot.
window.colourMap = CFG.colours;

// The buffered writer that batches this page's dots into the outbox.
window.dotStore = createDotBuffer(CFG.question);

// The id of the round currently being painted. spray.js reads this directly
// off window and tags every dot with it. Reassigned each time a place is saved.
window.activePlaceKey = null;


/* ── Places already recorded on this question ────────────────────── */

// Restored from localStorage: every place saved so far this session.
let places = Array.isArray(survey[PLACES_KEY]) ? survey[PLACES_KEY] : [];

// Redraw each one in its locked, committed style, so the participant has
// spatial context for whatever they mark next.
places.forEach(place => { if (place.dots) loadSprayData(place.dots); });

/** Reflect how many places have been recorded so far. */
function updatePlacesCount() {
    const el = document.getElementById('places-count');
    if (!el) return;

    const n = places.length;
    el.textContent = n === 0 ? 'No areas added yet'
                    : n === 1 ? '1 area added'
                    : `${n} areas added`;
}

updatePlacesCount();

/** Begin a fresh round: a new place id, ready for the spraycan. */
function startNewRound() {
    window.activePlaceKey = newId();
}

startNewRound();


/* ── The follow-up sheet ──────────────────────────────────────────
   Read generically: every answer-producing element inside #form-modal
   carries data-field="…" naming the key it fills, and data-required="true"
   if it must be answered before the sheet can be saved. A group with
   data-type="int" has its answer sent as a number. */

const modal    = document.getElementById('form-modal');
const modalBtn = document.getElementById('modal-confirm-btn');

// Set when the sheet is opened, by which of the two outer buttons opened it.
let pendingAction = null;

/** The answer one data-field element currently holds, or null / [] if none. */
function fieldValue(el) {
    if (el.classList.contains('modal-check-group')) {
        return [...el.querySelectorAll('input:checked')].map(cb => cb.value);
    }
    if (el.classList.contains('modal-radio-group')) {
        const checked = el.querySelector('input:checked');
        if (!checked) return null;
        return el.dataset.type === 'int' ? parseInt(checked.value, 10) : checked.value;
    }
    if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
        return el.value.trim() || null;
    }
    return null;
}

/** Every answer on the sheet, keyed by data-field. The dots are not included. */
function readModalFields() {
    const out = {};
    modal.querySelectorAll('[data-field]').forEach(el => { out[el.dataset.field] = fieldValue(el); });
    return out;
}

/** True once every data-required field on the sheet has an answer. */
function modalFieldsValid() {
    return [...modal.querySelectorAll('[data-required="true"]')].every(el => {
        const v = fieldValue(el);
        // 0 is a real answer on the confidence scale, so only null / empty fail.
        return Array.isArray(v) ? v.length > 0 : v !== null;
    });
}

/** Clear every answer on the sheet, ready for the next place. */
function resetModalFields() {
    modal.querySelectorAll('input:checked').forEach(i => { i.checked = false; });
    modal.querySelectorAll('select, textarea').forEach(el => { el.value = ''; });
}

/** Enable or disable the sheet's own confirm button. */
function updateModalGate() {
    modalBtn.disabled = !modalFieldsValid();
}

modal.addEventListener('change', updateModalGate);

/**
 * Open the follow-up sheet for the round just finished.
 * `action` is 'sprayAgain' or 'next' — which outer button asked for this.
 */
function openModal(action) {
    // Painting must stop before the sheet covers the map.
    deactivateSpray();

    pendingAction = action;

    modalBtn.textContent = action === 'sprayAgain' ? 'Save & spray again'
                          : CFG.isFinal            ? 'Save & submit'
                          :                           'Save & continue';

    updateModalGate();
    modal.classList.remove('hidden');
    modal.querySelector('.modal-sheet').scrollTop = 0;
}

/** Close the sheet and return to the map, keeping whatever was entered. */
function closeModal() {
    modal.classList.add('hidden');
}

/**
 * Save the round just finished: its answers into the outbox, its dots locked
 * into the committed layer, and the whole place appended to the local list.
 * Then either starts a new round on this page, or moves on.
 */
async function confirmModal() {
    if (!modalFieldsValid()) return;

    modalBtn.disabled = true;

    const placeKey = window.activePlaceKey;
    const fields   = readModalFields();

    // The local record includes the geometry, for redrawing this place if the
    // participant steps back to this page later.
    places.push({ place: placeKey, ...fields, dots: getSprayData() });

    const d = loadSurveyLocal();
    d[PLACES_KEY] = places;
    saveSurveyLocal(d);

    /* Any dots still buffered go into the outbox first, then the answers that
       describe them, so the server always receives them in that order. Both
       are stored on the device in milliseconds; nothing waits on signal. */
    await settleWithin(window.dotStore.flush());
    await settleWithin(savePlace(CFG.question, placeKey, fields));

    commitSpray();
    resetModalFields();
    closeModal();
    updatePlacesCount();
    updateMainButtons();

    startNewRound();

    if (pendingAction === 'sprayAgain') return;

    await proceed();
}


/* ── Outer buttons: PREV / SPRAY AGAIN / NEXT ─────────────────────── */

const sprayAgainBtn = document.getElementById('spray-again-btn');

/**
 * "Spray again" only makes sense once something has been painted in the
 * current round. Polled on a short timer rather than wired to the spray
 * loop's 12 ms tick, which would be far more often than needed.
 */
function updateMainButtons() {
    sprayAgainBtn.disabled = sprayCount() === 0;
}

window.setInterval(updateMainButtons, 300);
updateMainButtons();

function requestSprayAgain() {
    openModal('sprayAgain');
}

/**
 * NEXT / SUBMIT: with nothing painted in the current round there is nothing
 * new to describe, so the sheet is skipped and the participant moves on.
 */
function requestNext() {
    if (sprayCount() === 0) {
        proceed();
        return;
    }
    openModal('next');
}

/**
 * PREV: step back a page. A round painted but never saved through the sheet
 * is abandoned, and its dots are deleted on the server too, so the data is
 * never left with paint that has no answers attached to it.
 */
async function goBack() {
    deactivateSpray();
    if (sprayCount() > 0) clearSpray();
    await settleWithin(window.dotStore.flush());
    window.location.href = CFG.prev;
}

/**
 * Move on from this page. On the final map this also stamps the completion
 * time — queued behind everything else, so it is the last write to arrive.
 */
async function proceed() {
    deactivateSpray();
    await settleWithin(window.dotStore.flush());

    if (CFG.isFinal) {
        const d = loadSurveyLocal();
        d.submittedAt = new Date().toISOString();
        saveSurveyLocal(d);

        await settleWithin(submitSurvey());
    }

    window.location.href = CFG.next;
}

/* Last-ditch flush if the participant leaves by some route we do not control —
   closing the tab, the phone locking. pagehide fires where unload does not,
   notably on iOS. */
window.addEventListener('pagehide', () => {
    if (window.dotStore) window.dotStore.flush();
});


/* ── Expose to the inline handlers ─────────────────────────────── */

/* The buttons in the HTML use onclick attributes, which are evaluated in
   global scope and cannot see anything declared inside this module. */
window.resetView         = resetView;
window.requestSprayAgain = requestSprayAgain;
window.requestNext       = requestNext;
window.confirmModal      = confirmModal;
window.closeModal        = closeModal;
window.goBack            = goBack;

/* Undo and Clear change how many dots exist, which changes whether "Spray
   again" makes sense — so the outer buttons are re-checked after each. */
window.undoSprayAndCheck  = () => { undoSpray();  updateMainButtons(); };
window.clearSprayAndCheck = () => { clearSpray(); updateMainButtons(); };
