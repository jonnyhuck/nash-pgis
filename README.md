# Ticks in the Landscape — Mapping Survey

A mobile-first participatory mapping survey for pastoralists in Kenya.
Participants answer a short set of background questions, then use a
spraycan tool on Google Satellite imagery to mark two maps: where they find
**the most ticks**, and where they **do not find ticks**. Each area they mark
gets two follow-up questions: how ticks there have changed over time, and
how confident they are (0–10). They can mark any number of separate areas
on each map. Pressing "Spray again" saves one area and starts another.

The survey is built to run **with poor or no signal**:

- **Nothing is lost when the connection drops.** Every answer is stored on
  the phone first, in a queue in IndexedDB. It is uploaded in order whenever
  there is signal, and removed from the phone only once the server confirms
  it. The queue survives reloads, closed tabs, flat batteries and days
  offline. No page ever waits on the network.
- **The whole survey works offline** once a phone has opened it online one
  time. A service worker stores every page and script on the device.
- **The map works offline** for any area that has been pre-downloaded on the
  setup page, or simply viewed online before.
- **Background upload.** On Chrome for Android, queued answers upload when
  signal returns, even if the browser has been closed.
- **A status line on every page** shows whether answers are uploaded or
  waiting. A coloured dot shows the state at a glance.

Everything is saved to a **MySQL database via PHP**. There is no
third-party data service and no client-side framework.

---

## Before going into the field

1. **Serve the site over HTTPS.** Service workers, and so all of the
   offline behaviour, only work on `https://` (or `localhost`). Over plain
   HTTP the survey still runs, but it needs signal throughout.
2. **On every phone, with a good connection:**
   - Open the site, then go to **Field team: offline setup** (the link at
     the foot of the first page), or open `setup.html` directly.
   - Install the survey to the home screen (Chrome menu → *Add to Home
     screen* / *Install app*). It then opens full screen like an app, and
     Chrome is much more willing to protect its stored data from being
     cleared.
   - Check that every line under **1. This device** shows a tick. Tap
     **Protect stored data** if needed.
   - Under **2. Download the map**, which opens on the study area, choose
     the most detailed zoom level and press **Download**. To cover areas
     outside the boundary, move the map and download again. The page shows
     the tile count and a rough size first. Level 16 is
     usually enough to recognise individual features; each level beyond that
     roughly quadruples the size. Running it again only fetches tiles that
     are missing.

## During and after fieldwork

- The status line tells the team whether a phone still holds answers that
  have not uploaded. **Do not clear the browser's data** (or uninstall the
  app) on a phone that shows answers waiting.
- **Start Again** on the thank-you page is safe even while answers are
  waiting. Each queued answer carries its own participant's session ID.
- If a phone will not see signal before it has to be reset or handed back,
  use **Save backup file** on the setup page. **Load backup file** on any
  other phone queues those answers for upload from there. Loading the same
  file twice is harmless, because every write is idempotent.
- Answers the server rejects outright (which should never happen) are kept
  on the phone, not deleted. They are listed on the setup page, can be
  included in a backup, and can be retried with **Retry rejected answers**.

---

## Server requirements

- **PHP 7.4 or later** with the `pdo_mysql` extension
- **MySQL 5.7+ / MariaDB 10.2+**
- Any web server that runs PHP, with **HTTPS** for the offline features

## Setup

1. **Create the database and tables:**

   ```bash
   mysql -u root -p < api/schema.sql
   ```

   Then uncomment the `CREATE USER` / `GRANT` block at the bottom of
   `api/schema.sql`, set a real password, and run it. The website should not
   connect as root.

2. **Create `api/secrets.php`** from the template, and set `DB_PASS` (the
   password from step 1) and `EXPORT_TOKEN` (a long random string, e.g.
   from `openssl rand -hex 24`):

   ```bash
   cp api/secrets.example.php api/secrets.php
   ```

   `secrets.php` is in `.gitignore` and must never be committed. Everything
   else, including `api/config.php`, is safe to commit. Until `secrets.php`
   exists, the server answers every upload with "Server not configured", and
   the phones keep the answers until it is fixed.

