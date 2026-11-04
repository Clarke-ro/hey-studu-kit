#!/usr/bin/env bash
# Put study content in the content folder and push it to the app once.
# usage: seed-content.sh                 copy examples/ into the folder if it has no curriculum.json yet
#        seed-content.sh <dir>           use <dir> as the content folder (real content; nothing is copied)
#        seed-content.sh --force         overwrite the folder's files with examples/
# The folder: STUDY_CONTENT_DIR env > <dir> arg > $HEY_STUDU_HOME/content-dir > /workspace/study.
# Remembers the folder in $HEY_STUDU_HOME/content-dir so content-sync and the bots agree on it.
. "$(dirname "$0")/common.sh"
FORCE=0 ARG=""
for a in "$@"; do case "$a" in --force) FORCE=1;; *) ARG="$a";; esac; done
DIRC="${STUDY_CONTENT_DIR:-${ARG:-$(head -n1 "$HEY_STUDU_HOME/content-dir" 2>/dev/null || true)}}"; DIRC="${DIRC:-/workspace/study}"
mkdir -p "$DIRC/lessons"; DIRC="$(cd "$DIRC" && pwd)"
printf '%s\n' "$DIRC" > "$HEY_STUDU_HOME/content-dir"
if [ -z "$ARG" ] && { [ "$FORCE" = 1 ] || [ ! -f "$DIRC/curriculum.json" ]; }; then
  cp -r "$KIT_ROOT/examples/." "$DIRC/"; rm -f "$DIRC/README.md"; say "copied EXAMPLE content into $DIRC"
else say "using existing content in $DIRC"; fi
STUDY_CONTENT_DIR="$DIRC" "$KIT_ROOT/box/content-sync.sh" --full
