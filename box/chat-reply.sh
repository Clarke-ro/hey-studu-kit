#!/usr/bin/env bash
# Post the chat bot's reply into the study app chat.
# usage: chat-reply.sh <message_id> -        # reply body (markdown) read from stdin
#        chat-reply.sh <message_id> "<text>"
# Prints "ok" on success (VERBOSE=1 also prints the push result to stderr). Needs the POST token in $HEY_STUDU_HOME/post-token (never printed). Target: $STUDY_URL (see study-env.sh).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; . "$DIR/study-env.sh"
if [ $# -lt 2 ] || ! [[ "$1" =~ ^[0-9]+$ ]]; then
  echo "usage: $0 <message_id> -   (reply markdown on stdin)" >&2; exit 1
fi
ID="$1"
if [ "$2" = "-" ]; then BODY="$(cat)"; else BODY="$2"; fi
if [ -z "${BODY//[[:space:]]/}" ]; then echo "error: empty reply" >&2; exit 1; fi
JSON="$(jq -n --argjson id "$ID" --arg text "$BODY" '{reply_to:$id, text:$text}')"
OUT="$(mktemp)"; trap 'rm -f "$OUT"' EXIT
CODE="$(study_curl_to "$OUT" -X POST "$STUDY_URL/api/chat/reply" \
  -H 'Content-Type: application/json' --data-binary "$JSON")" || { echo "error: app not reachable" >&2; exit 1; }
if [ "$CODE" = "201" ]; then [ -n "${VERBOSE:-}" ] && jq -c '{message_id:.message.id, push}' "$OUT" >&2; echo ok; else echo "error: HTTP $CODE $(jq -r '.error // empty' "$OUT" 2>/dev/null)" >&2; exit 1; fi
