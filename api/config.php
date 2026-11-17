<?php
/* ─────────────────────────────────────────────────────────────────
   config.php  –  settings for the survey backend

   Everything here is safe to commit. The two secrets — the database
   password and the export token — live in secrets.php beside this file,
   which git ignores; copy secrets.example.php to create it. Nothing here
   is sent to the browser: PHP files are executed, never served as source.
   ───────────────────────────────────────────────────────────────── */

declare(strict_types=1);

/* ── Secrets ─────────────────────────────────────────────────────
   Defines DB_PASS and EXPORT_TOKEN. Without it the server cannot save
   anything, so it says so plainly, with a 503: the phones treat that as
   "try again later" and keep every answer until the file is in place. */
if (!is_file(__DIR__ . '/secrets.php')) {
    error_log('Ticks survey: api/secrets.php is missing — copy secrets.example.php and fill it in.');
    http_response_code(503);
    header('Content-Type: application/json; charset=utf-8');
    exit('{"ok":false,"error":"Server not configured"}');
}
require __DIR__ . '/secrets.php';

/* ── Database connection ─────────────────────────────────────────
   127.0.0.1 is used in preference to "localhost" because the latter makes
   PHP try a unix socket whose path differs between Homebrew MySQL, MAMP and
   XAMPP — the single most common cause of "connection refused". */
const DB_HOST = '127.0.0.1';
const DB_PORT = 3306;
const DB_NAME = 'ticks';

/* The dedicated user created at the bottom of schema.sql, rather than root.
   Its password is DB_PASS in secrets.php. */
const DB_USER = 'ticks';

/* ── Limits ──────────────────────────────────────────────────────
   The largest number of dots accepted in a single write. The client stores
   one write roughly every 500 ms of spraying, which is some tens of dots, so
   this is generous — it exists to bound what a malformed request can cause. */
const MAX_DOTS_PER_REQUEST = 5000;

/* The largest number of writes accepted in one batch. The client sends at
   most 40; a phone coming back into signal after days away sends its backlog
   as a series of batches, oldest first. */
const MAX_OPS_PER_BATCH = 100;

/* The two map questions, in page order. Every request naming a question is
   checked against this list. */
const QUESTIONS = ['ticks', 'no_ticks'];

/* The largest number of places (spray-then-submit rounds) accepted for one
   question, bounding what a single runaway session can write. */
const MAX_PLACES_PER_QUESTION = 200;

/* ── Page 1 ──────────────────────────────────────────────────────
   Must match the values in index.html exactly — anything else submitted is
   stored as NULL rather than as a new, unplanned category. */
const EDUCATIONS = ['informal', 'primary', 'secondary', 'post_secondary'];
const LIVESTOCK  = ['sheep', 'goats', 'cattle', 'camel', 'other'];

/* ── Map follow-up ───────────────────────────────────────────────
   "Please select one" — the answers each map offers. The first differs
   between the maps (lots of ticks / few or no ticks "as long as I can
   remember"); the other three are shared. */
const TRENDS = [
    'ticks'    => ['always_many', 'used_more', 'used_fewer', 'dont_know'],
    'no_ticks' => ['always_few',  'used_more', 'used_fewer', 'dont_know'],
];

/* ── Error reporting ─────────────────────────────────────────────
   Errors are logged but never printed. A PHP warning echoed into the response
   body would corrupt the JSON the client is parsing. Set display_errors to
   '1' temporarily when debugging locally. */
ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);
