# shellcheck shell=bash
# Sourced by the box scripts. Where the study app lives, and how to call it with the bearer token.
# Everything per-install lives in one config dir (created by scripts/setup/*.sh, mode 700):
#   HEY_STUDU_HOME   env > ~/.hey-studu
#   STUDY_URL        env > $HEY_STUDU_HOME/url (one line, e.g. https://my-study.onrender.com)
#   token file       STUDY_TOKEN_FILE env > $HEY_STUDU_HOME/post-token   (never printed; passed to curl via a config fd)
#   content dir      STUDY_CONTENT_DIR env > $HEY_STUDU_HOME/content-dir (one line) > /workspace/study
# Render's free plan sleeps after 15 min idle; a cold start can take ~30-60 s, so timeouts are generous
# and study_curl / study_curl_to retry connect failures and HTTP 502/503/504 for ~90s (see below).
HEY_STUDU_HOME="${HEY_STUDU_HOME:-${HOME:-/root}/.hey-studu}"
if [ -z "${STUDY_URL:-}" ] && [ -s "$HEY_STUDU_HOME/url" ]; then STUDY_URL="$(tr -d '[:space:]' < "$HEY_STUDU_HOME/url")"; fi
[ -n "${STUDY_URL:-}" ] || { echo "error: no app URL: set STUDY_URL or write it to $HEY_STUDU_HOME/url" >&2; exit 1; }
STUDY_URL="${STUDY_URL%/}"
if [ -z "${STUDY_CONTENT_DIR:-}" ] && [ -s "$HEY_STUDU_HOME/content-dir" ]; then STUDY_CONTENT_DIR="$(head -n1 "$HEY_STUDU_HOME/content-dir")"; fi
STUDY_CONTENT_DIR="${STUDY_CONTENT_DIR:-/workspace/study}"
STUDY_TOKEN_FILE="${STUDY_TOKEN_FILE:-$HEY_STUDU_HOME/post-token}"
[ -r "$STUDY_TOKEN_FILE" ] || { echo "error: token file not readable: $STUDY_TOKEN_FILE (run scripts/setup/gen-secrets.sh)" >&2; exit 1; }

STUDY_CONNECT_TIMEOUT="${STUDY_CONNECT_TIMEOUT:-25}"
STUDY_MAX_TIME="${STUDY_MAX_TIME:-90}"
STUDY_RETRY_BUDGET="${STUDY_RETRY_BUDGET:-90}"

# True if argv looks like a mutating HTTP request (POST/PUT/PATCH/DELETE or body upload).
_study_is_mutating() {
  local a prev=
  for a in "$@"; do
    case "$prev" in
      -X|--request) case "$a" in POST|PUT|PATCH|DELETE) return 0;; esac ;;
    esac
    case "$a" in
      -d|--data|--data-raw|--data-binary|--data-urlencode|-F|--form|--upload-file) return 0;;
    esac
    prev=$a
  done
  return 1
}

# Strip options we implement ourselves so callers' --retry/--fail don't fight the helper.
_study_strip_curl_meta() {
  _STUDY_CURL_ARGS=()
  _STUDY_WANT_FAIL=0
  local a skip=0
  for a in "$@"; do
    if [ "$skip" = 1 ]; then skip=0; continue; fi
    case "$a" in
      --retry|--retry-delay|--retry-max-time) skip=1; continue;;
      --retry-connrefused|--retry-all-errors) continue;;
      --fail|-f) _STUDY_WANT_FAIL=1; continue;;
      --fail-with-body) _STUDY_WANT_FAIL=2; continue;;
      -o|--output|-w|--write-out|--dump-header|-D) skip=1; continue;; # helper owns these
    esac
    _STUDY_CURL_ARGS+=("$a")
  done
}

# study_curl_to <outfile> <curl args...>: auth curl with cold-start retry.
# Prints the final HTTP code (or 000) on stdout. Body goes to <outfile>.
# Retries on: connect/transfer failure with no HTTP response, or HTTP 502/503/504.
# Never retries 2xx or 4xx. For mutating methods, also skips retry on timeout (exit 28)
# so a POST that may have landed server-side is not double-sent.
# Total retry window ~STUDY_RETRY_BUDGET seconds; backoff 3,6,12,24 (capped 24).
# Returns 0 when an HTTP status was received; non-zero if still unreachable after budget.
study_curl_to() {
  local outfile="${1:?study_curl_to: outfile required}"; shift
  _study_strip_curl_meta "$@"
  local mutating=0
  _study_is_mutating "${_STUDY_CURL_ARGS[@]}" && mutating=1

  local t0 elapsed backoff=3 attempt=0 code=000 rc=0 hdr
  t0=$(date +%s)
  hdr=$(mktemp)

  while :; do
    attempt=$((attempt + 1))
    : > "$outfile"
    : > "$hdr"
    code=000
    set +e
    curl -sS --connect-timeout "$STUDY_CONNECT_TIMEOUT" --max-time "$STUDY_MAX_TIME" \
      -D "$hdr" -o "$outfile" \
      -K <(printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '[:space:]' < "$STUDY_TOKEN_FILE")") \
      "${_STUDY_CURL_ARGS[@]}"
    rc=$?
    set -e
    code=$(awk 'toupper($0) ~ /^HTTP\//{ print $2; exit }' "$hdr" 2>/dev/null || true)
    [ -n "$code" ] || code=000

    local retry=0
    case "$code" in
      502|503|504) retry=1 ;;
      000)
        if [ "$mutating" = 1 ] && [ "$rc" = 28 ]; then
          retry=0
        elif [ "$rc" != 0 ]; then
          retry=1
        fi
        ;;
      *) retry=0 ;;
    esac

    if [ "$retry" = 0 ]; then
      rm -f "$hdr"
      printf '%s' "$code"
      [ "$code" != 000 ] && return 0
      return "$rc"
    fi

    elapsed=$(( $(date +%s) - t0 ))
    if [ "$elapsed" -ge "$STUDY_RETRY_BUDGET" ]; then
      rm -f "$hdr"
      printf '%s' "$code"
      [ "$code" != 000 ] && return 0
      return "$rc"
    fi
    local wait=$backoff
    if [ $((elapsed + wait)) -gt "$STUDY_RETRY_BUDGET" ]; then
      wait=$(( STUDY_RETRY_BUDGET - elapsed ))
      [ "$wait" -lt 1 ] && wait=1
    fi
    [ -n "${STUDY_RETRY_VERBOSE:-}" ] && \
      echo "study_curl: attempt $attempt code=$code rc=$rc; retry in ${wait}s (${elapsed}s elapsed)" >&2
    sleep "$wait"
    backoff=$(( backoff * 2 ))
    [ "$backoff" -gt 24 ] && backoff=24
  done
}

# study_curl <curl args...>: same retry policy; body on stdout (compatible with prior callers).
# Honours --fail / --fail-with-body from the caller: after retries, exits 22 on HTTP >=400
# (body still printed for --fail-with-body).
study_curl() {
  local out code rc want_fail
  out=$(mktemp)
  _study_strip_curl_meta "$@"
  want_fail="$_STUDY_WANT_FAIL"
  set +e
  code=$(study_curl_to "$out" "$@")
  rc=$?
  set -e
  if [ "$want_fail" = 2 ] || [ "$want_fail" = 1 ]; then
    cat "$out"
    rm -f "$out"
    if [ "$code" != 000 ] && [ "$code" -ge 400 ] 2>/dev/null; then
      return 22
    fi
    return "$rc"
  fi
  cat "$out"
  rm -f "$out"
  return "$rc"
}
