<?php
/* ─────────────────────────────────────────────────────────────────
   export.php  –  pull the collected data back out again

   Usage (in a browser, or with curl):
     api/export.php?token=…                               → CSV, one row per participant
     api/export.php?what=places&token=…                   → CSV, one row per area marked
     api/export.php?what=dots&token=…                     → CSV, one row per dot
     api/export.php?what=dots&format=geojson&token=…      → GeoJSON points, with each
                                                            dot's place answers attached
     …&question=ticks  or  …&question=no_ticks            → just one map (places / dots)

   A "place" is one spray-then-submit round: an area a participant marked
   and then answered the follow-up questions about. Join places to dots on
   place_key, and either to responses on response_id.

   GeoJSON drops straight into QGIS; the CSVs open in R, Python or Excel.
   ───────────────────────────────────────────────────────────────── */

declare(strict_types=1);

require_once __DIR__ . '/db.php';


/* ── Access guard ────────────────────────────────────────────────
   The data is anonymous but not public. hash_equals compares in constant
   time, so the token cannot be recovered by timing repeated guesses. */
$token = is_string($_GET['token'] ?? null) ? $_GET['token'] : '';

if (!hash_equals(EXPORT_TOKEN, $token)) {
    // 404 rather than 403: an endpoint that admits it exists invites guessing.
    http_response_code(404);
    exit('Not found');
}

$what     = is_string($_GET['what']     ?? null) ? $_GET['what']     : 'responses';
$format   = is_string($_GET['format']   ?? null) ? $_GET['format']   : 'csv';
$question = is_string($_GET['question'] ?? null) ? $_GET['question'] : '';

if ($question !== '' && !valid_question($question)) {
    http_response_code(400);
    exit('Unknown question');
}

$pdo = db();


/* ── Dispatch ──────────────────────────────────────────────────── */
if ($what === 'responses') {
    export_responses($pdo);

} elseif ($what === 'places') {
    export_places($pdo, $question);

} elseif ($what === 'dots' && $format === 'geojson') {
    export_dots_geojson($pdo, $question);

} elseif ($what === 'dots') {
    export_dots_csv($pdo, $question);

} else {
    http_response_code(400);
    exit('Unknown export');
}


/* ════════════════════════════════════════════════════════════════
   EXPORTS
   ════════════════════════════════════════════════════════════════ */

/**
 * One row per participant: page 1 answers, timings, and how many areas they
 * marked on each map.
 */
function export_responses(PDO $pdo): void
{
    /* Area counts come from a grouped sub-query rather than a join straight
       onto places, which would multiply each response row by its area count. */
    $sql = "SELECT r.id,
                   r.session_id,
                   r.age,
                   r.education,
                   r.lives_here,
                   r.lives_years,
                   r.keeps_livestock,
                   r.livestock_years,
                   r.livestock,
                   r.consent,
                   r.started_at,
                   r.submitted_at,
                   r.created_at AS first_received_at,
                   COALESCE(p.ticks, 0)    AS places_ticks,
                   COALESCE(p.no_ticks, 0) AS places_no_ticks
              FROM responses r
              LEFT JOIN (
                    SELECT response_id,
                           SUM(question = 'ticks')    AS ticks,
                           SUM(question = 'no_ticks') AS no_ticks
                      FROM places
                     GROUP BY response_id
                   ) p ON p.response_id = r.id
             ORDER BY r.id";

    stream_csv($pdo->query($sql), 'ticks_responses');
}


/**
 * One row per area marked, optionally restricted to one map.
 */
function export_places(PDO $pdo, string $question): void
{
    /* The value is bound twice under two names because with prepare
       emulation off a named placeholder may only appear once. The empty
       default makes the condition a no-op when no question was requested. */
    $sql = "SELECT p.place_key,
                   p.response_id,
                   r.session_id,
                   p.question,
                   p.seq,
                   p.trend,
                   p.confidence,
                   COALESCE(d.dot_count, 0) AS dot_count,
                   p.created_at
              FROM places p
              JOIN responses r ON r.id = p.response_id
              LEFT JOIN (
                    SELECT place_key, COUNT(*) AS dot_count FROM dots GROUP BY place_key
                   ) d ON d.place_key = p.place_key
             WHERE (:qEmpty = '' OR p.question = :q)
             ORDER BY p.response_id, p.question, p.seq";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([':qEmpty' => $question, ':q' => $question]);

    stream_csv($stmt, 'ticks_places' . ($question !== '' ? '_' . $question : ''));
}


