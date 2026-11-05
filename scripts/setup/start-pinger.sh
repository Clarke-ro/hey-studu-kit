#!/usr/bin/env bash
# Run scripts/setup/ping-healthz.js under pm2 as "hey-studu-pinger" (override: PM2_PING_NAME).
# GETs $HEY_STUDU_HOME/url/healthz every 10 minutes, 24/7, so a free Render instance stays awake.
# Clean, minimal env (env -i + filter_env): no GH_TOKEN / DATABASE_URL / RENDER_API_KEY in the process
# or in pm2's saved dump. Idempotent: replaces an existing process of the same name.
# env: PM2_SAVE=0 skips `pm2 save` (default: save, so it comes back after a reboot with `pm2 resurrect`).
. "$(dirname "$0")/common.sh"
command -v pm2 >/dev/null || die "pm2 not found (npm i -g pm2)"
command -v node >/dev/null || die "node not found"
[ -s "$HEY_STUDU_HOME/url" ] || die "no $HEY_STUDU_HOME/url yet (run render-create.sh)"
URL="$(tr -d '[:space:]' < "$HEY_STUDU_HOME/url")"
URL="${URL%/}"
NAME="${PM2_PING_NAME:-hey-studu-pinger}"
ECO="$HEY_STUDU_HOME/pm2-pinger.config.js"
NODE="$(command -v node)"
node -e '
const [name, script, home, url, nodeBin] = process.argv.slice(1);
const app = {
  name, script, interpreter: nodeBin, filter_env: true, autorestart: true,
  max_restarts: 50, restart_delay: 5000,
  env: {
    STUDY_PING_URL: url,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME || "/tmp",
    LANG: "C.UTF-8",
  },
};
require("fs").writeFileSync(home + "/pm2-pinger.config.js",
  "module.exports = " + JSON.stringify({ apps: [app] }, null, 2) + ";\n", { mode: 0o600 });
' "$NAME" "$KIT_ROOT/scripts/setup/ping-healthz.js" "$HEY_STUDU_HOME" "$URL" "$NODE"
PM2="$(command -v pm2)"
run_pm2() { env -i HOME="$HOME" PATH="$PATH" ${PM2_HOME:+PM2_HOME="$PM2_HOME"} "$PM2" "$@"; }
run_pm2 delete "$NAME" >/dev/null 2>&1 || true
run_pm2 start "$ECO" >/dev/null
[ "${PM2_SAVE:-1}" = 0 ] || run_pm2 save >/dev/null
say "pm2 process $NAME: every 10m GET $URL/healthz  (logs: pm2 logs $NAME)"
