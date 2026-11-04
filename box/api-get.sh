#!/usr/bin/env bash
# Read the study app API with the bearer token.
# usage: ./api-get.sh /api/progress | ./api-get.sh /api/context | ./api-get.sh /api/chat
#        ./api-get.sh '/api/submissions?status=sent'     # submissions waiting for a review (newest first)
#        ./api-get.sh /api/submissions/<id>
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; . "$DIR/study-env.sh"
P="${1:?usage: api-get.sh /api/<path>}"; [[ "$P" == /* ]] || P="/$P"
# GETs are safe to retry (covers a Render cold start returning 502/503)
study_curl --fail-with-body --retry 4 --retry-delay 5 --retry-connrefused "$STUDY_URL$P"
