#!/usr/bin/env bash
# All of setup in order (each step is idempotent, so re-running after a failure is fine):
#   gen-secrets -> render-create -> wait-healthz -> set-password -> seed-content -> start-sync [-> set-webhook]
# env: RENDER_API_KEY DATABASE_URL REPO_URL STUDY_APP_PASSWORD, optional RENDER_REGION SERVICE_NAME
#      RENDER_OWNER_ID KIT_* CHAT_WEBHOOK_URL/KEY STUDY_CONTENT_DIR. args: optional content dir for seed-content.
. "$(dirname "$0")/common.sh"
need_env RENDER_API_KEY DATABASE_URL REPO_URL STUDY_APP_PASSWORD
D="$KIT_ROOT/scripts/setup"
"$D/gen-secrets.sh"
"$D/render-create.sh"
"$D/wait-healthz.sh"
"$D/set-password.sh"
"$D/seed-content.sh" "$@"
if command -v pm2 >/dev/null; then "$D/start-sync.sh"; else say "pm2 not installed: skipped start-sync (npm i -g pm2, then run start-sync.sh)"; fi
if [ -n "${CHAT_WEBHOOK_URL:-}" ] && [ -n "${CHAT_WEBHOOK_KEY:-}" ]; then say "chat webhook was set at create time"; else say "next: create the chat bot's webhook routine, then run set-webhook.sh"; fi
say "done: $(cat "$HEY_STUDU_HOME/url")"
