#!/usr/bin/env bash
# usage: post.sh <bot> <title> <body> [link]
#        post.sh <bot> <title> - [link]      # body (markdown) read from stdin
# Prints the JSON response. Target: $STUDY_URL (see study-env.sh).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; . "$DIR/study-env.sh"
if [ $# -lt 3 ]; then
  echo "usage: $0 <bot> <title> <body|-> [link]   (use - to read the body from stdin)" >&2; exit 1
fi
BOT="$1"; TITLE="$2"; LINK="${4:-}"
if [ "$3" = "-" ]; then BODY="$(cat)"; else BODY="$3"; fi
JSON="$(jq -n --arg bot "$BOT" --arg title "$TITLE" --arg body "$BODY" --arg link "$LINK" \
  '{bot:$bot, title:$title, body:$body} + (if $link != "" then {link:$link} else {} end)')"
# study_curl retries only on connect failure / 502-504 (not on timeout after send) to avoid double-post.
study_curl -X POST "$STUDY_URL/api/messages" -H 'Content-Type: application/json' --data-binary "$JSON"
echo
