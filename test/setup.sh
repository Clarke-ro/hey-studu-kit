#!/usr/bin/env bash
# Tests scripts/setup/* against a mock Render API, a local app server and a THROWAWAY local Postgres.
#   E2E_DATABASE_URL=postgres://u:p@127.0.0.1:5432/kit_e2e bash test/setup.sh
# Needs pm2 on PATH for the start-sync check (uses a private PM2_HOME; your pm2 is not touched).
set -uo pipefail
cd "$(dirname "$0")/.."; ROOT="$PWD"; S="$ROOT/scripts/setup"
: "${E2E_DATABASE_URL:?set E2E_DATABASE_URL to a throwaway local DB}"
case "$E2E_DATABASE_URL" in *@127.0.0.1:*|*@localhost:*) ;; *) echo "refusing: E2E_DATABASE_URL must be a local DB" >&2; exit 2;; esac
P=${E2E_PORT:-18890}; RP=$((P+1))
W="$(mktemp -d)"; chmod 700 "$W"; PIDS=()
export HEY_STUDU_HOME="$W/home" PM2_HOME="$W/pm2"
cleanup() { command -v pm2 >/dev/null && pm2 kill >/dev/null 2>&1; for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "$W"; }; trap cleanup EXIT
pass=0 fail=0
ok() { pass=$((pass+1)); echo "  ok   $*"; }; bad() { fail=$((fail+1)); echo "  FAIL $*"; }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
r() { openssl rand -hex 16; }
export RENDER_API_KEY="rk_$(r)" MOCK_RENDER_KEY RENDER_API_BASE="http://127.0.0.1:$RP/v1" REPO_URL="https://github.com/student/hey-studu-kit"
MOCK_RENDER_KEY="$RENDER_API_KEY"
export DATABASE_URL="$E2E_DATABASE_URL" STUDY_APP_PASSWORD="pw-$(r)" CANARY_SECRET="canary-$(r)"
node test/mock-render.js "$W" $RP "http://127.0.0.1:$P" > "$W/mock.log" 2>&1 & PIDS+=($!)
sleep 0.3; OUT="$W/out.log"; : > "$OUT"
run() { "$@" >> "$OUT" 2>&1; }

echo "== gen-secrets"
run "$S/gen-secrets.sh" && ok "gen-secrets ran" || bad "gen-secrets failed"
eq "post-token mode 600" "$(stat -c %a "$HEY_STUDU_HOME/post-token")" 600
eq "vapid.json mode 600" "$(stat -c %a "$HEY_STUDU_HOME/vapid.json")" 600
eq "config dir mode 700" "$(stat -c %a "$HEY_STUDU_HOME")" 700
T1=$(sha256sum < "$HEY_STUDU_HOME/post-token"); run "$S/gen-secrets.sh"
eq "re-run keeps token" "$(sha256sum < "$HEY_STUDU_HOME/post-token")" "$T1"
TOKEN="$(cat "$HEY_STUDU_HOME/post-token")"; VPRIV="$(jq -r .privateKey "$HEY_STUDU_HOME/vapid.json")"

echo "== render-create (mock Render API)"
run "$S/render-create.sh" && ok "create ran" || bad "create failed"
C=$(jq -c 'select(.method=="POST" and .path=="/v1/services") | .body' "$W/render.jsonl")
eq "plan free" "$(jq -r .serviceDetails.plan <<<"$C")" free
eq "region default oregon" "$(jq -r .serviceDetails.region <<<"$C")" oregon
eq "owner discovered" "$(jq -r .ownerId <<<"$C")" tea-mock
eq "healthCheckPath" "$(jq -r .serviceDetails.healthCheckPath <<<"$C")" /healthz
eq "POST_TOKEN sent = file" "$(jq -r '.envVars[]|select(.key=="POST_TOKEN").value' <<<"$C")" "$TOKEN"
eq "VAPID private sent" "$(jq -r '.envVars[]|select(.key=="VAPID_PRIVATE_KEY").value' <<<"$C")" "$VPRIV"
eq "DATABASE_URL sent" "$(jq -r '.envVars[]|select(.key=="DATABASE_URL").value' <<<"$C")" "$DATABASE_URL"
eq "url saved" "$(cat "$HEY_STUDU_HOME/url")" "http://127.0.0.1:$P"
eq "service id saved" "$(cat "$HEY_STUDU_HOME/render-service-id")" svc-mock1
RENDER_REGION=mars "$S/render-create.sh" >/dev/null 2>&1 && bad "bad region accepted" || ok "bad region rejected"
run "$S/render-create.sh"
eq "re-run does not create a 2nd service" "$(jq -s '[.[]|select(.method=="POST" and .path=="/v1/services")]|length' "$W/render.jsonl")" 1
eq "re-run updates vars + deploys" "$(jq -s '[.[]|select(.method=="POST" and .path=="/v1/services/svc-mock1/deploys")]|length' "$W/render.jsonl")" 1

