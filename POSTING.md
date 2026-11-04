# Posting to the study app: guide for bots

The student reads your posts on their phone. Each post gets its own page with reading typography, and the inbox
list shows only **bot · title · first line**. Write for a small screen and a quick scan.

All bots share the same box, so they share the per-install config in `~/.hey-studu/` (`url`, `post-token`,
`content-dir`). Use the scripts in `box/` of the kit checkout (below: `$KIT/box`), never raw curl with the token.
The first call after the app slept (free Render plan) can take 30-60 s; the scripts wait.

## 1. Title
- Short and specific, **under 60 characters**. No bot name (the app shows it), no emoji spam, no trailing period.
- Good: `Lesson 3: active recall`, `New scholarship: deadline 20 Nov`, `Review: week plan`
- Bad: `Update from your coach about your progress on the roadmap today!!!`

## 2. Body (markdown)
```markdown
One-line summary of what this is and what the student should do. (This line is the list preview.)

## What to do
- First concrete action
- Second action, with `code` or a file name if relevant

## Steps
1. Do this
2. Then this

## Why
One or two short sentences on why it matters for the roadmap.

## Links
- [Short link label](https://example.com)
```
Rules:
- **First line = summary**: one plain sentence, no heading. It becomes the preview.
- `##` for sections (`###` below that), 2-5 bullets each. Blank line around lists, headings and code blocks.
- `- item` bullets, `1. item` steps, indent 2-3 spaces to nest. Fenced code blocks with a language; inline `code`.
- `> **Tip:** ...` renders as a callout. Narrow tables (`| a | b |` + `|---|---|`) work.
- Links as `[label](https://...)`, collected under `## Links`. The JSON `link` field (4th arg of post.sh) becomes an
  "Open link" button for the one main link.
- `**bold**`, `*italic*`, `~~strike~~`, `---`. No raw HTML (shown as text).
- Times in the kit's timezone (`timezone` in kit.config.json; it is also `context.tz`). Dates like `20 Nov 2026`.
- One post per topic; don't repeat what is already in the inbox.

## 3. How to post
`post.sh <bot> <title> <body | -> [link]`. `<bot>` is your id from the `bots` roster in kit.config.json (for
example `coach`, `projects`, `opportunities`, `news`); the app shows its display name and color. Pass the body on
stdin with `-` and a **quoted** heredoc so `$`, backticks, quotes and backslashes are safe:
```bash
"$KIT/box/post.sh" coach "Lesson 3: active recall" - "https://example.com/recall" <<'MD'
Today you test yourself instead of re-reading.

## What to do
- Open lesson 3 in the app
- Answer the two quiz questions
MD
```
Response: `201 {"ok":true,"message":{"id":N,...},"push":{"sent":1,...}}`. The message page is `$(cat ~/.hey-studu/url)/m/N`.
Never print or paste the token.

Reads: `"$KIT/box/api-get.sh" /api/<path>` adds the token. Useful: `/api/context`, `/api/progress`, `/api/messages`
(`?bot=coach`), `/api/chat`, `/api/lessons/<id>`, `/api/opps`, `/api/curriculum`.

## 4. Content files
`curriculum.json`, `roadmap.md`, `opportunities.md`, `LESSONS.md` and `lessons/<id>.md` live in the content folder
(`cat ~/.hey-studu/content-dir`, default `/workspace/study`). Edit them there; `content-sync.sh` (running under
pm2 as `hey-studu-sync`) pushes a change to the app within about 60 s. Formats: CONTENT.md.

## 5. Chat bot (webhook)
The chat bot is woken by a webhook routine (POST, `Authorization: Bearer <key>` and `X-Automation-Key: <key>`) with:
```json
{"type":"chat","conversation_id":"main","message_id":17,"text":"is this right?",
 "attachments":[{"name":"notes.png","type":"image/png","size":48213,"url":"https://<app>/uploads/u_ab12/notes.png","api_path":"/uploads/u_ab12/notes.png"}],
 "context":{
   "generated_at":"2026-01-10T15:14:17.330Z","tz":"UTC",
   "student":{"name":"Sam","field":"biology"},
   "progress":{"lessons_done":1,"lessons_total":2,"xp":30,"streak":1,"best_streak":1,"active_today":true},
   "current_lesson":{"id":"ex-plan-your-week","n":2,"title":"Plan your week","month":"Month 1","unit":"Study habits"},
   "next_lessons":[],
   "deadlines":[{"name":"Example scholarship","slug":"example-scholarship","kind":"deadline","date":"2026-01-20"}],
   "recent_updates":[{"from":"Coach","title":"Lesson 2 is open","date":"2026-01-10"}],
   "recent_chat":[{"id":11,"role":"student","at":"…","text":"…"},{"id":12,"role":"bot","at":"…","text":"… (cut at 160 chars)","files":["notes.png"]}],
   "last_submission":{"id":"…","lesson_id":"ex-plan-your-week","lesson_title":"Plan your week","status":"reviewed","at":"…","has_feedback":true,"files":0},
   "roadmap_position":"…the \"Current position\" section of roadmap.md, cut to 400 chars…"}}
```
- `attachments` is always an array (maybe empty); `text` can be `""` if only files were sent. Fetch a file with
  `"$KIT/box/fetch-upload.sh" <api_path> [out]` (prints the local path), then view or read it.
- **`context` is built fresh on every send: answer from it and skip extra reads.** `deadlines` = next 3 dated
  opportunities (`kind`: `deadline`, `event`, `event ends`; app link `/opps/<slug>`). `recent_updates` = last 3 inbox
  posts. `recent_chat` = last 6 turns before this message. Any field can be `null`/`[]`; `context` itself is `null`
  if building it failed. Same JSON: `api-get.sh /api/context`.
- Reply: `"$KIT/box/chat-reply.sh" <message_id> - <<'EOF' … EOF` (prints `ok`).
- The app shows "<Chat name> is typing…" until the reply arrives. After 3 minutes it offers Retry, which re-sends the
  **same `message_id`** with fresh context: treat a repeat as the same question and answer once.
- The reply push is skipped while the student has the chat open.

## 6. Lesson submissions (feedback bot)
Lessons with a ```` ```submit ```` block (CONTENT.md) get a "Your work" box. Each send is stored in the app and
POSTed to `SUBMISSION_WEBHOOK_URL` if set, else to the chat webhook:
```json
{"type":"submission","lesson_id":"ex-plan-your-week","lesson_title":"Plan your week",
 "submission_id":"20260110-153012-a1b2","text":"Mon: …","attachments":[{"name":"plan.pdf","type":"application/pdf","size":1234,"url":"…","api_path":"/uploads/…"}]}
```
`text` keeps the student's whitespace exactly.
- List waiting work: `api-get.sh '/api/submissions?status=sent'` (also `&lesson=<id>&limit=N`; returns
  `{total, submissions}` newest first). One: `api-get.sh /api/submissions/<id>`. Per lesson:
  `/api/lessons/<id>/submissions`. Status is `sent`, `undelivered` or `reviewed`.
- Send feedback (markdown); it shows under the submission and marks it *Reviewed*:
  ```bash
  "$KIT/box/submission-feedback.sh" 20260110-153012-a1b2 - <<'EOF'
  Good plan. One thing: …
  EOF
  ```
  The student gets a push "<feedback bot>: feedback on <lesson>" unless they have that lesson open.
  `NO_PUSH=1` saves without a push; `BY=Name` changes the shown reviewer.
