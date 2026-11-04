#!/usr/bin/env bash
# Download a chat/submission attachment (files live in the app database).
# usage: fetch-upload.sh <api_path|url> [out_file]     e.g. fetch-upload.sh /uploads/u_ab12/photo.png /tmp/photo.png
# The webhook payload gives each attachment as {name,type,size,url,api_path}. Prints the saved path.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; . "$DIR/study-env.sh"
P="${1:?usage: fetch-upload.sh <api_path|url> [out_file]}"
case "$P" in http*://*) P="/${P#*://*/}";; esac; [[ "$P" == /uploads/* ]] || { echo "error: not an /uploads/ path" >&2; exit 1; }
OUTF="${2:-${TMPDIR:-/tmp}/study-upload-$(basename "$P")}"
study_curl --fail --retry 3 --retry-delay 5 --retry-connrefused -o "$OUTF" "$STUDY_URL$P"
echo "$OUTF"
