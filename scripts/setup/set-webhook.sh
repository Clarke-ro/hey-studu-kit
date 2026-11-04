#!/usr/bin/env bash
# Point the app at the chat bot's webhook routine and redeploy.
# env: RENDER_API_KEY, CHAT_WEBHOOK_URL, CHAT_WEBHOOK_KEY, optional SUBMISSION_WEBHOOK_URL/KEY, RENDER_SERVICE_ID.
# args: --no-deploy (apply on the next deploy instead)
. "$(dirname "$0")/common.sh"
need_env RENDER_API_KEY CHAT_WEBHOOK_URL CHAT_WEBHOOK_KEY
exec node "$KIT_ROOT/scripts/setup/render.js" set-webhook "$@"
