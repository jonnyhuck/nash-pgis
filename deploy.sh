#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
#  deploy.sh  –  copy the staged repo into the live web root, safely
#
#  Usage (on the server, from anywhere):
#      sudo ./deploy.sh              show what will change, ask, then deploy
#      sudo ./deploy.sh --dry-run    show what would change, and stop
#      sudo ./deploy.sh --yes        deploy without asking (e.g. from cron)
#
#  What it does, in order:
#    1. Checks the staged copy: PHP syntax, uncommitted changes, and
#       whether SHELL_VERSION in sw.js was bumped (phones only pick up
#       changes when it is — see the README).
#    2. Shows exactly which files will be added, changed or deleted.
#    3. Backs up the live site (secrets included) to BACKUP_DIR.
#    4. Copies the site across with rsync, leaving out everything that
#       does not belong in a web root: .git, this script, the README, the
#       database schema and the secrets template. Files deleted from the
#       repo are deleted from the web root too.
#    5. Never touches the live api/secrets.php (and checks afterwards that
#       it is unchanged). If there is none yet, it creates one from the
#       template and tells you to fill it in.
#    6. Sets ownership and permissions: everything owned by root, readable
#       by Apache's group, writable by nobody else. The survey only ever
#       writes to MySQL, so Apache needs no write access to these files.
#
#  The paths below can be overridden from the environment, e.g.
#      sudo NASH_DEST=/var/www/html/test ./deploy.sh
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

SRC="${NASH_SRC:-/var/www/staging/nash-pgis}"
DEST="${NASH_DEST:-/var/www/html/nash.huckg.is}"
BACKUP_DIR="${NASH_BACKUPS:-/var/backups/nash.huckg.is}"

# Code is owned by root and readable by Apache's group: Apache can serve it
# but, if ever compromised, cannot rewrite it.
OWNER="${NASH_OWNER:-root}"
WEB_GROUP="${NASH_WEB_GROUP:-www-data}"

# How many backups to keep; older ones are deleted after each deploy.
KEEP_BACKUPS=1

# Paths relative to the repo root that are never copied to the web root,
# and are removed from it if an older deploy left them there.
EXCLUDES=(
    .git
    .gitignore
    deploy.sh
    README.md
    api/schema.sql
    api/secrets.example.php
)

# The live secrets. Never copied from staging, never deleted, never changed
# by a deploy (see step 4).
SECRETS_REL=api/secrets.php


# ── Helpers ──────────────────────────────────────────────────────

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mWARNING:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Ask a yes/no question; --yes answers yes to everything.
confirm() {
    [[ "$ASSUME_YES" == 1 ]] && return 0
    local reply
    read -r -p "$1 [y/N] " reply
    [[ "$reply" =~ ^[Yy]$ ]]
}

# The SHELL_VERSION string from an sw.js, or empty if there is none.
shell_version() {
    [[ -f "$1" ]] && sed -n "s/^const SHELL_VERSION = '\(.*\)';.*/\1/p" "$1" || true
}


# ── Arguments ────────────────────────────────────────────────────

DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
    case "$arg" in
        -n|--dry-run) DRY_RUN=1 ;;
        -y|--yes)     ASSUME_YES=1 ;;
        -h|--help)    sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)            die "Unknown option: $arg (try --help)" ;;
    esac
done


# ── 1. Pre-flight checks ─────────────────────────────────────────

[[ $EUID -eq 0 ]] || die "Run with sudo: setting ownership needs root."
command -v rsync >/dev/null || die "rsync is not installed (sudo apt install rsync)."
command -v php   >/dev/null || die "php is not installed (sudo apt install php)."
getent group "$WEB_GROUP" >/dev/null || die "Group '$WEB_GROUP' does not exist."

[[ -d "$SRC" ]]          || die "Staging directory not found: $SRC"
[[ -f "$SRC/index.html" && -f "$SRC/sw.js" && -d "$SRC/api" ]] \
    || die "$SRC does not look like the survey repo."
