<?php
/* ─────────────────────────────────────────────────────────────────
   db.php  –  database connection and shared request helpers (ticks survey)

   Required by survey.php (writes) and export.php (reads). Contains no
   endpoint of its own, so it is safe if it is ever requested directly.
   ───────────────────────────────────────────────────────────────── */

declare(strict_types=1);

require_once __DIR__ . '/config.php';


/**
 * Return the shared PDO connection, opening it on first use.
 *
 * The handle is held in a static so that a request touching several tables
 * still makes exactly one connection — a new connection per query is the
 * usual reason a PHP survey backend feels sluggish under load.
 */
function db(): PDO
{
    // Survives between calls within this request, but not between requests.
    static $pdo = null;

    // Already connected: hand back the same handle.
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    // charset=utf8mb4 must be in the DSN, not set afterwards, or the first
    // query of the connection is still interpreted in the server's default.
    $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
                   DB_HOST, DB_PORT, DB_NAME);

    try {
        $pdo = new PDO($dsn, DB_USER, DB_PASS, [
            // Turn database problems into exceptions. Without this, PDO fails
            // silently and the survey happily reports success while saving
            // nothing at all — the worst possible failure mode here.
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            // Plain associative arrays; nothing here needs objects.
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            // Use real server-side prepared statements rather than PDO's
            // client-side emulation, so bound values can never be interpreted
            // as SQL no matter what a participant types into a textarea.
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
    } catch (PDOException $e) {
        // The message can name the database user, so it goes to the log only.
        error_log('Ticks survey database connection failed: ' . $e->getMessage());
        fail('Database unavailable', 503);
    }

    return $pdo;
}


/**
 * Read and decode the JSON body of the current request.
 *
 * The client posts JSON rather than form fields because a batch of dots is a
 * nested array, which form encoding represents only clumsily.
 */
function read_json(): array
{
    // php://input is the unparsed body; it can only be read once per request.
    $raw = file_get_contents('php://input');

    // An empty body is a malformed request, not an empty object.
    if ($raw === false || $raw === '') {
        fail('Empty request body');
    }

    // Depth 8 is beyond anything this API sends — the deepest is a batch of
    // dot writes, at five levels — and caps the work a deliberately
    // deeply-nested payload can force the parser to do.
    $data = json_decode($raw, true, 8);

    // json_decode returns null both for invalid JSON and for the literal
    // "null", so the type is checked rather than trusting a null check.
    if (!is_array($data)) {
        fail('Malformed JSON');
    }

    return $data;
}


/**
 * Send a JSON response and stop.
 *
 * Every exit from the API goes through here or through fail(), so the client
 * can rely on always receiving a JSON object with an "ok" flag.
 */
function send_json(array $payload, int $status = 200): void
{
    // Only set the status and headers if nothing has been emitted yet;
    // otherwise PHP would emit a "headers already sent" warning.
    if (!headers_sent()) {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        // The survey data is never cacheable — a cached 200 from an earlier
        // save would make a later failure look like a success.
        header('Cache-Control: no-store');
    }

    echo json_encode($payload);
    exit;
}


/**
 * Send an error and stop. Never leaks internal detail to the browser.
 */
function fail(string $message, int $status = 400): void
{
    send_json(['ok' => false, 'error' => $message], $status);
}


/**
 * A write the server will never accept as sent: bad session, unknown
 * question, and so on. Thrown rather than fail()ed so that, inside a batch,
 * one bad write is reported on its own while the rest are still applied.
 * The client keeps rejected writes rather than deleting them.
 */
class ApiError extends RuntimeException {}


/**
 * Check that a session ID looks like one this survey issued.
 *
 * The ID reaches SQL only through bound parameters, so this is not the
 * defence against injection; it is what stops junk IDs from a crawler or a
 * stale bookmark quietly filling the responses table with empty rows.
 */
function valid_session(string $id): bool
{
    // A UUID is 36 characters; the fallback ID in api.js is shorter, so the
    // range is permissive but the alphabet is strict.
    return (bool) preg_match('/^[A-Za-z0-9-]{16,36}$/', $id);
}


/**
 * Check a question key against the whitelist in config.php.
 */
function valid_question(string $question): bool
{
    // Strict comparison, so no loose type juggling can let something else past.
    return in_array($question, QUESTIONS, true);
}


/**
 * Return the responses.id for a session, creating the row if it is new.
 *
 * Writes always arrive in order, so in practice the page-1 write creates the
 * row; but every action can bring it into existence, rather than assuming
 * it is already there, in case that write was rejected or arrives from a
 * backup file loaded on another phone.
 */
function response_id(PDO $pdo, string $sessionId): int
{
    /* One round trip for both cases. On a fresh session the INSERT runs; on a
       returning one the UNIQUE key on session_id fires and the ON DUPLICATE
       clause sets LAST_INSERT_ID() to the existing id — the standard MySQL
       idiom for "insert or fetch", and the reason no SELECT is needed.
       started_at is left for the page-1 write to fill in from the phone's
       clock; the server's clock only says when the phone found signal. */
    $sql = 'INSERT INTO responses (session_id)
            VALUES (:sid)
            ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)';

    $stmt = $pdo->prepare($sql);
    $stmt->execute([':sid' => $sessionId]);

    // Set by both branches above, so it is the row's id either way.
    return (int) $pdo->lastInsertId();
}
