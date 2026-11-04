#!/usr/bin/env bash
# Generate the per-install secrets into $HEY_STUDU_HOME (default ~/.hey-studu), mode 600:
#   post-token   bearer token the bots use (POST_TOKEN on the server)
#   vapid.json   {publicKey, privateKey} for Web Push
# Idempotent: existing files are kept. --rotate makes new ones (then re-run render-create.sh and redeploy;
# rotating VAPID keys means every phone has to turn notifications on again).
# Prints only file paths, never the values.
. "$(dirname "$0")/common.sh"
ROTATE=0; [ "${1:-}" = "--rotate" ] && ROTATE=1
need_deps
if [ "$ROTATE" = 1 ] || [ ! -s "$HEY_STUDU_HOME/post-token" ]; then
  node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))' > "$HEY_STUDU_HOME/post-token.tmp"
  mv "$HEY_STUDU_HOME/post-token.tmp" "$HEY_STUDU_HOME/post-token"; say "wrote $HEY_STUDU_HOME/post-token"
else say "kept $HEY_STUDU_HOME/post-token"; fi
if [ "$ROTATE" = 1 ] || [ ! -s "$HEY_STUDU_HOME/vapid.json" ]; then
  (cd "$KIT_ROOT" && node -e 'const k=require("web-push").generateVAPIDKeys();process.stdout.write(JSON.stringify({publicKey:k.publicKey,privateKey:k.privateKey}))') > "$HEY_STUDU_HOME/vapid.json.tmp"
  mv "$HEY_STUDU_HOME/vapid.json.tmp" "$HEY_STUDU_HOME/vapid.json"; say "wrote $HEY_STUDU_HOME/vapid.json"
else say "kept $HEY_STUDU_HOME/vapid.json"; fi
chmod 600 "$HEY_STUDU_HOME/post-token" "$HEY_STUDU_HOME/vapid.json"