3. **Serve the folder.** For local testing:

   ```bash
   php -S localhost:8000
   ```

   Then open <http://localhost:8000>. `localhost` counts as secure, so the
   offline features work there too. Opening `index.html` directly from the
   filesystem will **not** work.

## Deploying to the server

The repo is cloned to a staging directory on the server, and `deploy.sh`
copies it into the live web root:

| | |
|---|---|
| Staging (git clone) | `/var/www/staging/nash-pgis` |
| Live web root | `/var/www/html/nash.huckg.is` |
| Backups of the live site | `/var/backups/nash.huckg.is` (newest 10 kept) |

```bash
cd /var/www/staging/nash-pgis
git pull
sudo ./deploy.sh --dry-run   # see what would change
sudo ./deploy.sh             # deploy (asks before changing anything)
```

The script:

1. Checks the PHP syntax, and warns about uncommitted changes in staging.
2. Warns if site files changed but `SHELL_VERSION` was not bumped.
3. Shows the changes and backs up the live site.
4. Copies everything except `.git`, the README, this script, the schema and
   the secrets template. Files deleted from the repo are deleted live too.
5. **Never touches the live `api/secrets.php`.** On the first deploy it
   creates one from the template; edit it straight away. A secrets file in
   staging is never deployed.
6. Sets everything to `root:www-data`, directories `750` and files `640`.
   Apache can read the site but cannot change it, and other users cannot
   see it.

It prints a rollback command at the end. The paths can be overridden with
`NASH_SRC`, `NASH_DEST` and `NASH_BACKUPS`. Run the schema from staging
(`sudo mysql < /var/www/staging/nash-pgis/api/schema.sql`), since it is not
deployed.

## Updating the survey

The service worker serves every page from the phone's own copy, so a change
on the server only reaches phones once **`SHELL_VERSION` in `sw.js` is
bumped** (e.g. `ticks-shell-v1` → `ticks-shell-v2`). Each phone picks up the
new version the next time it opens the survey with signal. Downloaded map
tiles are stored separately and survive updates.

## Study area

Every map draws the boundary in `data/MUKOGODO EAST SHAPEFILE.geojson` as a
yellow outline and opens zoomed to it. The map can be panned freely beyond
it. The file is stored on the phone along with the pages, so the outline
and starting view work offline. To use a different boundary, put a GeoJSON
file (WGS84 / EPSG:4326) in `data/`, point `BOUNDARY_URL` in `config.js` at
it (write any spaces in the name as `%20`), and bump `SHELL_VERSION`.

## Getting the data out

`api/export.php` needs the token from `api/secrets.php`.

| URL | Output |
|---|---|
| `api/export.php?token=…` | CSV, one row per participant (page 1 answers, timings, area counts per map) |
| `api/export.php?what=places&token=…` | CSV, one row per area marked (map, trend, confidence, dot count) |
| `api/export.php?what=dots&token=…` | CSV, one row per spray dot |
| `api/export.php?what=dots&format=geojson&token=…` | GeoJSON points, with each dot's trend and confidence attached; opens directly in QGIS |
| `…&question=ticks` / `…&question=no_ticks` | restrict the places or dots export to one map |

Join dots to places on `place_key`, and either to responses on
`response_id`.

**Codes used in the data:**

| Column | Values |
|---|---|
| `education` | `informal`, `primary`, `secondary`, `post_secondary` |
| `lives_here`, `keeps_livestock` | `1` yes, `0` no |
| `lives_years`, `livestock_years` | whole years (NULL unless the matching question was "yes") |
| `livestock` | any of `sheep`, `goats`, `cattle`, `camel`, `other` (comma-separated) |
| `question` | `ticks` (most ticks), `no_ticks` (no ticks) |
| `trend`, map `ticks` | `always_many` (lots of ticks as long as I can remember), `used_more`, `used_fewer`, `dont_know` |
| `trend`, map `no_ticks` | `always_few` (few or no ticks as long as I can remember), `used_more`, `used_fewer`, `dont_know` |
| `confidence` | 0–10 (0 is a real answer, not "missing") |

