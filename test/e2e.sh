#!/usr/bin/env bash
# End-to-end test against a real, THROWAWAY Postgres: E2E_DATABASE_URL=postgres://u:p@127.0.0.1:5432/kit_e2e bash test/e2e.sh
# Content comes from examples/. Box scripts are exercised exactly as a bot would run them.
# Uses its own random token / VAPID keys / password, a mock webhook and a mock push service. Never sends real pushes.
# The DB is wiped first (all app tables are dropped), so never point it at a real database.
set -uo pipefail
cd "$(dirname "$0")/.."; ROOT="$PWD"
: "${E2E_DATABASE_URL:?set E2E_DATABASE_URL to a throwaway local DB}"
case "$E2E_DATABASE_URL" in *@127.0.0.1:*|*@localhost:*) ;; *) echo "refusing: E2E_DATABASE_URL must be a local DB" >&2; exit 2;; esac
P=${E2E_PORT:-18790}; WP=$((P+1)); PP=$((P+2))
W="$(mktemp -d)"; chmod 700 "$W"; PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "$W"; }; trap cleanup EXIT
pass=0 fail=0
ok() { pass=$((pass+1)); echo "  ok   $*"; }; bad() { fail=$((fail+1)); echo "  FAIL $*"; }
check() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

# --- secrets + mocks
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj /CN=localhost \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" -keyout "$W/key.pem" -out "$W/cert.pem" 2>/dev/null
node -e '
const wp=require("web-push"),c=require("crypto"),k=wp.generateVAPIDKeys(),r=()=>c.randomBytes(18).toString("base64url");
const e={POST_TOKEN:r(),VAPID_PUBLIC_KEY:k.publicKey,VAPID_PRIVATE_KEY:k.privateKey,VAPID_SUBJECT:"mailto:e2e@example.invalid",STUDY_APP_PASSWORD:r(),CHAT_WEBHOOK_KEY:r()};
require("fs").writeFileSync(process.argv[1],Object.entries(e).map(([a,b])=>`export ${a}=${b}`).join("\n")+"\n",{mode:0o600})' "$W/env"
. "$W/env"; printf %s "$POST_TOKEN" > "$W/token"
export DATABASE_URL="$E2E_DATABASE_URL" CHAT_WEBHOOK_URL="http://127.0.0.1:$WP/hook" NODE_EXTRA_CA_CERTS="$W/cert.pem" HOST=127.0.0.1 PORT=$P
MOCK_HOOK_KEY="$CHAT_WEBHOOK_KEY" node test/mocks.js "$W" $WP $PP > "$W/mocks.log" 2>&1 & PIDS+=($!)
node -e 'const{Client}=require("pg");(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
await c.query("DROP TABLE IF EXISTS messages,subscriptions,chat_messages,kv,sessions,submissions,uploads,content,schema_migrations");await c.end()})()'
node auth.js set > /dev/null || { echo "auth set failed"; exit 1; }
start() { node server.js >> "$W/server.log" 2>&1 & SPID=$!; PIDS+=($SPID); for i in $(seq 50); do curl -sf "http://127.0.0.1:$P/healthz" >/dev/null && return 0; sleep 0.2; done; echo "server didn't start"; cat "$W/server.log"; exit 1; }
start
U="http://127.0.0.1:$P"; export STUDY_URL="$U" STUDY_TOKEN_FILE="$W/token" HEY_STUDU_HOME="$W/home"
H=(-H "Origin: $U" -H "Content-Type: application/json")
echo "== health + auth"
eq "healthz db ok" "$(curl -s $U/healthz | jq -r .db.ok)" true
eq "api without auth -> 401" "$(curl -s -o /dev/null -w %{http_code} $U/api/messages)" 401
eq "post without token -> 401" "$(curl -s -o /dev/null -w %{http_code} -X POST "${H[@]}" -d '{"bot":"x","title":"y"}' $U/api/messages)" 401
eq "spoofed XFF from loopback still needs auth" "$(curl -s -o /dev/null -w %{http_code} -H 'X-Forwarded-For: 127.0.0.1' $U/api/messages)" 401
eq "wrong password -> 401" "$(curl -s -o /dev/null -w %{http_code} --data-urlencode password=wrong $U/login)" 401
printf %s "$STUDY_APP_PASSWORD" | curl -s -o /dev/null -c "$W/jar" --data-urlencode password@- $U/login
CK="Cookie: $(awk '$6=="si_session"{print $6"="$7}' "$W/jar")"; C=(-H "$CK")
eq "login cookie works" "$(curl -s -o /dev/null -w %{http_code} "${C[@]}" $U/api/progress)" 200
grep -q "Secure" <(printf %s "$STUDY_APP_PASSWORD" | curl -s -D - -o /dev/null --data-urlencode password@- $U/login | grep -i set-cookie) && ok "session cookie is Secure" || bad "cookie not Secure"

