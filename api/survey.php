<?php
/* ─────────────────────────────────────────────────────────────────
   survey.php  –  the single write endpoint for the ticks survey

   Every write is JSON of the form { action: "…", sessionId: "…", … }.
   Phones queue their writes offline and upload them later, usually many
   at once, so the normal request is a batch:

     { action: "batch", ops: [ {action, sessionId, …}, … ] }
       → { ok: true, results: [ {ok: true} | {ok: false, error}, … ] }

   The ops are applied strictly in order. A write that can never be
   accepted (bad session, unknown question) is reported in its own result
   and the rest still go through; a database failure fails the whole
   request with a 5xx, so the phone keeps everything and tries again.
   Every action is idempotent — safe to apply twice — because a phone that
   loses signal mid-request cannot know whether its batch arrived.

   Actions:
     meta    – page 1 answers and consent
     dots    – add and/or remove spray dots for one place (spray round)
     clear   – remove every dot for one place
     place   – the follow-up answers for one completed place
     submit  – the completion time

   A single action can also be posted on its own, outside a batch.
   ───────────────────────────────────────────────────────────────── */

declare(strict_types=1);

require_once __DIR__ . '/db.php';


/* ── Request guard ───────────────────────────────────────────────
   Only POST writes. Rejecting GET keeps the endpoint out of reach of link
   prefetchers and crawlers. */
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail('POST required', 405);
}

$in  = read_json();
$pdo = db();

if (($in['action'] ?? null) === 'batch') {
    $ops = is_array($in['ops'] ?? null) ? $in['ops'] : [];

    if (count($ops) > MAX_OPS_PER_BATCH) {
        fail('Too many writes in one batch', 413);
    }

    $results = [];
    foreach ($ops as $op) {
        try {
            $results[] = run_op($pdo, is_array($op) ? $op : []);
        } catch (ApiError $e) {
            $results[] = ['ok' => false, 'error' => $e->getMessage()];
        } catch (PDOException $e) {
            // Earlier ops in this batch are already applied; that is fine,
            // since they are idempotent and the phone will resend them.
            error_log('Ticks survey batch failed: ' . $e->getMessage());
            fail('Could not save', 500);
        }
    }

    send_json(['ok' => true, 'results' => $results]);
}

try {
    send_json(run_op($pdo, $in));
} catch (ApiError $e) {
    fail($e->getMessage());
} catch (PDOException $e) {
    error_log('Ticks survey write failed: ' . $e->getMessage());
    fail('Could not save', 500);
}


/* ════════════════════════════════════════════════════════════════
   DISPATCH
   ════════════════════════════════════════════════════════════════ */

/**
 * Apply one write, returning its result. Throws ApiError for a write that
 * can never be accepted, and lets PDOException through for a database
 * failure, which is worth retrying.
 */
function run_op(PDO $pdo, array $in): array
{
    $action    = is_string($in['action']    ?? null) ? $in['action']    : '';
    $sessionId = is_string($in['sessionId'] ?? null) ? $in['sessionId'] : '';

    // A write without a plausible session ID cannot be filed against anyone.
    if (!valid_session($sessionId)) {
        throw new ApiError('Invalid session');
    }

    $rid = response_id($pdo, $sessionId);

    switch ($action) {
        case 'meta':   return save_meta($pdo, $rid, $in);
        case 'dots':   return save_dots($pdo, $rid, $in);
        case 'clear':  return clear_dots($pdo, $rid, $in);
        case 'place':  return save_place($pdo, $rid, $in);
        case 'submit': return submit_survey($pdo, $rid, $in);
    }

    // Anything else is a bug in the client or a probe from outside.
    throw new ApiError('Unknown action');
}


/* ════════════════════════════════════════════════════════════════
   ACTIONS
   ════════════════════════════════════════════════════════════════ */

/**
 * meta – page 1: age, education, residence, livestock, and consent.
 */
function save_meta(PDO $pdo, int $rid, array $in): array
{
    $livesHere      = clean_yes_no($in['livesHere']      ?? null);
    $keepsLivestock = clean_yes_no($in['keepsLivestock'] ?? null);

    /* The follow-ups are only kept when their question was answered "yes",
       so the data can never claim years of livestock keeping from someone
       who said they keep none. */
    $params = [
        ':age'            => clean_int($in['age'] ?? null, 1, 120),
        ':education'      => clean_choice($in['education'] ?? null, EDUCATIONS),
        ':livesHere'      => $livesHere,
        ':livesYears'     => $livesHere === 1 ? clean_int($in['livesYears'] ?? null, 0, 120) : null,
        ':keepsLivestock' => $keepsLivestock,
        ':livestockYears' => $keepsLivestock === 1 ? clean_int($in['livestockYears'] ?? null, 0, 120) : null,
        ':livestock'      => $keepsLivestock === 1 ? clean_set($in['livestock'] ?? null, LIVESTOCK) : null,
        ':consent'        => !empty($in['consent']) ? 1 : 0,
        ':startedAt'      => clean_client_time($in['startedAt'] ?? null),
        ':rid'            => $rid,
    ];

    /* started_at is only set if it is still NULL: a participant who steps
       back to page 1 and forward again would otherwise keep pushing their
       start time later. Consent can only ever go from 0 to 1. */
    $sql = 'UPDATE responses
               SET age             = :age,
                   education       = :education,
                   lives_here      = :livesHere,
                   lives_years     = :livesYears,
                   keeps_livestock = :keepsLivestock,
                   livestock_years = :livestockYears,
                   livestock       = :livestock,
                   consent         = GREATEST(consent, :consent),
                   started_at      = COALESCE(started_at, :startedAt)
             WHERE id = :rid';

    $pdo->prepare($sql)->execute($params);

    return ['ok' => true];
}


