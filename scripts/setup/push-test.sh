#!/usr/bin/env bash
# Send a test notification to every subscribed device (posts one inbox message).
# usage: push-test.sh [bot]   (default: the kit's feedback bot id from kit.config.json, else "coach")
. "$(dirname "$0")/common.sh"
BOT="${1:-$(jq -r '.feedback_bot // "coach"' "$KIT_ROOT/kit.config.json" 2>/dev/null || echo coach)}"
R="$("$KIT_ROOT/box/post.sh" "$BOT" "Test notification" "If you can read this as a notification, push works. You can delete this message.")"
jq -c '{ok, message_id: .message.id, push}' <<<"$R"
[ "$(jq -r '.push.sent // 0' <<<"$R")" -gt 0 ] || { say "no device got it: open the app on the phone, tap the bell and allow notifications, then retry"; exit 1; }
