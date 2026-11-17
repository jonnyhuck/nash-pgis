/* ─────────────────────────────────────────────────────────────────
   outbox.js  –  the durable queue every write goes through

   Signal in the field is patchy, so nothing is ever sent straight to the
   server. Every write — demographics, a batch of spray dots, a place's
   follow-up answers, the final submit — is first stored here, in
   IndexedDB, and only removed once the server has acknowledged it. The
   queue survives reloads, closed tabs, flat batteries and days without
   signal, and it is drained strictly in the order things were written.

   A classic script, loaded by every page and by sw.js through
   importScripts(), so both can drain the same queue: the pages whenever
   they are open, the service worker through Background Sync (Chrome on
   Android) even after the browser has been closed. A Web Lock stops the
   two from draining at once, which would otherwise risk an Undo arriving
   before the dot it undoes.

   Everything is exposed on one global, Outbox.
   ───────────────────────────────────────────────────────────────── */

(function (global) {

    /* ── Settings ──────────────────────────────────────────────────── */

    const DB_NAME    = 'ticks_survey';
    const DB_VERSION = 1;

    // Stores: writes waiting to go; writes the server rejected outright (kept,
    // never deleted, so a bug in validation cannot destroy data); and a small
    // key-value store for sync bookkeeping shown on the status line.
    const PENDING = 'pending';
    const FAILED  = 'failed';
    const META    = 'meta';

    // How much one request may carry. Small enough to get through on a weak
    // 2G connection before the timeout, large enough that a long offline
    // backlog clears in a handful of requests rather than hundreds.
    const BATCH_OPS   = 40;
    const BATCH_BYTES = 256 * 1024;

    // How long to wait for the server before treating a request as lost. A
    // stalled connection on a weak signal can otherwise hang for minutes.
    const TIMEOUT_MS = 30000;

    const LOCK_NAME = 'ticks-outbox-drain';
    const SYNC_TAG  = 'ticks-outbox';


    /* ════════════════════════════════════════════════════════════════
       STORAGE
       Two interchangeable back ends with the same five operations. The
       IndexedDB one is what is normally used; the in-memory one exists only
       so that a browser without IndexedDB (some in-app webviews, old private
       modes) still works while the page stays open, rather than failing
       outright. The status line warns when it is in use.
       ════════════════════════════════════════════════════════════════ */

    /** Promise wrappers for IndexedDB's event-based requests and transactions. */
    const _req = r => new Promise((res, rej) => {
        r.onsuccess = () => res(r.result);
        r.onerror   = () => rej(r.error);
    });
    const _done = tx => new Promise((res, rej) => {
        tx.oncomplete = () => res();
        tx.onerror    = () => rej(tx.error);
        tx.onabort    = () => rej(tx.error || new Error('Transaction aborted'));
    });

    function _idbBackend(db) {
        return {
            durable: true,

            async add(store, value) {
                const tx = db.transaction(store, 'readwrite');
                tx.objectStore(store).add(value);
                await _done(tx);
            },

            async put(store, value, key) {
                const tx = db.transaction(store, 'readwrite');
                tx.objectStore(store).put(value, key);
                await _done(tx);
            },

            /** Up to `limit` records, oldest first (auto-increment key order). */
            async list(store, limit = Infinity) {
                const tx  = db.transaction(store, 'readonly');
                const out = [];
                await new Promise((res, rej) => {
                    const cur = tx.objectStore(store).openCursor();
                    cur.onerror   = () => rej(cur.error);
                    cur.onsuccess = () => {
                        const c = cur.result;
                        if (!c || out.length >= limit) return res();
                        out.push(c.value);
                        c.continue();
                    };
                });
                return out;
            },

            /** Delete some records and add others, in one atomic transaction. */
            async move(fromStore, ids, toStore, values) {
                const tx = db.transaction([fromStore, toStore], 'readwrite');
                ids.forEach(id => tx.objectStore(fromStore).delete(id));
                values.forEach(v => tx.objectStore(toStore).put(v));
                await _done(tx);
            },

            async remove(store, ids) {
                const tx = db.transaction(store, 'readwrite');
                ids.forEach(id => tx.objectStore(store).delete(id));
                await _done(tx);
            },

            async count(store) {
                return _req(db.transaction(store, 'readonly').objectStore(store).count());
            },

            async get(store, key) {
                return _req(db.transaction(store, 'readonly').objectStore(store).get(key));
            }
        };
    }

    function _memoryBackend() {
        const stores = { [PENDING]: new Map(), [FAILED]: new Map(), [META]: new Map() };
        let nextId = 1;

        return {
            durable: false,
            async add(store, value)      { const id = nextId++; stores[store].set(id, { ...value, id }); },
            async put(store, value, key) { stores[store].set(key ?? value.id, value); },
            async list(store, limit = Infinity) { return [...stores[store].values()].slice(0, limit); },
            async move(from, ids, to, values) {
                ids.forEach(id => stores[from].delete(id));
                values.forEach(v => stores[to].set(v.id, v));
            },
            async remove(store, ids) { ids.forEach(id => stores[store].delete(id)); },
            async count(store)       { return stores[store].size; },
            async get(store, key)    { return stores[store].get(key); }
        };
    }

    let _backendPromise = null;

    /** Open the database once per context, falling back to memory if it cannot be. */
    function _backend() {
        if (_backendPromise) return _backendPromise;

        _backendPromise = new Promise((res, rej) => {
            if (!global.indexedDB) return rej(new Error('IndexedDB unavailable'));

            const r = global.indexedDB.open(DB_NAME, DB_VERSION);

            r.onupgradeneeded = () => {
                const db = r.result;
                // Auto-increment keys are what give the queue its order.
                db.createObjectStore(PENDING, { keyPath: 'id', autoIncrement: true });
                db.createObjectStore(FAILED,  { keyPath: 'id' });
                db.createObjectStore(META);
            };
            r.onsuccess = () => res(_idbBackend(r.result));
            r.onerror   = () => rej(r.error);
        }).catch(e => {
            console.warn('Outbox: falling back to memory, data will not survive a reload:', e);
            return _memoryBackend();
        });

        return _backendPromise;
    }


    /* ════════════════════════════════════════════════════════════════
       QUEUE
       ════════════════════════════════════════════════════════════════ */

    /**
     * Store one write for sending. `op` is exactly the JSON body the server
     * expects for a single action — { action, sessionId, … } — so it can be
     * sent on its own or as part of a batch without being reshaped.
     *
     * The session ID is part of the op rather than added at send time: on a
     * shared device the next participant may have started (and been given a
     * new session ID) long before this write finally reaches the server.
     */
    async function enqueue(op) {
        const b = await _backend();
        await b.add(PENDING, { op, queuedAt: Date.now() });
        _requestBackgroundSync();
    }

    /** How many writes are waiting, how many were rejected, and whether they are safe. */
    async function counts() {
        const b = await _backend();
        return {
            pending: await b.count(PENDING),
            failed:  await b.count(FAILED),
            durable: b.durable
        };
    }

    /** Sync bookkeeping: lastAttemptAt, lastSuccessAt, lastError. */
    async function getMeta() {
        const b = await _backend();
        return (await b.get(META, 'sync')) || {};
    }

    async function _setMeta(patch) {
        const b = await _backend();
        const cur = (await b.get(META, 'sync')) || {};
        await b.put(META, { ...cur, ...patch }, 'sync');
    }

    /**
     * Ask the browser to wake the service worker and drain the queue once it
     * next has a connection, even if every tab has been closed by then.
     * Chrome-only at present; elsewhere the pages' own retry loop covers it.
     */
    function _requestBackgroundSync() {
        try {
            if (global.registration && global.registration.sync) {
                // Inside the service worker itself.
                global.registration.sync.register(SYNC_TAG).catch(() => {});
            } else if (global.navigator && global.navigator.serviceWorker &&
                       global.navigator.serviceWorker.controller) {
                global.navigator.serviceWorker.ready
                    .then(reg => reg.sync && reg.sync.register(SYNC_TAG))
                    .catch(() => {});
            }
        } catch (e) { /* Background Sync is a bonus, never a requirement. */ }
    }


    /* ════════════════════════════════════════════════════════════════
       SENDING
       ════════════════════════════════════════════════════════════════ */

    /**
     * POST a batch of ops and return the server's per-op results.
     * Throws a TransientError for anything that might succeed if retried —
     * no connection, a timeout, a server error, or a captive-portal login
     * page masquerading as a reply.
     */
    async function _post(ops) {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

        let res;
        try {
            res = await fetch(global.SURVEY_CONFIG.API_URL, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ action: 'batch', ops }),
                signal:  ctrl.signal,
                cache:   'no-store'
            });
        } catch (e) {
            throw new TransientError(ctrl.signal.aborted ? 'Timed out' : 'No connection');
        } finally {
            clearTimeout(timer);
        }

        let data = null;
        try { data = await res.json(); } catch (e) { /* not JSON: see below */ }

        // A 4xx other than timeout / rate-limit means the request itself was
        // refused, and sending it again unchanged will not help.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
            const err = new Error((data && data.error) || `HTTP ${res.status}`);
            err.rejected = true;
            throw err;
        }

        if (!res.ok || !data || !data.ok || !Array.isArray(data.results) ||
            data.results.length !== ops.length) {
            throw new TransientError((data && data.error) || `HTTP ${res.status}`);
        }

        return data.results;
    }

    class TransientError extends Error {}

    /**
     * Send everything waiting, oldest first, and remove each write once the
     * server has confirmed it. Resolves with { sent } once the queue is empty;
     * rejects (leaving the rest queued) at the first sign the connection has
     * gone, so the caller can back off and try again later.
     *
     * Safe to call as often as you like: only one drain runs at a time across
     * every open page and the service worker.
     */
    async function drain() {
        if (global.navigator && global.navigator.onLine === false) {
            throw new TransientError('Offline');
        }

        const run = async () => {
            const b = await _backend();
            let sent = 0;

            // Set when a whole batch is refused: the next attempt sends one op
            // at a time, so a single bad write is isolated rather than holding
            // up everything queued behind it.
            let single = false;

            await _setMeta({ lastAttemptAt: Date.now() });

            try {
                for (;;) {
                    const records = await b.list(PENDING, single ? 1 : BATCH_OPS);
                    if (!records.length) break;

                    // Trim the batch to the byte budget, always keeping at least one.
                    let bytes = 0, n = 0;
                    while (n < records.length) {
                        bytes += JSON.stringify(records[n].op).length;
                        if (n > 0 && bytes > BATCH_BYTES) break;
                        n++;
                    }
                    const batch = records.slice(0, n);

                    let results;
                    try {
                        results = await _post(batch.map(r => r.op));
                    } catch (e) {
                        if (!e.rejected) throw e;
                        if (batch.length > 1) { single = true; continue; }
                        // A single op the server will not accept at all.
                        results = [{ ok: false, error: e.message }];
                    }

                    // Accepted writes are deleted; refused ones are moved to the
                    // failed store in the same transaction, never discarded.
                    const done   = [];
                    const failed = [];
                    batch.forEach((r, i) => {
                        done.push(r.id);
                        if (!results[i].ok) {
                            failed.push({ ...r, error: results[i].error || 'Rejected', failedAt: Date.now() });
                        }
                    });
                    await b.move(PENDING, done, FAILED, failed);

                    sent  += done.length - failed.length;
                    single = false;
                }
            } catch (e) {
                await _setMeta({ lastError: e.message, lastErrorAt: Date.now() });
                throw e;
            }

            await _setMeta({ lastSuccessAt: Date.now(), lastError: null });
            return { sent };
        };

        // Web Locks are available in pages and service workers alike. Without
        // them (very old browsers) the drain simply runs unguarded.
        const locks = global.navigator && global.navigator.locks;
        if (!locks) return run();

        return locks.request(LOCK_NAME, { ifAvailable: true },
                             lock => lock ? run() : { sent: 0, busy: true });
    }


    /* ════════════════════════════════════════════════════════════════
       BACKUP AND RECOVERY (used by the setup page)
       ════════════════════════════════════════════════════════════════ */

    /**
     * Everything not yet on the server, as a plain object that can be saved
     * to a file. Last resort for a device that will not see signal again
     * before it has to be wiped or handed back.
     */
    async function exportBackup() {
        const b = await _backend();
        return {
            format:     'ticks-survey-outbox',
            version:    1,
            exportedAt: new Date().toISOString(),
            pending:    (await b.list(PENDING)).map(r => r.op),
            failed:     (await b.list(FAILED)).map(r => ({ op: r.op, error: r.error }))
        };
    }

    /**
     * Queue every write in a backup file for sending from this device.
     * Every server action is idempotent, so importing a file twice, or a file
     * whose writes partly arrived already, is harmless. Returns how many
     * writes were queued.
     */
    async function importBackup(data) {
        if (!data || data.format !== 'ticks-survey-outbox') {
            throw new Error('Not a survey backup file');
        }
        const ops = [
            ...(Array.isArray(data.pending) ? data.pending : []),
            ...(Array.isArray(data.failed)  ? data.failed.map(f => f.op) : [])
        ].filter(op => op && typeof op.action === 'string' && typeof op.sessionId === 'string');

        for (const op of ops) await enqueue(op);
        return ops.length;
    }

    /** Put every rejected write back on the queue, e.g. after a server fix. */
    async function retryFailed() {
        const b = await _backend();
        const failed = await b.list(FAILED);
        for (const r of failed) await b.add(PENDING, { op: r.op, queuedAt: r.queuedAt });
        await b.remove(FAILED, failed.map(r => r.id));
        return failed.length;
    }


    global.Outbox = {
        enqueue, counts, drain, getMeta,
        exportBackup, importBackup, retryFailed,
        SYNC_TAG
    };

})(self);
