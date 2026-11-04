#!/usr/bin/env bash
# Wait until the app answers /healthz with db.ok=true. The first Render build takes a few minutes; later,
# a free instance that slept needs ~30-60 s to wake. URL: STUDY_URL env > $HEY_STUDU_HOME/url.
# env: WAIT_TIMEOUT_S (default 900).
. "$(dirname "$0")/common.sh"
URL="${STUDY_URL:-$(tr -d '[:space:]' < "$HEY_STUDU_HOME/url" 2>/dev/null || true)}"; URL="${URL%/}"
[ -n "$URL" ] || die "no URL: set STUDY_URL or run render-create.sh first"
T="${WAIT_TIMEOUT_S:-900}"; start=$(date +%s); n=0
while :; do
  body="$(curl -s --max-time 70 "$URL/healthz" || true)"
  if [ "$(jq -r '.db.ok // empty' <<<"$body" 2>/dev/null)" = true ]; then say "healthy: $URL ($(( $(date +%s) - start )) s)"; exit 0; fi
  [ $(( $(date +%s) - start )) -ge "$T" ] && die "not healthy after ${T}s: $URL (check the Render deploy log)"
  n=$((n+1)); [ $((n % 6)) = 1 ] && say "waiting for $URL/healthz ..."
  sleep 10
done