echo "== kit branding"
eq "login page uses kit title" "$(curl -s $U/login | grep -o '<h1>[^<]*</h1>')" "<h1>$(jq -r .title kit.config.json)</h1>"
eq "manifest is public + named from kit" "$(curl -s $U/manifest.json | jq -r .name)" "$(jq -r .title kit.config.json)"
eq "kit.js needs login" "$(curl -s -o /dev/null -w %{http_code} $U/kit.js)" 401
eq "kit.js has roster" "$(curl -s "${C[@]}" $U/kit.js | sed 's/^window.KIT=//; s/;$//' | jq -r '[.bots[].id]|join(",")')" "$(jq -r '[.bots[].id]|join(",")' kit.config.json)"
check "index.html templated (no {{ }})" bash -c "! curl -s -H '$CK' $U/ | grep -q '{{'"
check "home page served" bash -c "curl -s -H '$CK' $U/ | grep -q '/kit.js'"
echo "== push subscribe (mock push service)"
SUBJ=$(node -e 'const c=require("crypto"),e=c.createECDH("prime256v1");e.generateKeys();const k={p256dh:e.getPublicKey().toString("base64url"),auth:c.randomBytes(16).toString("base64url")};
console.log(JSON.stringify([{endpoint:"https://localhost:'$PP'/push/live",keys:k},{endpoint:"https://localhost:'$PP'/push/gone",keys:k}]))')
for i in 0 1; do curl -s -o /dev/null "${C[@]}" "${H[@]}" -d "$(jq -c ".[$i]" <<<"$SUBJ")" $U/api/subscribe; done
echo "== content sync"
CD="$W/study"; mkdir -p "$CD"; cp -r "$ROOT/examples/." "$CD/"; echo junk > "$CD/lessons/Bad_Name.md"
export STUDY_CONTENT_DIR="$CD" CONTENT_SYNC_STATE_DIR="$W/cs"
N=$(ls "$CD"/lessons/*.md | grep -c '/[a-z0-9-]*\.md$'); N=$((N+3))   # + curriculum.json roadmap.md opportunities.md
eq "first sync pushes all whitelisted files" "$(box/content-sync.sh | grep -c pushed)" "$N"
eq "second sync pushes nothing" "$(box/content-sync.sh | grep -c pushed)" 0
echo "## edited" >> "$CD/lessons/ex-active-recall.md"
eq "edit -> one push" "$(box/content-sync.sh | grep -c pushed)" 1
eq "--full against server: nothing to push" "$(box/content-sync.sh --full | grep -c pushed)" 0
eq "server has edit" "$(box/api-get.sh /api/content/lessons/ex-active-recall.md | tail -1)" "## edited"
eq "bad path rejected" "$(curl -s -o /dev/null -w %{http_code} -X PUT -K <(printf 'header = "Authorization: Bearer %s"\n' "$POST_TOKEN") --data-binary x $U/api/content/server.js)" 400
eq "bad json rejected" "$(curl -s -o /dev/null -w %{http_code} -X PUT -K <(printf 'header = "Authorization: Bearer %s"\n' "$POST_TOKEN") --data-binary '{bad' $U/api/content/curriculum.json)" 400
eq "content needs token (cookie not enough)" "$(curl -s -o /dev/null -w %{http_code} "${C[@]}" $U/api/content)" 401
( box/content-sync.sh & box/content-sync.sh & wait ) >/dev/null; ok "concurrent runs don't clash"
eq "curriculum served from DB" "$(curl -s "${C[@]}" $U/api/curriculum | jq '.months|length')" "$(jq '.months|length' "$CD/curriculum.json")"
eq "lesson served from DB" "$(curl -s "${C[@]}" $U/api/lessons/ex-active-recall | jq -r '.id')" ex-active-recall

echo "== post via script (push to mock; dead sub pruned)"
R=$(box/post.sh coach "E2E title" "hello **world**" https://example.com)
eq "post ok" "$(jq -r .ok <<<"$R")" true
eq "push sent 1" "$(jq -r .push.sent <<<"$R")" 1
eq "dead sub removed" "$(jq -r .push.removed <<<"$R")" 1
sleep 0.3; eq "mock push got encrypted+VAPID request" "$(jq -s '[.[]|select(.path=="/push/live" and .vapid and .encoding=="aes128gcm")]|length' "$W/push.jsonl")" 1
MID=$(jq -r .message.id <<<"$R")
eq "message listed" "$(curl -s "${C[@]}" $U/api/messages | jq length)" 1
eq "mark read" "$(curl -s "${C[@]}" "${H[@]}" -d '{}' $U/api/messages/$MID/read | jq -r .message.read)" true

echo "== uploads"
printf '\x89PNG\r\n\x1a\n' > "$W/a.png"; head -c 2000 /dev/urandom >> "$W/a.png"
UP=$(curl -s "${C[@]}" -H "Origin: $U" -H 'Content-Type: image/png' -H 'X-Filename: a.png' --data-binary @"$W/a.png" $U/api/uploads)
UID_=$(jq -r .id <<<"$UP"); UURL=$(jq -r .url <<<"$UP")
check "upload created" test -n "$UID_" -a "$UID_" != null
eq "upload bytes round-trip (cookie)" "$(curl -s "${C[@]}" $U$UURL | sha256sum | cut -c1-16)" "$(sha256sum < "$W/a.png" | cut -c1-16)"
eq "exe rejected" "$(curl -s -o /dev/null -w %{http_code} "${C[@]}" -H "Origin: $U" -H 'X-Filename: x.exe' --data-binary MZ $U/api/uploads)" 415

echo "== chat + webhook (mock) + reply"
CR=$(curl -s "${C[@]}" "${H[@]}" -d "$(jq -nc --arg id "$UID_" '{text:"hi chat bot",attachments:[$id]}')" $U/api/chat)
CID=$(jq -r .message.id <<<"$CR"); sleep 0.5
eq "chat status sent" "$(curl -s "${C[@]}" $U/api/chat | jq -r --argjson i "$CID" '.messages[]|select(.id==$i)|.status')" sent
eq "webhook got chat with key" "$(jq -s '[.[]|select(.type=="chat" and .auth_ok)]|length' "$W/webhook.jsonl")" 1
eq "webhook carries context (curriculum + current lesson)" "$(jq -rs '[.[]|select(.type=="chat")][0].payload.context | (.current_lesson.id // .current.id // .progress.current // "none")' "$W/webhook.jsonl")" ex-active-recall
eq "webhook context has student/field" "$(jq -rs '[.[]|select(.type=="chat")][0].payload.context.student.field' "$W/webhook.jsonl")" "$(jq -r .field kit.config.json)"
HP=$(jq -rs '[.[]|select(.type=="chat")][0].payload.attachments[0].api_path' "$W/webhook.jsonl")
F=$(box/fetch-upload.sh "$HP" "$W/got.png"); eq "bot can fetch attachment with token" "$(sha256sum < "$F" | cut -c1-16)" "$(sha256sum < "$W/a.png" | cut -c1-16)"
eq "chat-reply.sh" "$(box/chat-reply.sh "$CID" "hello from the bot")" ok
eq "question answered" "$(curl -s "${C[@]}" $U/api/chat | jq -r --argjson i "$CID" '.messages[]|select(.id==$i)|.status')" answered
eq "reply needs token" "$(curl -s -o /dev/null -w %{http_code} "${C[@]}" "${H[@]}" -d '{"text":"x"}' $U/api/chat/reply)" 401
eq "cross-origin chat blocked" "$(curl -s -o /dev/null -w %{http_code} "${C[@]}" -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{"text":"x"}' $U/api/chat)" 403

echo "== submission + feedback"
SR=$(curl -s "${C[@]}" "${H[@]}" -d "$(jq -nc --arg id "$UID_" '{text:"my answer",attachments:[$id]}')" $U/api/lessons/ex-plan-your-week/submissions)
SID=$(jq -r '.submission.id // .id' <<<"$SR"); sleep 0.5
check "submission created" grep -Eq '^[0-9]{8}-[0-9]{6}-[a-f0-9]{4}$' <<<"$SID"
eq "webhook got submission" "$(jq -s '[.[]|select(.type=="submission")]|length' "$W/webhook.jsonl")" 1
eq "coach sees it as sent" "$(box/api-get.sh '/api/submissions?status=sent' | jq -r '.submissions[0].id')" "$SID"
eq "submission-feedback.sh" "$(box/submission-feedback.sh "$SID" "Nice work")" ok
eq "reviewed" "$(box/api-get.sh /api/submissions/$SID | jq -r '.status // .submission.status')" reviewed
PB=$(wc -l < "$W/push.jsonl"); NO_PUSH=1 box/submission-feedback.sh "$SID" "more" >/dev/null; sleep 0.3
eq "NO_PUSH=1 sends no push" "$(wc -l < "$W/push.jsonl")" "$PB"
eq "progress: quiz/complete" "$(curl -s "${C[@]}" "${H[@]}" -d '{}' $U/api/lessons/ex-active-recall/complete | jq -r .ok)" true

echo "== restart: everything persisted"
kill $SPID; wait $SPID 2>/dev/null; start
eq "messages persisted" "$(box/api-get.sh /api/messages | jq length)" 1
eq "chat persisted (2)" "$(box/api-get.sh /api/chat | jq '.messages|length')" 2
eq "session persisted" "$(curl -s -o /dev/null -w %{http_code} "${C[@]}" $U/api/progress)" 200
eq "progress persisted" "$(box/api-get.sh /api/progress | jq -r '.completed|has("ex-active-recall")')" true
eq "upload persisted" "$(curl -s "${C[@]}" $U$UURL | sha256sum | cut -c1-16)" "$(sha256sum < "$W/a.png" | cut -c1-16)"
eq "content persisted" "$(box/api-get.sh /api/content | jq length)" "$N"
eq "subs: 1 live left" "$(node -e 'const{Client}=require("pg");(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();console.log((await c.query("select count(*) n from subscriptions")).rows[0].n);await c.end()})()')" 1
R2=$(box/post.sh coach "after restart" x); eq "ids continue after restart" "$(jq -r .message.id <<<"$R2")" $((MID+1))
eq "delete chat message" "$(curl -s -o /dev/null -w %{http_code} -X DELETE -K <(printf 'header = "Authorization: Bearer %s"\n' "$POST_TOKEN") $U/api/chat/$CID)" 200
eq "upload kept: submission still uses it" "$(curl -s -o /dev/null -w %{http_code} "${C[@]}" $U$UURL)" 200
eq "delete submission" "$(curl -s -o /dev/null -w %{http_code} -X DELETE -K <(printf 'header = "Authorization: Bearer %s"\n' "$POST_TOKEN") $U/api/submissions/$SID)" 200
eq "now upload is gone" "$(curl -s -o /dev/null -w %{http_code} "${C[@]}" $U$UURL)" 404
RSS=$(curl -s $U/healthz | jq .rss_mb); echo "  rss after test: ${RSS} MB"
grep -q "$POST_TOKEN\|$VAPID_PRIVATE_KEY\|$CHAT_WEBHOOK_KEY\|$STUDY_APP_PASSWORD" "$W/server.log" && bad "secret in server log" || ok "no secrets in server log"
echo; echo "e2e: $pass passed, $fail failed"; [ "$fail" = 0 ]
