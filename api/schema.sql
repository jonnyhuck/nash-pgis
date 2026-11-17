-- ─────────────────────────────────────────────────────────────────
--  schema.sql  –  database structure for the ticks mapping survey
--
--  Load it once, from the website directory, with:
--      mysql -u root -p < api/schema.sql
-- ─────────────────────────────────────────────────────────────────

-- Create the database if this is a fresh machine; utf8mb4 so that any
-- character a participant's device sends is stored intact.
CREATE DATABASE IF NOT EXISTS ticks
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE ticks;


-- ── responses ────────────────────────────────────────────────────
--  One row per participant: the answers from page 1, plus the timestamps
--  that tell a complete response from an abandoned one.
CREATE TABLE IF NOT EXISTS responses (

    -- Internal key. The place and dot tables join to this rather than to the
    -- session string, so the wide random ID is stored exactly once.
    id                INT UNSIGNED  NOT NULL AUTO_INCREMENT,

    -- The ID the browser generated and keeps in localStorage. Every write
    -- carries it, and the UNIQUE constraint below is what makes a repeat
    -- send update the existing row instead of creating a second one.
    session_id        CHAR(36)      NOT NULL,

    -- Page 1. All nullable: a participant may consent and start mapping
    -- without every answer reaching the server, and we would rather keep the
    -- maps than reject the whole response over one missing field.
    age               TINYINT UNSIGNED  DEFAULT NULL,   -- years, self-reported (often an estimate)
    education         VARCHAR(16)   DEFAULT NULL,       -- informal / primary / secondary / post_secondary

    -- "Do you currently live in the landscape?" and, if so, for how long.
    lives_here        TINYINT(1)        DEFAULT NULL,   -- 1 yes, 0 no
    lives_years       TINYINT UNSIGNED  DEFAULT NULL,   -- NULL unless lives_here = 1

    -- "Do you keep livestock in this landscape?", for how long, and which.
    keeps_livestock   TINYINT(1)        DEFAULT NULL,
    livestock_years   TINYINT UNSIGNED  DEFAULT NULL,   -- NULL unless keeps_livestock = 1

    /* A checkbox question, so several may apply. SET stores the ticked
       members as one compact bitmask that reads back as a comma-separated
       string — queryable with FIND_IN_SET('camel', livestock) and exported
       with no join. Must match LIVESTOCK in config.php exactly. */
    livestock SET('sheep', 'goats', 'cattle', 'camel', 'other') DEFAULT NULL,

    -- Consent is recorded explicitly rather than inferred from the row's
    -- existence, so the audit trail for the ethics application is unambiguous.
    consent           TINYINT(1)    NOT NULL DEFAULT 0,

    -- When page 1 was completed and when SUBMIT was pressed, both from the
    -- phone's own clock: answers may sit on a phone for days before reaching
    -- the server, so the server's clock would say when the phone found
    -- signal, not when the participant took part. A NULL submitted_at marks
    -- a participant who dropped out part-way.
    started_at        DATETIME(3)   DEFAULT NULL,
    submitted_at      DATETIME(3)   DEFAULT NULL,

    -- When the server first and last heard about this response. The gap
    -- between started_at and created_at is how long it waited for signal.
    created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                    ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_session (session_id)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── places ───────────────────────────────────────────────────────
--  One row per area marked on either map: one spray-then-submit round. A
--  participant may mark any number per map by pressing "Spray again".
--  Both maps ask the same two follow-up questions, so they share one table
--  with a `question` column.
CREATE TABLE IF NOT EXISTS places (

    -- Generated in the browser the instant a new round of spraying begins,
    -- and used as the primary key directly. Dots reach the `dots` table
    -- while the participant paints — long before this row is written — and
    -- need a stable id to be tagged with from their first moment.
    place_key      CHAR(36)      NOT NULL,

    response_id    INT UNSIGNED  NOT NULL,

    -- 'ticks' (most ticks) or 'no_ticks' (no ticks).
    question       VARCHAR(16)   NOT NULL,

    -- Which area this was for this participant on this map: 1, 2, 3, …
    -- Set once, on first save, and never updated, so a re-sent save cannot
    -- renumber it.
    seq            SMALLINT UNSIGNED  NOT NULL,

    /* "Please select one" — how ticks here have changed. Values, from the
       whitelists in config.php:
         ticks:     always_many  "There were lots of ticks here as long as I can remember"
         no_ticks:  always_few   "There were few or no ticks here as long as I can remember"
         both:      used_more    "There used to be more ticks here"
                    used_fewer   "There used to be fewer ticks here"
                    dont_know    "I don't know"                                         */
    trend          VARCHAR(16)   DEFAULT NULL,

    -- "How confident are you on this answer?", 0-10. 0 is a real answer.
    confidence     TINYINT UNSIGNED  DEFAULT NULL,

    created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (place_key),
    KEY idx_response_question (response_id, question),

    CONSTRAINT fk_place_response FOREIGN KEY (response_id)
        REFERENCES responses (id) ON DELETE CASCADE

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── dots ─────────────────────────────────────────────────────────
--  The spray paint itself: one row per dot. This table grows fastest —
--  the spraycan emits roughly 83 dots per second while held down, which is
--  why every column here is kept as small as it can honestly be.
CREATE TABLE IF NOT EXISTS dots (

    id           BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,

    -- Owning participant, and which map the dot was painted on. `question`
    -- is needed here because a dot is written before its place row exists,
    -- so it cannot always be traced back through a join.
    response_id  INT UNSIGNED  NOT NULL,
    question     VARCHAR(16)   NOT NULL,

    -- Which place (spray round) this dot belongs to. Deliberately no foreign
    -- key to `places`: the dots arrive first, and enforcing one would reject
    -- every dot until the round's follow-up sheet had been saved.
    place_key    CHAR(36)      NOT NULL,

    -- This dot's position within its place: 0, 1, 2, … Together with
    -- place_key this is what Undo uses to name one dot, and what makes a
    -- re-sent batch harmless (see the UNIQUE key below).
    dot_seq      SMALLINT UNSIGNED  NOT NULL,

    -- Position in WGS84. DECIMAL(9,6) is exact to about 0.1 m.
    lat          DECIMAL(9,6)  NOT NULL,
    lng          DECIMAL(9,6)  NOT NULL,

    -- Map zoom at the moment of painting: the honest record of how precisely
    -- the participant was working.
    zoom         TINYINT UNSIGNED  DEFAULT NULL,

    -- When this dot was sprayed, to the millisecond, from the phone's clock.
    sprayed_at   DATETIME(3)   NOT NULL,

    PRIMARY KEY (id),

    -- Makes re-sending a batch harmless: a retry after a flaky connection
    -- updates the existing dots rather than duplicating the whole stroke.
    UNIQUE KEY uq_place_dot (place_key, dot_seq),

    KEY idx_response_question (response_id, question),

    CONSTRAINT fk_dot_response FOREIGN KEY (response_id)
        REFERENCES responses (id) ON DELETE CASCADE

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── survey user ──────────────────────────────────────────────────
--  Optional, but strongly preferred over letting the website connect as root.
--  Choose a password, put it here and in api/config.php, then uncomment.
--
-- CREATE USER IF NOT EXISTS 'ticks'@'localhost' IDENTIFIED BY 'choose-a-password';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ticks.* TO 'ticks'@'localhost';
-- FLUSH PRIVILEGES;
