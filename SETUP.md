# SETUP: deploying the kit for one student

Written for **hey studu**, the setup bot, and for anyone doing it by hand. Every step is safe to re-run.
All `scripts/setup/*` are non-interactive. They take secrets from env, never print them, and keep per-install
files in `~/.hey-studu/` (mode 700; files 600). Total cost: $0. No card is needed.

## 0. What the student needs (accounts, all free)
| Account | Sign up | Used for |
|---|---|---|
| GitHub | https://github.com/signup | their own copy of this repo (Render deploys from it) |
| Render | https://dashboard.render.com/register (sign up **with GitHub**) | hosting the app (free web service) |
| Neon | https://console.neon.tech/signup | Postgres database (free plan) |

## 1. Collect the keys (secure form only, never in chat)
Ask for these through a secure form (RequestUserForm / vault), not as chat messages. Store them only as env vars
for the setup shell.
| Key | Where the student gets it |
|---|---|
| `DATABASE_URL` | Neon: New project (region near the student), then **Connect**, then copy the **pooled** connection string (`postgresql://…-pooler…/neondb?sslmode=require`) |
| `RENDER_API_KEY` | Render: Account Settings, then **API Keys**, then Create API key (https://dashboard.render.com/u/settings#api-keys) |
| `GH_TOKEN` | GitHub: Settings, then Developer settings, then Personal access tokens. Use a classic token with `repo` scope, or a fine-grained token with Administration + Contents read/write on their repos. Only needed to create their repo copy. |
| `STUDY_APP_PASSWORD` | They choose it (8+ characters). It's the app's login password and is stored only as a scrypt hash. |

Also ask (plain chat is fine): first name, field of study, timezone (IANA, e.g. `Europe/Lisbon`), the nearest
Render region (`oregon`, `ohio`, `virginia`, `frankfurt` or `singapore`), and an optional accent color.

## 2. Their own repo (fork or template copy)
Pick one:
- **Template copy (recommended).** Open this repo on GitHub, then **Use this template**, then **Create a new repository**.
  Or use the API with their token:
  ```bash
  curl -sS -X POST -K <(printf 'header = "Authorization: Bearer %s"\n' "$GH_TOKEN") \
    -H 'Accept: application/vnd.github+json' https://api.github.com/repos/<template-owner>/hey-studu-kit/generate \
    -d '{"owner":"<their-login>","name":"hey-studu-kit","private":false}'
  ```
- **Fork.** Use the **Fork** button, or `POST /repos/<template-owner>/hey-studu-kit/forks`.

Personalize it by committing `kit.config.json` to their repo: `title`, `student_name`, `field`, `accent`,
`timezone`, and the `bots` roster (`id`, `name`, `color`, `about`). Or skip the commit and pass
`KIT_TITLE`, `KIT_STUDENT_NAME`, `KIT_FIELD`, `KIT_TIMEZONE`, `KIT_ACCENT` and `KIT_BOTS` (JSON) as env vars to
step 4. Render reads those as overrides.

**Render GitHub app.** The student installs it on their repo at https://github.com/apps/render/installations/new
(choose "Only select repositories", then their repo). A private repo needs this. A public repo also needs it to
auto-deploy on push.

## 3. Box checkout
```bash
git clone https://github.com/<their-login>/hey-studu-kit ~/hey-studu-kit && cd ~/hey-studu-kit && npm ci --omit=dev
npm i -g pm2     # if missing; runs content-sync in the background
```

## 4. Deploy
All in one go:
```bash
export DATABASE_URL RENDER_API_KEY STUDY_APP_PASSWORD   # from the secure form
REPO_URL=https://github.com/<their-login>/hey-studu-kit RENDER_REGION=frankfurt \
  KIT_STUDENT_NAME=Sam KIT_FIELD=biology KIT_TIMEZONE=Europe/Lisbon \
  scripts/setup/deploy.sh            # or: scripts/setup/deploy.sh /path/to/real/content
```
Or step by step:
| Script | Env inputs | What it does |
|---|---|---|
| `gen-secrets.sh [--rotate]` | none | writes `~/.hey-studu/post-token` and `vapid.json` (mode 600); keeps existing ones |
| `render-create.sh` | `RENDER_API_KEY DATABASE_URL REPO_URL`, optional `RENDER_OWNER_ID SERVICE_NAME`(hey-studu) `RENDER_REGION`(oregon) `BRANCH`(main) `VAPID_SUBJECT CHAT_WEBHOOK_URL/KEY SUBMISSION_WEBHOOK_URL/KEY KIT_*` | creates the free web service through the Render API, with all env vars in the request. Finds the workspace by itself if there is only one. If the service exists, it updates the vars and redeploys. Saves `~/.hey-studu/url` and `render-service-id`. |
| `wait-healthz.sh` | optional `WAIT_TIMEOUT_S`(900) | waits until `/healthz` reports the DB ok (the first build takes about 3-6 min) |
| `set-password.sh` | `DATABASE_URL STUDY_APP_PASSWORD` | stores the scrypt hash and signs out all devices. The running app picks it up on the next login. |
| `seed-content.sh [dir] [--force]` | optional `STUDY_CONTENT_DIR` | copies `examples/` into the content folder (default `/workspace/study`) unless it has content, or uses `dir` as is. Then it pushes everything once. |
| `start-sync.sh` | optional `PM2_NAME PM2_SAVE=0` | runs `box/content-sync.sh --loop 60` under pm2 with a clean env (no inherited secrets in pm2's dump) |
| `start-pinger.sh` | optional `PM2_PING_NAME PM2_SAVE=0` | runs `scripts/setup/ping-healthz.js` under pm2 with a clean env; GETs `/healthz` every 10 min, 24/7, so free Render stays awake |
| `set-webhook.sh [--no-deploy]` | `RENDER_API_KEY CHAT_WEBHOOK_URL CHAT_WEBHOOK_KEY`, optional `SUBMISSION_WEBHOOK_URL/KEY` | sets the webhook vars and redeploys |
| `push-test.sh [bot]` | none | posts a test message and fails if no phone received it |
| `node scripts/setup/render.js status` | `RENDER_API_KEY` | service URL and latest deploy status |

Then, in the bot shell: `unset DATABASE_URL RENDER_API_KEY STUDY_APP_PASSWORD GH_TOKEN`. The bots only need
`~/.hey-studu/`.

## 5. Chat bot webhook
1. The student creates (or picks) the chat bot, whose display name is the `chat` entry in the roster. In that bot,
   create a **webhook routine**: "When this webhook fires, read the JSON payload and answer per POSTING.md §5 with
   `box/chat-reply.sh <message_id> -`. For `type: submission`, review per §6 with `box/submission-feedback.sh`."
2. The routine gives a **URL** and a **key**. Collect both through the secure form.
3. `CHAT_WEBHOOK_URL=… CHAT_WEBHOOK_KEY=… RENDER_API_KEY=… scripts/setup/set-webhook.sh`, then `wait-healthz.sh`.
4. Optional: to send submissions to a different bot (the Coach), give it its own webhook routine and pass
   `SUBMISSION_WEBHOOK_URL/KEY` too.

Other bots (Coach, Projects, Opportunities, News) are ordinary scheduled routines that post with `box/post.sh <id>`.
Point them at POSTING.md. The default roster is Coach, Projects, Opportunities, News and Chat. **Projects is optional**:
for a non-coding field, drop it from `bots` in kit.config.json (or `KIT_BOTS`) and don't create that bot.

## 6. Phone install
Send the student the app URL (`cat ~/.hey-studu/url`) and the password they chose.
- **iPhone (iOS 16.4+):** open the URL in **Safari** and sign in. Tap **Share**, then **Add to Home Screen**, then
  **Add**. Open the app **from the home screen icon** (push only works there), tap the bell or the notifications
  prompt, and choose **Allow**.
- **Android:** open the URL in **Chrome** and sign in. Use the menu (⋮), then **Install app** (or **Add to Home screen**).
  Open it, tap the bell, and choose **Allow**.

## 7. Push test
`scripts/setup/push-test.sh`. It prints `push.sent` = the number of devices reached. If that is 0, notifications are
not enabled yet (on iPhone, make sure the app was opened from the home screen icon).

## 8. Free-tier caveats
- **Render free sleeps after 15 min without traffic.** The next visit or bot call waits **30-60 s** while it wakes
  (cold start). To keep it awake 24/7, the student creates a free UptimeRobot account
  (https://dashboard.uptimerobot.com/sign-up) and adds an HTTP(s) monitor for `<app-url>/healthz` at the default
  5-minute interval. This is the main keep-awake: it runs on UptimeRobot's servers, so it keeps working when the
  bot computer pauses. `start-pinger.sh` (run by `deploy.sh`) is only a backup, because the bot computer pauses when
  idle and its pings stop. Box scripts also retry connect failures and HTTP 502/503/504 for ~90 s so a cold start does not drop a
  notification. Free Render gives **750 shared instance hours/month**; 24/7 uses ~744, so keep other free Render
  apps asleep (or on a different account) or you will run out mid-month.
- **Neon free** scales to zero when idle (wake-up takes under a second) and holds 0.5 GB. Uploads are capped at
  `UPLOADS_TOTAL_MB` (300).
- Free services have no persistent disk. Everything lives in Neon, so redeploys lose nothing.

## Troubleshooting
- Deploy failed: open the dashboard link printed by `render-create.sh`, then **Logs**. A missing `DATABASE_URL` or
  a bad Neon string shows up as `/healthz` with `db.ok:false`.
- Neon unreachable from the box over 5432: run `set-password.sh` with `PG_DRIVER=neon-ws` (WebSockets over 443).
- Wrong password everywhere: re-run `set-password.sh`.
- Rotated secrets: `gen-secrets.sh --rotate`, then `render-create.sh` (updates the vars). Phones must re-enable
  notifications after a VAPID rotation.