echo "== set-webhook"
HK="hk-$(r)"; CHAT_WEBHOOK_URL="https://hooks.example/abc" CHAT_WEBHOOK_KEY="$HK" run "$S/set-webhook.sh" && ok "set-webhook ran" || bad "set-webhook failed"
eq "webhook key PUT" "$(jq -s -r '[.[]|select(.path=="/v1/services/svc-mock1/env-vars/CHAT_WEBHOOK_KEY")][-1].body.value' "$W/render.jsonl")" "$HK"
eq "redeploy after webhook" "$(jq -s '[.[]|select(.path=="/v1/services/svc-mock1/deploys" and .method=="POST")]|length' "$W/render.jsonl")" 2
CHAT_WEBHOOK_URL="ftp://x" CHAT_WEBHOOK_KEY=x "$S/set-webhook.sh" >/dev/null 2>&1 && bad "bad webhook url accepted" || ok "bad webhook url rejected"
eq "status works" "$(node "$S/render.js" status | grep -c 'latest_deploy=dep-1 live')" 1

echo "== app up: wait-healthz, set-password, seed, sync, push-test"
node -e 'const{Client}=require("pg");(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
await c.query("DROP TABLE IF EXISTS messages,subscriptions,chat_messages,kv,sessions,submissions,uploads,content,schema_migrations");await c.end()})()'
( export POST_TOKEN="$TOKEN" VAPID_PUBLIC_KEY="$(jq -r .publicKey "$HEY_STUDU_HOME/vapid.json")" VAPID_PRIVATE_KEY="$VPRIV" VAPID_SUBJECT=mailto:t@example.invalid PUSH_DRY_RUN=1 HOST=127.0.0.1 PORT=$P
  exec node server.js ) >> "$W/server.log" 2>&1 & PIDS+=($!)
WAIT_TIMEOUT_S=30 run "$S/wait-healthz.sh" && ok "wait-healthz" || bad "wait-healthz failed"
run "$S/set-password.sh" && ok "set-password ran" || bad "set-password failed"
STUDY_APP_PASSWORD=short "$S/set-password.sh" >/dev/null 2>&1 && bad "short password accepted" || ok "short password rejected"
U="http://127.0.0.1:$P"
eq "login with that password" "$(printf %s "$STUDY_APP_PASSWORD" | curl -s -o /dev/null -w %{http_code} --data-urlencode password@- $U/login)" 303
CD="$W/study"; STUDY_CONTENT_DIR="$CD" run "$S/seed-content.sh" && ok "seed-content ran" || bad "seed-content failed"
eq "examples copied" "$(ls "$CD/lessons" | wc -l)" "$(ls examples/lessons | wc -l)"
eq "content-dir remembered" "$(cat "$HEY_STUDU_HOME/content-dir")" "$CD"
eq "server has curriculum" "$(box/api-get.sh /api/content/curriculum.json | jq -r '.months[0].id')" "$(jq -r '.months[0].id' examples/curriculum.json)"
echo "# mine" > "$CD/roadmap.md"; run "$S/seed-content.sh"
eq "re-seed keeps the student's edits" "$(head -1 "$CD/roadmap.md")" "# mine"
if command -v pm2 >/dev/null; then
  run "$S/start-sync.sh" && ok "start-sync ran" || bad "start-sync failed"
  run "$S/start-sync.sh"; eq "re-run: still one process" "$(pm2 jlist 2>/dev/null | jq '[.[]|select(.name=="hey-studu-sync")]|length')" 1
  sleep 2; echo "# synced by pm2" > "$CD/roadmap.md"; for i in $(seq 40); do [ "$(box/api-get.sh /api/content/roadmap.md 2>/dev/null)" = "# synced by pm2" ] && break; sleep 2; done
  eq "pm2 loop pushed an edit" "$(box/api-get.sh /api/content/roadmap.md)" "# synced by pm2"
  ENVK=$(pm2 jlist | jq -r '.[]|select(.name=="hey-studu-sync")|.pm2_env.env // {}|keys[]' | sort | tr '\n' ' ')
  for k in CANARY_SECRET DATABASE_URL RENDER_API_KEY STUDY_APP_PASSWORD GH_TOKEN; do grep -qw "$k" <<<"$ENVK" && bad "pm2 env has $k" || ok "pm2 env has no $k"; done
  grep -qF -e "$CANARY_SECRET" -e "$RENDER_API_KEY" -e "$STUDY_APP_PASSWORD" -e "$E2E_DATABASE_URL" "$PM2_HOME/dump.pm2" && bad "pm2 dump leaks a secret" || ok "pm2 dump has no secrets"
else echo "  skip start-sync (pm2 not on PATH)"; fi
run "$S/push-test.sh"   # PUSH_DRY_RUN: exits 1 (no device), but the message must be posted
eq "push-test posted a message" "$(box/api-get.sh /api/messages | jq '[.[]|select(.title=="Test notification")]|length')" 1

echo "== no secret in any output"
for v in "$TOKEN" "$VPRIV" "$RENDER_API_KEY" "$STUDY_APP_PASSWORD" "$E2E_DATABASE_URL" "$HK"; do
  grep -qF -e "$v" "$OUT" "$W/server.log" && bad "secret printed" || ok "secret not printed"; done
echo; echo "setup: $pass passed, $fail failed"; [ "$fail" = 0 ]
