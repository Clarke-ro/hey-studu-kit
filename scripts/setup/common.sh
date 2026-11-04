# shellcheck shell=bash
# Sourced by scripts/setup/*.sh. Never prints secret values.
set -euo pipefail
umask 077
KIT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HEY_STUDU_HOME="${HEY_STUDU_HOME:-${HOME:-/root}/.hey-studu}"
mkdir -p "$HEY_STUDU_HOME"; chmod 700 "$HEY_STUDU_HOME"
export HEY_STUDU_HOME KIT_ROOT
say() { echo "hey-studu setup: $*"; }
die() { echo "hey-studu setup: error: $*" >&2; exit 1; }
need_env() { local v; for v in "$@"; do [ -n "${!v:-}" ] || die "env $v is not set"; done; }
need_deps() { [ -d "$KIT_ROOT/node_modules/web-push" ] || (cd "$KIT_ROOT" && npm ci --omit=dev --silent >/dev/null) || die "npm ci failed in $KIT_ROOT"; }