/**
 * dots – add new spray dots and/or remove undone ones, for one place.
 */
function save_dots(PDO $pdo, int $rid, array $in): array
{
    $question = require_question($in);

    // Both lists are optional; a write with only removals is common (Undo).
    $add    = is_array($in['add']    ?? null) ? $in['add']    : [];
    $remove = is_array($in['remove'] ?? null) ? $in['remove'] : [];

    if (count($add) > MAX_DOTS_PER_REQUEST || count($remove) > MAX_DOTS_PER_REQUEST) {
        throw new ApiError('Too many dots in one write');
    }

    /* One transaction per write, so a stroke lands whole or not at all. */
    $pdo->beginTransaction();

    try {
        if ($add) {
            /* ON DUPLICATE KEY UPDATE makes a re-sent write harmless: the dots
               are updated in place rather than duplicated. */
            $stmt = $pdo->prepare(
                'INSERT INTO dots
                     (response_id, question, place_key, dot_seq, lat, lng, zoom, sprayed_at)
                 VALUES (:rid, :q, :place, :seq, :lat, :lng, :zoom, :sprayedAt)
                 ON DUPLICATE KEY UPDATE
                     lat = VALUES(lat), lng = VALUES(lng),
                     zoom = VALUES(zoom), sprayed_at = VALUES(sprayed_at)');

            foreach ($add as $dot) {
                // Skip anything malformed rather than aborting the write: one
                // bad dot should not cost the participant the whole stroke.
                if (!is_array($dot)) {
                    continue;
                }

                $place = is_string($dot['place'] ?? null) ? $dot['place'] : '';
                $seq   = clean_seq($dot['seq'] ?? null);
                $lat   = clean_coord($dot['lat'] ?? null, 90);
                $lng   = clean_coord($dot['lng'] ?? null, 180);

                if (!valid_session($place) || $seq === null || $lat === null || $lng === null) {
                    continue;
                }

                $stmt->execute([
                    ':rid'       => $rid,
                    ':q'         => $question,
                    ':place'     => $place,
                    ':seq'       => $seq,
                    ':lat'       => $lat,
                    ':lng'       => $lng,
                    ':zoom'      => isset($dot['zoom']) ? clean_int($dot['zoom'], 0, 30) : null,
                    ':sprayedAt' => clean_client_time($dot['t'] ?? null),
                ]);
            }
        }

        if ($remove) {
            /* response_id and question are in the WHERE clause as well, so a
               participant can only ever delete their own dots. */
            $stmt = $pdo->prepare(
                'DELETE FROM dots
                  WHERE response_id = :rid
                    AND question    = :q
                    AND place_key   = :place
                    AND dot_seq     = :seq');

            foreach ($remove as $dot) {
                if (!is_array($dot)) {
                    continue;
                }

                $place = is_string($dot['place'] ?? null) ? $dot['place'] : '';
                $seq   = clean_seq($dot['seq'] ?? null);

                if (!valid_session($place) || $seq === null) {
                    continue;
                }

                $stmt->execute([':rid' => $rid, ':q' => $question, ':place' => $place, ':seq' => $seq]);
            }
        }

        $pdo->commit();

    } catch (PDOException $e) {
        $pdo->rollBack();
        throw $e;
    }

    return ['ok' => true];
}


/**
 * clear – remove every dot belonging to one place (one spray round).
 * Scoped to a single place, so earlier saved places survive "Clear all".
 */
function clear_dots(PDO $pdo, int $rid, array $in): array
{
    $question = require_question($in);
    $place    = require_place($in);

    $pdo->prepare('DELETE FROM dots WHERE response_id = :rid AND question = :q AND place_key = :place')
        ->execute([':rid' => $rid, ':q' => $question, ':place' => $place]);

    return ['ok' => true];
}


/**
 * place – the follow-up answers for one completed place: how ticks there
 * have changed, and how confident the participant is in that.
 */
function save_place(PDO $pdo, int $rid, array $in): array
{
    $question = require_question($in);
    $place    = require_place($in);

    // seq is set only on first insert: it is deliberately absent from the
    // UPDATE clause, so a re-sent save of the same place cannot renumber it.
    $stmt = $pdo->prepare(
        'INSERT INTO places (place_key, response_id, question, seq, trend, confidence)
         VALUES (:place, :rid, :q, :seq, :trend, :confidence)
         ON DUPLICATE KEY UPDATE
             trend      = VALUES(trend),
             confidence = VALUES(confidence)');

    $stmt->execute([
        ':place'      => $place,
        ':rid'        => $rid,
        ':q'          => $question,
        ':seq'        => next_seq($pdo, $rid, $question, $place),
        ':trend'      => clean_choice($in['trend'] ?? null, TRENDS[$question]),
        ':confidence' => clean_int($in['confidence'] ?? null, 0, 10),
    ]);

    return ['ok' => true];
}


/**
 * submit – the moment SUBMIT was pressed, from the phone's clock. Kept only
 * the first time, so a re-sent submit cannot move it.
 */
function submit_survey(PDO $pdo, int $rid, array $in): array
{
    $pdo->prepare('UPDATE responses
                      SET submitted_at = COALESCE(submitted_at, :submittedAt)
                    WHERE id = :rid')
        ->execute([':submittedAt' => clean_client_time($in['submittedAt'] ?? null), ':rid' => $rid]);

    return ['ok' => true];
}


/* ════════════════════════════════════════════════════════════════
   HELPERS
   ════════════════════════════════════════════════════════════════ */

/** The write's question, which must be one of QUESTIONS. */
function require_question(array $in): string
{
    $question = is_string($in['question'] ?? null) ? $in['question'] : '';
    if (!valid_question($question)) {
        throw new ApiError('Unknown question');
    }
    return $question;
}

/** The write's place key, which must look like a client-generated id. */
function require_place(array $in): string
{
    $place = is_string($in['place'] ?? null) ? $in['place'] : '';
    if (!valid_session($place)) {
        throw new ApiError('Invalid place');
    }
    return $place;
}


/**
 * The next sequence number for a new place on one question. Only meaningful
 * for a first insert — see save_place() for why it is never updated.
 *
 * The count is taken without a lock, an accepted, harmless race at this
 * survey's scale: the worst case is two places sharing a number.
 */
function next_seq(PDO $pdo, int $rid, string $question, string $place): int
{
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM places
                            WHERE response_id = :rid AND question = :q AND place_key != :place');
    $stmt->execute([':rid' => $rid, ':q' => $question, ':place' => $place]);

    return min((int) $stmt->fetchColumn() + 1, MAX_PLACES_PER_QUESTION);
}


/**
 * Sanitise a whole number within [min, max], returning null for anything
 * else — including blanks, which must not be stored as zero.
 */
function clean_int($value, int $min, int $max): ?int
{
    if ($value === null || $value === '' || is_bool($value) || !is_numeric($value)) {
        return null;
    }

    // 3.5 is not a whole number of years, and is not silently rounded into one.
    if ((float) $value != (int) $value) {
        return null;
    }

    $n = (int) $value;
    return ($n >= $min && $n <= $max) ? $n : null;
}


/** 'yes' → 1, 'no' → 0, anything else → null. */
function clean_yes_no($value): ?int
{
    if ($value === 'yes') return 1;
    if ($value === 'no')  return 0;
    return null;
}


/**
 * Sanitise a single-choice answer against its whitelist, returning null for
 * anything that is not an exact match.
 */
function clean_choice($value, array $allowed): ?string
{
    if (!is_string($value)) {
        return null;
    }

    return in_array($value, $allowed, true) ? $value : null;
}


/**
 * Sanitise a checkbox-group answer for storage in a MySQL SET column: every
 * value checked against a whitelist, deduplicated, and joined with commas.
 * Returns null for "nothing selected".
 */
function clean_set($value, array $allowed): ?string
{
    if (!is_array($value)) {
        return null;
    }

    $clean = array_filter($value, fn($v) => is_string($v) && in_array($v, $allowed, true));
    $clean = array_unique($clean);

    return $clean ? implode(',', $clean) : null;
}


/**
 * Sanitise a latitude or longitude, returning null if it is unusable.
 */
function clean_coord($value, float $limit): ?float
{
    if (!is_numeric($value)) {
        return null;
    }

    $coord = (float) $value;

    if (!is_finite($coord) || abs($coord) > $limit) {
        return null;
    }

    return $coord;
}


/**
 * Sanitise a dot's position within its place: 0 up to 65535, matching the
 * SMALLINT UNSIGNED column — around 13 minutes of continuous spraying.
 */
function clean_seq($value): ?int
{
    return clean_int($value, 0, 65535);
}


/**
 * Convert a moment from the phone's clock (milliseconds since the Unix
 * epoch, from Date.now()) into a DATETIME(3) string.
 *
 * Writes can reach the server days after they were made, so the phone's
 * clock is the right one to trust — within reason. Anything before this
 * project existed, or more than a day ahead of the server, is a phone with
 * a badly wrong clock, and the server's own time is used instead.
 */
function clean_client_time($value): string
{
    $ms = is_numeric($value) ? (int) $value : null;

    $now = (int) round(microtime(true) * 1000);
    if ($ms === null || $ms < 1735689600000 || $ms > $now + 86400000) {
        $ms = $now;
    }

    $seconds = intdiv($ms, 1000);
    return date('Y-m-d H:i:s', $seconds) . sprintf('.%03d', $ms % 1000);
}
