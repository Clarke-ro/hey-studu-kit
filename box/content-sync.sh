#!/usr/bin/env bash
# Push changed study files from this box to the app (PUT /api/content/<path>, token auth).
# Files: curriculum.json roadmap.md opportunities.md LESSONS.md lessons/<id>.md under $STUDY_CONTENT_DIR.
# usage: content-sync.sh            one pass: push files whose sha256 differs from what was last pushed
#        content-sync.sh --full     compare against the server's list (GET /api/content) instead of local state
#        content-sync.sh --loop 60  run a pass every 60 s forever (for pm2)
#        content-sync.sh --prune    also delete server copies of files that no longer exist here
# Safe to run any time and concurrently (flock; a second copy just exits). Quiet unless it pushes something.
# Every hour (and on the first run) a pass reconciles against the server, so a reset DB gets refilled.
# Read-only on the files: it never writes to $STUDY_CONTENT_DIR.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; . "$DIR/study-env.sh"
STATE_DIR="${CONTENT_SYNC_STATE_DIR:-$HEY_STUDU_HOME/content-sync}"; mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
STATE="$STATE_DIR/state.tsv"; LOCK="$STATE_DIR/lock"
FULL_EVERY_S="${CONTENT_SYNC_FULL_EVERY_S:-3600}"
FULL=0 PRUNE=0 LOOP=0
while [ $# -gt 0 ]; do case "$1" in
  --full) FULL=1;; --prune) PRUNE=1; FULL=1;; --loop) LOOP="${2:?--loop <seconds>}"; shift;;
  *) echo "usage: $0 [--full] [--prune] [--loop SECONDS]" >&2; exit 2;; esac; shift; done
log() { echo "$(date '+%Y-%m-%d %H:%M:%S %Z') content-sync: $*"; }

local_files() { # path relative to STUDY_CONTENT_DIR, whitelisted names only
  local f
  for f in curriculum.json roadmap.md opportunities.md LESSONS.md; do [ -f "$STUDY_CONTENT_DIR/$f" ] && echo "$f"; done
  for f in "$STUDY_CONTENT_DIR"/lessons/*.md; do [ -f "$f" ] || continue; f="lessons/${f##*/}"; [[ "$f" =~ ^lessons/[a-z0-9-]+\.md$ ]] && echo "$f"; done
  return 0
}

pass() {
  local full="$1" remote tmp out code p h rh n=0 fail=0
  declare -A R=() L=()
  if [ "$full" = 1 ]; then
    remote="$(study_curl --fail --retry 3 --retry-delay 5 --retry-connrefused "$STUDY_URL/api/content")" || { log "server list failed ($STUDY_URL)"; return 1; }
    while IFS=$'\t' read -r p rh; do [ -n "$p" ] && R["$p"]="$rh"; done < <(jq -r '.[] | [.path, .sha256] | @tsv' <<<"$remote")
  elif [ -f "$STATE" ]; then
    while IFS=$'\t' read -r p rh; do [ -n "$p" ] && R["$p"]="$rh"; done < "$STATE"
  fi
  out="$(mktemp)"
  while read -r p; do
    h="$(sha256sum "$STUDY_CONTENT_DIR/$p" | cut -d' ' -f1)"; L["$p"]="$h"
    [ "${R[$p]:-}" = "$h" ] && continue
    code="$(study_curl -o "$out" -w '%{http_code}' -X PUT "$STUDY_URL/api/content/$p" \
      -H 'Content-Type: text/plain; charset=utf-8' -H "X-Source-Mtime: $(date -u -r "$STUDY_CONTENT_DIR/$p" +%Y-%m-%dT%H:%M:%SZ)" \
      --data-binary @"$STUDY_CONTENT_DIR/$p")" || code=000
    if [ "$code" = 200 ]; then R["$p"]="$h"; n=$((n+1)); log "pushed $p ($(jq -r 'if .changed then "updated" else "unchanged" end' "$out"))"
    else fail=$((fail+1)); unset 'R[$p]'; log "FAILED $p: HTTP $code $(jq -r '.error // empty' "$out" 2>/dev/null)"; fi
  done < <(local_files)
  if [ "$PRUNE" = 1 ]; then
    for p in "${!R[@]}"; do [ -n "${L[$p]:-}" ] && continue
      if study_curl --fail -o /dev/null -X DELETE "$STUDY_URL/api/content/$p"; then log "pruned $p"; unset 'R[$p]'; else fail=$((fail+1)); fi
    done
  fi
  rm -f "$out"
  # state = what the server is known to hold
  tmp="$STATE.tmp"; : > "$tmp"; for p in "${!R[@]}"; do printf '%s\t%s\n' "$p" "${R[$p]}" >> "$tmp"; done; mv "$tmp" "$STATE"
  [ "$full" = 1 ] && date +%s > "$STATE_DIR/last_full"
  [ "$fail" = 0 ]
}

run_once() {
  exec 9>"$LOCK"; flock -n 9 || return 0   # another pass is running
  local full="$FULL" last; last="$(cat "$STATE_DIR/last_full" 2>/dev/null || echo 0)"
  [ $(( $(date +%s) - last )) -ge "$FULL_EVERY_S" ] && full=1
  pass "$full"; local rc=$?
  flock -u 9; exec 9>&-; return $rc
}

if [ "$LOOP" != 0 ]; then
  [ -d "$STUDY_CONTENT_DIR" ] || log "warning: $STUDY_CONTENT_DIR does not exist yet"
  log "loop every ${LOOP}s: $STUDY_CONTENT_DIR -> $STUDY_URL"
  while :; do run_once || true; sleep "$LOOP"; done
else
  run_once
fi
