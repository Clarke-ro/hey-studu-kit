#!/usr/bin/env bash
# Run box/content-sync.sh --loop 60 under pm2 as "hey-studu-sync" (override: PM2_NAME).
# The process gets a clean, minimal env (env -i + filter_env), so no inherited secret (GH_TOKEN,
# DATABASE_URL, RENDER_API_KEY, ...) ends up in the process or in pm2's saved dump. The token is read from
# $HEY_STUDU_HOME/post-token at each request. Idempotent: replaces an existing process of the same name.
# env: PM2_SAVE=0 skips `pm2 save` (default: save, so it comes back after a reboot with `pm2 resurrect`).
. "$(dirname "$0")/common.sh"
command -v pm2 >/dev/null || die "pm2 not found (npm i -g pm2)"
[ -s "$HEY_STUDU_HOME/url" ] || die "no $HEY_STUDU_HOME/url yet (run render-create.sh)"
NAME="${PM2_NAME:-hey-studu-sync}"
DIRC="${STUDY_CONTENT_DIR:-$(head -n1 "$HEY_STUDU_HOME/content-dir" 2>/dev/null || echo /workspace/study)}"
ECO="$HEY_STUDU_HOME/pm2.config.js"
node -e '
const [name, script, home, dir] = process.argv.slice(1);
const app = { name, script, args: "--loop 60", interpreter: "bash", filter_env: true, autorestart: true,
  max_restarts: 50, restart_delay: 5000, env: { HEY_STUDU_HOME: home, STUDY_CONTENT_DIR: dir, PATH: "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME, LANG: "C.UTF-8" } };
require("fs").writeFileSync(home + "/pm2.config.js", "module.exports = " + JSON.stringify({ apps: [app] }, null, 2) + ";\n", { mode: 0o600 });
' "$NAME" "$KIT_ROOT/box/content-sync.sh" "$HEY_STUDU_HOME" "$DIRC"
PM2="$(command -v pm2)"
run_pm2() { env -i HOME="$HOME" PATH="$PATH" ${PM2_HOME:+PM2_HOME="$PM2_HOME"} "$PM2" "$@"; }
run_pm2 delete "$NAME" >/dev/null 2>&1 || true
run_pm2 start "$ECO" >/dev/null
[ "${PM2_SAVE:-1}" = 0 ] || run_pm2 save >/dev/null
say "pm2 process $NAME: $DIRC -> $(cat "$HEY_STUDU_HOME/url")  (logs: pm2 logs $NAME)"
