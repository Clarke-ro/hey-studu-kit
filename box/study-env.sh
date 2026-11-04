# shellcheck shell=bash
# Sourced by the box scripts. Where the study app lives, and how to call it with the bearer token.
# Everything per-install lives in one config dir (created by scripts/setup/*.sh, mode 700):
#   HEY_STUDU_HOME   env > ~/.hey-studu
#   STUDY_URL        env > $HEY_STUDU_HOME/url (one line, e.g. https://my-study.onrender.com)
#   token file       STUDY_TOKEN_FILE env > $HEY_STUDU_HOME/post-token   (never printed; passed to curl via a config fd)
#   content dir      STUDY_CONTENT_DIR env > $HEY_STUDU_HOME/content-dir (one line) > /workspace/study
# Render's free plan sleeps after 15 min idle; a cold start can take ~30-60 s, so timeouts are generous.
HEY_STUDU_HOME="${HEY_STUDU_HOME:-${HOME:-/root}/.hey-studu}"
if [ -z "${STUDY_URL:-}" ] && [ -s "$HEY_STUDU_HOME/url" ]; then STUDY_URL="$(tr -d '[:space:]' < "$HEY_STUDU_HOME/url")"; fi
[ -n "${STUDY_URL:-}" ] || { echo "error: no app URL: set STUDY_URL or write it to $HEY_STUDU_HOME/url" >&2; exit 1; }
STUDY_URL="${STUDY_URL%/}"
if [ -z "${STUDY_CONTENT_DIR:-}" ] && [ -s "$HEY_STUDU_HOME/content-dir" ]; then STUDY_CONTENT_DIR="$(head -n1 "$HEY_STUDU_HOME/content-dir")"; fi
STUDY_CONTENT_DIR="${STUDY_CONTENT_DIR:-/workspace/study}"
STUDY_TOKEN_FILE="${STUDY_TOKEN_FILE:-$HEY_STUDU_HOME/post-token}"
[ -r "$STUDY_TOKEN_FILE" ] || { echo "error: token file not readable: $STUDY_TOKEN_FILE (run scripts/setup/gen-secrets.sh)" >&2; exit 1; }
# study_curl <curl args...>: curl with the auth header (token stays out of argv and the environment)
study_curl() {
  curl -sS --connect-timeout 20 --max-time "${STUDY_MAX_TIME:-120}" \
    -K <(printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '[:space:]' < "$STUDY_TOKEN_FILE")") "$@"
}
