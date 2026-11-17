<?php
/* ─────────────────────────────────────────────────────────────────
   secrets.example.php  –  template for secrets.php

   Copy this file to secrets.php in the same folder and fill in real
   values. secrets.php is listed in .gitignore and must never be
   committed; this template, with its placeholders, is what goes in git.
   ───────────────────────────────────────────────────────────────── */

declare(strict_types=1);

/* The password of the 'ticks' MySQL user (see the bottom of schema.sql). */
const DB_PASS = 'choose-a-password';

/* api/export.php refuses to run unless this token is supplied in the URL.
   Use a long random string, e.g. the output of: openssl rand -hex 24 */
const EXPORT_TOKEN = 'change-me-too';
