#!/usr/bin/env bash
# Attach a review to a lesson submission (shown under it on the lesson page) and always push the student
# (unless NO_PUSH=1). Review notifications are never suppressed when the lesson is open.
# Shown as the kit's feedback bot unless you pass BY=Name.
# usage: submission-feedback.sh <submission_id> -        # review (markdown) read from stdin
#        submission-feedback.sh <submission_id> "<text>"
# Env: BY=Name overrides the reviewer name. NO_PUSH=1 saves the review without any push. VERBOSE=1 prints the push result to stderr.
#      PASSED=1|0 marks a Module test pass/fail (also auto-detected if the review starts with **Passed** / **Failed**).
#      SCORE=<n> optional Practical score 0–100 (overall = 40% objective + 60% practical).
# Prints "ok" on success. Needs the POST token in $HEY_STUDU_HOME/post-token (never printed). Target: $STUDY_URL (see study-env.sh).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; . "$DIR/study-env.sh"
if [ $# -lt 2 ] || ! [[ "$1" =~ ^[0-9]{8}-[0-9]{6}-[a-f0-9]{4}$ ]]; then
  echo "usage: $0 <submission_id> -   (review markdown on stdin; id looks like 20261104-153012-a1b2)" >&2; exit 1
fi
ID="$1"
if [ "$2" = "-" ]; then BODY="$(cat)"; else BODY="$2"; fi
if [ -z "${BODY//[[:space:]]/}" ]; then echo "error: empty review" >&2; exit 1; fi
if [ -n "${NO_PUSH:-}" ]; then PUSH=false; else PUSH=true; fi
EXTRA='{}'
if [ "${PASSED:-}" = "1" ] || [ "${PASSED:-}" = "true" ]; then EXTRA=$(jq -n --argjson p true '{passed:$p}'); fi
if [ "${PASSED:-}" = "0" ] || [ "${PASSED:-}" = "false" ]; then EXTRA=$(jq -n --argjson p false '{passed:$p}'); fi
if [ -n "${SCORE:-}" ]; then EXTRA=$(jq -n --argjson e "$EXTRA" --argjson s "$SCORE" '$e + {score:$s}'); fi
JSON="$(jq -n --arg text "$BODY" --argjson push "$PUSH" --arg by "${BY:-}" --argjson extra "$EXTRA" '{text:$text, push:$push} + (if $by != "" then {by:$by} else {} end) + $extra')"
OUT="$(mktemp)"; trap 'rm -f "$OUT"' EXIT
CODE="$(study_curl_to "$OUT" -X POST "$STUDY_URL/api/submissions/$ID/feedback" \
  -H 'Content-Type: application/json' --data-binary "$JSON")" || { echo "error: app not reachable" >&2; exit 1; }
if [ "$CODE" = "201" ]; then [ -n "${VERBOSE:-}" ] && jq -c '{submission_id:.submission.id, lesson:.submission.lesson_id, push, test}' "$OUT" >&2; echo ok; else echo "error: HTTP $CODE $(jq -r '.error // empty' "$OUT" 2>/dev/null)" >&2; exit 1; fi