## File map

| File | Role |
|---|---|
| `index.html` | Information sheet, background questions, consent |
| `map1.html`, `map2.html` | The two map questions (most ticks / no ticks) |
| `thankyou.html` | Confirmation, upload status, and "Start Again" for shared phones |
| `setup.html` | Field team page: readiness checks, map download, upload status, backup |
| `config.js` | Boundary file, maximum zoom and base map, shared by the pages and the service worker |
| `boundary.js` | Draws the study-area outline and zooms every map to it |
| `data/` | The study-area boundary (GeoJSON) |
| `outbox.js` | The durable upload queue (IndexedDB), shared by the pages and the service worker |
| `sw.js` | Service worker: offline app shell, tile cache, Background Sync |
| `api.js` | Client side of the API: queueing writes, the upload loop, the status line |
| `mappage.js` | All shared map-page behaviour; the pages supply a `PAGE_CONFIG` and their follow-up sheet's HTML |
| `spray.js` | The spraycan itself |
| `style.css` | Whole-site stylesheet |
| `manifest.json`, `icons/` | Lets the survey be installed to a phone's home screen |
| `vendor/leaflet/` | Leaflet 1.9.4, served locally so the map works offline |
| `api/config.php` | Server settings (no secrets; safe to commit) |
| `api/secrets.php` | Database password and export token — **create from `secrets.example.php`; never commit** |
| `api/secrets.example.php` | Template for `secrets.php`, with placeholders |
| `api/db.php` | PDO connection and request helpers |
| `api/survey.php` | The single write endpoint (accepts batches of queued writes) |
| `api/export.php` | CSV / GeoJSON export |
| `api/schema.sql` | Database structure (not deployed) |
| `deploy.sh` | Copies staging into the live web root safely (see "Deploying to the server") |

## Notes

- **Base map.** Google Satellite tiles are fetched directly from Google's tile
  servers. This is outside their Terms of Service for a public deployment,
  and pre-downloading tiles for offline use is a further step beyond it. It
  is reasonable for a small academic study, but worth knowing about. The
  tiles are fetched as CORS requests, which Google allows. This matters:
  Chrome counts "opaque" cross-origin responses as several megabytes each
  against its storage quota, which would fill the phone after a few hundred
  tiles.
- **Times come from the phone's clock** (`started_at`, `submitted_at`,
  `dots.sprayed_at`), because answers may reach the server days later.
  `created_at` on `responses` is when the server first heard from that
  phone. A phone clock more than a day ahead of the server, or set before
  2025, is ignored in favour of the server's time. Times are stored in the
  server's local timezone.
- **Partial responses are kept.** `submitted_at IS NULL` marks a participant
  who did not finish. Filter on it before analysis.
- **Writes are idempotent.** A phone that loses signal mid-upload cannot know
  whether its request arrived, so it sends it again. Every action on the
  server is written so that applying it twice changes nothing. Dots are keyed
  on (`place_key`, `dot_seq`), places on `place_key`, and `started_at` /
  `submitted_at` are only set once.
- **A "place" is one spray-then-submit round.** Its id is minted in the
  browser when spraying starts, tags every dot in that round, and becomes
  the place's primary key in `places` once its follow-up sheet is saved. A
  round abandoned with PREV is deleted. Dots from a round abandoned by
  closing the browser are kept, with no matching `places` row.
- **The follow-up sheet is read generically.** Each answer group inside
  `#form-modal` carries `data-field="…"`, plus `data-required="true"` if it
  is mandatory and `data-type="int"` if its value is a number. `mappage.js`
  reads, validates and resets the sheet from those attributes alone.
