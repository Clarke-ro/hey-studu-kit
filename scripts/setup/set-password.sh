#!/usr/bin/env bash
# Store the login password as a scrypt hash in the app database (and sign out every device).
# env: DATABASE_URL, STUDY_APP_PASSWORD. Never prints either. Safe to re-run (it just replaces the hash).
. "$(dirname "$0")/common.sh"
need_env DATABASE_URL STUDY_APP_PASSWORD
[ "${#STUDY_APP_PASSWORD}" -ge 8 ] || die "STUDY_APP_PASSWORD must be at least 8 characters"
need_deps
# Neon sometimes is only reachable over 443 from sandboxes: PG_DRIVER=neon-ws uses its WebSocket driver.
(cd "$KIT_ROOT" && node auth.js set)