/**
 * One row per dot, joined back to the participant it belongs to.
 *
 * Dots whose place has no row in `places` belong to a round the participant
 * painted but never saved (they closed the browser mid-round, say). They
 * are kept, not hidden, so that choice is made at analysis time.
 */
function export_dots_csv(PDO $pdo, string $question): void
{
    $sql = "SELECT d.id,
                   d.response_id,
                   r.session_id,
                   d.question,
                   d.place_key,
                   d.dot_seq,
                   d.lat,
                   d.lng,
                   d.zoom,
                   d.sprayed_at
              FROM dots d
              JOIN responses r ON r.id = d.response_id
             WHERE (:qEmpty = '' OR d.question = :q)
             ORDER BY d.response_id, d.place_key, d.dot_seq";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([':qEmpty' => $question, ':q' => $question]);

    stream_csv($stmt, 'ticks_dots' . ($question !== '' ? '_' . $question : ''));
}


/**
 * The same dots as a GeoJSON FeatureCollection, ready to open in QGIS, with
 * the trend and confidence of each dot's place attached so the layer can be
 * styled by either straight away.
 */
function export_dots_geojson(PDO $pdo, string $question): void
{
    $sql = "SELECT d.id, d.response_id, d.question, d.place_key, d.dot_seq,
                   d.lat, d.lng, d.zoom, d.sprayed_at,
                   p.trend, p.confidence
              FROM dots d
              LEFT JOIN places p ON p.place_key = d.place_key
             WHERE (:qEmpty = '' OR d.question = :q)
             ORDER BY d.response_id, d.place_key, d.dot_seq";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([':qEmpty' => $question, ':q' => $question]);

    header('Content-Type: application/geo+json; charset=utf-8');
    header('Content-Disposition: attachment; filename="ticks_dots' .
           ($question !== '' ? '_' . $question : '') . '.geojson"');

    /* Written feature by feature rather than assembled in memory first: the
       dots table grows by thousands of rows per participant. */
    echo '{"type":"FeatureCollection","features":[';

    $first = true;
    foreach ($stmt as $row) {
        echo ($first ? '' : ','), json_encode([
            'type' => 'Feature',
            'geometry' => [
                'type' => 'Point',
                // GeoJSON is longitude-first — the opposite order to Leaflet.
                'coordinates' => [(float) $row['lng'], (float) $row['lat']],
            ],
            'properties' => [
                'id'          => (int) $row['id'],
                'response_id' => (int) $row['response_id'],
                'question'    => $row['question'],
                'place_key'   => $row['place_key'],
                'dot_seq'     => (int) $row['dot_seq'],
                'zoom'        => $row['zoom'] === null ? null : (int) $row['zoom'],
                'sprayed_at'  => $row['sprayed_at'],
                'trend'       => $row['trend'],
                'confidence'  => $row['confidence'] === null ? null : (int) $row['confidence'],
            ],
        ]);
        $first = false;
    }

    echo ']}';
    exit;
}


/**
 * Write a PDO result set out as a CSV download.
 */
function stream_csv(PDOStatement $stmt, string $filename): void
{
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . $filename . '.csv"');

    $out = fopen('php://output', 'w');

    /* A UTF-8 byte-order mark, so Excel on Windows reads the file as UTF-8
       rather than the local 8-bit encoding. Other tools skip it silently. */
    fwrite($out, "\xEF\xBB\xBF");

    $headerDone = false;

    foreach ($stmt as $row) {
        // Column names come from the first row, so the queries above stay the
        // single place where the export's shape is defined.
        if (!$headerDone) {
            fputcsv($out, array_keys($row));
            $headerDone = true;
        }

        fputcsv($out, $row);
    }

    fclose($out);
    exit;
}