[[ "$SRC" != "$DEST" ]]  || die "Source and destination are the same."

# What is being deployed. safe.directory stops git refusing to read a repo
# owned by another user when this runs as root.
if [[ -d "$SRC/.git" ]]; then
    git_() { git -c safe.directory="$SRC" -C "$SRC" "$@"; }
    say "Deploying $(git_ log -1 --format='%h %s (%cr)' 2>/dev/null || echo 'an unknown commit')"
    if [[ -n "$(git_ status --porcelain 2>/dev/null)" ]]; then
        warn "The staging copy has uncommitted changes; they will be deployed too:"
        git_ status --short >&2
        confirm "Deploy anyway?" || die "Cancelled."
    fi
else
    warn "$SRC is not a git repository; deploying it as-is."
fi

# A PHP syntax error in the API would make every upload fail. The phones
# would keep the data, but nothing would arrive until it was fixed.
say "Checking PHP syntax"
for f in "$SRC"/api/*.php; do
    php -l "$f" >/dev/null || die "PHP syntax error in $f — not deploying."
done


# ── 2. Show what will change ─────────────────────────────────────

# An excluded path is neither sent nor deleted by --delete, in every rsync
# version. That is what keeps the live secrets.php in place: it is excluded
# like the rest, and --delete-excluded is deliberately not used.
#
# --checksum compares contents rather than modification times, which git
# resets on every pull: without it, an unchanged file would be listed as a
# change, and would set off the SHELL_VERSION warning below for nothing.
# The site is a few megabytes, so checksumming it is quick.
RSYNC_OPTS=(--recursive --links --times --checksum --delete --exclude=.DS_Store)
for e in "${EXCLUDES[@]}" "$SECRETS_REL"; do RSYNC_OPTS+=(--exclude="/$e"); done

mkdir -p "$DEST"

say "Changes to $DEST:"
# Lines starting "." are attribute-only updates (a newer timestamp on an
# unchanged file), which are not worth showing.
CHANGES="$(rsync "${RSYNC_OPTS[@]}" --dry-run --itemize-changes "$SRC"/ "$DEST"/ \
           | grep -v '^\.' || true)"
if [[ -z "$CHANGES" ]]; then
    echo "    (no file changes — permissions will still be checked)"
else
    sed 's/^/    /' <<<"$CHANGES"
fi
for e in "${EXCLUDES[@]}"; do
    [[ -e "$DEST/$e" ]] && echo "    *removing  $e (does not belong in the web root)"
done

# Phones run their own stored copy of the site, and only replace it when
# SHELL_VERSION changes. Changing pages or scripts without bumping it means
# phones in the field keep the old version indefinitely. Changes under api/
# run on the server, so they do not need a bump.
OLD_VERSION="$(shell_version "$DEST/sw.js")"
NEW_VERSION="$(shell_version "$SRC/sw.js")"
SHELL_CHANGES="$(grep -v -E ' api/' <<<"$CHANGES" | grep -E '^(>f|\*deleting)' || true)"
if [[ -n "$OLD_VERSION" && -n "$SHELL_CHANGES" && "$OLD_VERSION" == "$NEW_VERSION" ]]; then
    warn "Site files changed but SHELL_VERSION in sw.js is still '$NEW_VERSION'."
    warn "Phones that already have the survey will NOT receive these changes."
    warn "Bump SHELL_VERSION (e.g. to the next number) and commit it first."
    confirm "Deploy anyway?" || die "Cancelled."
elif [[ -n "$OLD_VERSION" && "$OLD_VERSION" != "$NEW_VERSION" ]]; then
    say "SHELL_VERSION: $OLD_VERSION → $NEW_VERSION (phones will update on their next visit with signal)"
fi

if [[ "$DRY_RUN" == 1 ]]; then
    say "Dry run: nothing changed."
    exit 0
fi

confirm "Deploy these changes to $DEST?" || die "Cancelled."


# ── 3. Back up the live site ─────────────────────────────────────

# Only if there is something there to back up. The backups contain the
# secrets, so the directory is readable by root alone.
if [[ -n "$(ls -A "$DEST" 2>/dev/null)" ]]; then
    install -d -m 700 -o root -g root "$BACKUP_DIR"
    BACKUP="$BACKUP_DIR/$(basename "$DEST")-$(date +%Y%m%d-%H%M%S).tar.gz"
    say "Backing up the live site to $BACKUP"
    tar -czf "$BACKUP" -C "$(dirname "$DEST")" "$(basename "$DEST")"
    chmod 600 "$BACKUP"

    # Keep the newest KEEP_BACKUPS; the names sort by date.
    { ls -1 "$BACKUP_DIR"/*.tar.gz 2>/dev/null || true; } | sort -r \
        | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f --
fi


# ── 4. Copy ──────────────────────────────────────────────────────

SECRETS="$DEST/$SECRETS_REL"

# Belt and braces: a copy of the live secrets is taken first, and if the
# copy below changes or removes them for any reason, they are put back and
# the deploy stops rather than leaving the site unable to save.
SECRETS_COPY=""
if [[ -f "$SECRETS" ]]; then
    SECRETS_COPY="$(mktemp)"
    chmod 600 "$SECRETS_COPY"
    cp -p "$SECRETS" "$SECRETS_COPY"
    trap 'rm -f "$SECRETS_COPY"' EXIT
fi

say "Copying files"
# --delay-updates puts every changed file in place at the end, together,
# so visitors mid-survey do not load a mix of old and new files.
rsync "${RSYNC_OPTS[@]}" --delay-updates "$SRC"/ "$DEST"/

if [[ -n "$SECRETS_COPY" ]] && ! cmp -s "$SECRETS_COPY" "$SECRETS"; then
    cp -p "$SECRETS_COPY" "$SECRETS"
    die "The copy altered $SECRETS — it has been restored. Please report this; nothing else was rolled back."
fi

# Files that should not be in the web root, left there by an older deploy
# or a manual install: excluded paths are not removed by --delete.
for e in "${EXCLUDES[@]}"; do
    if [[ -e "$DEST/$e" ]]; then
        rm -rf -- "${DEST:?}/$e"
        echo "    removed $e (does not belong in the web root)"
    fi
done
find "$DEST" -name .DS_Store -type f -delete


# ── 5. Secrets ───────────────────────────────────────────────────

if [[ ! -f "$SECRETS" ]]; then
    cp "$SRC/api/secrets.example.php" "$SECRETS"
    warn "Created $SECRETS from the template."
    warn "Edit it now and set DB_PASS and EXPORT_TOKEN — until then the"
    warn "server will refuse every upload (the phones keep the data meanwhile)."
elif grep -q -E "'(choose-a-password|change-me-too)'" "$SECRETS"; then
    warn "$SECRETS still contains placeholder values — edit it."
fi


# ── 6. Ownership and permissions ─────────────────────────────────

say "Setting ownership ($OWNER:$WEB_GROUP) and permissions"
chown -R "$OWNER:$WEB_GROUP" "$DEST"
# Directories 750, files 640: Apache (in WEB_GROUP) can read everything,
# nobody but root can change anything, and other users see nothing.
find "$DEST" -type d -exec chmod 750 {} +
find "$DEST" -type f -exec chmod 640 {} +

say "Done. Check it at the site's /setup.html, then complete one test survey."
if [[ -n "${BACKUP:-}" ]]; then
    # The live directory is removed first so that files added by this deploy
    # do not survive the rollback.
    echo "    To roll back:"
    echo "      sudo rm -rf '$DEST' && sudo tar -xzf '$BACKUP' -C '$(dirname "$DEST")'"
fi
