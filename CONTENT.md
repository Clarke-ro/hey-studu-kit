# Content format (roadmap, curriculum, lessons, opportunities)

The app does not read files from disk. A bot's box keeps the files in one content folder
(default `/workspace/study`; set `STUDY_CONTENT_DIR` or `~/.hey-studu/content-dir`) and
`box/content-sync.sh` pushes every changed file to the app within about a minute (it runs under pm2).
The app shows the change on its next load. No restart or deploy needed.

| File | Usual owner | Purpose |
| --- | --- | --- |
| `roadmap.md` | coach | The plan. `## Current position` is sent to the chat bot as context. |
| `curriculum.json` | coach | Months → units → lessons, in path order |
| `lessons/<id>.md` | coach | One lesson: text, exercises, quiz, optional work box |
| `opportunities.md` | opportunities | Table shown on the Opps tab (read-only in the app) |
| `LESSONS.md` | coach | Optional: your own notes on this format (also synced) |

Only these names are synced. Anything else in the folder is ignored. See `examples/` for a working set.

## curriculum.json

```json
{
  "version": 1,
  "months": [
    { "id": "m1", "title": "Month 1", "name": "Foundations", "color": "#6366f1", "icon": "🧭",
      "units": [
        { "id": "m1-basics", "title": "Basics", "icon": "📚",
          "lessons": [ { "id": "m1-first-lesson", "title": "First lesson", "minutes": 30 } ] }
      ] }
  ]
}
```

- **Order is the path.** The current lesson is the first one not completed.
- `id` is a slug (`a-z`, `0-9`, `-`) and the lesson's filename. Don't rename the id of a completed lesson (progress is keyed by id).
- A lesson with no `.md` file shows as "Coming soon".

## lessons/<id>.md

Frontmatter `title`, `unit`, `minutes`, `xp` (default 20); for Module tests also `type: test` and `pass_mark: 70`. Then normal Markdown (headings, lists, tables,
callouts, code). Fenced code gets a label, copy button and highlighting for python, bash/sh, js/ts, powershell.

Quiz: one ` ```quiz ` fence per question, with keys `question:`, optional `lang:` + `code: |` (indent 2 spaces),
`A:`..`D:` (2-4 options), `answer:` (letter), `explain:`. 3-5 questions per lesson works well.

Work box: a ` ```submit ` fence (keys `prompt:`, optional `placeholder:`) shows a **"Your work"** box: a
textarea plus attachments (images and common text/code/pdf files, 10 MB each, 5 per submission). Each send
becomes a submission in the app database and is posted to the submission webhook (or the chat webhook).
The coach answers with `box/submission-feedback.sh <submission_id> -`. See POSTING.md.


## Module tests (`type: test`)

A **module** is a **unit** in `curriculum.json` (e.g. `m1-terminal`), not a whole month. Put one **Module test** as the **last lesson of each unit**. Until it is passed, the next unit stays locked on the path.

Frontmatter:

```yaml
---
title: Terminal basics — Module test
unit: m1-terminal
minutes: 90
xp: 50
type: test
pass_mark: 70
---
```

- `type: test` — **Module test** badge on the path and Lessons list.
- `pass_mark:` — overall pass threshold (default 70). Coach decides pass/fail.

Body: **Objective** = ` ```quiz ` blocks (≥ **3 per lesson in the unit**, ≥ **10** total; auto-scored; score shown, lesson not completed). **Practical** = one ` ```submit ` block graded by Coach (0–100).

**Scoring:** overall = **40% objective + 60% practical**; pass if ≥ `pass_mark` (70). Complete only when Coach's review marks **passed** (`**Passed**` / `**Failed**`, or `PASSED=1|0` and optional `SCORE=<practical>` on `box/submission-feedback.sh`). XP on first pass. Do not invent test content here — Coach writes it; add the lesson id as the unit's last entry in `curriculum.json` when ready.

## XP and streak
First completion: `xp` + 5 per correct quiz answer. Retakes only add xp for a better score.
Streak: consecutive days (in `timezone` from kit.config.json) with any quiz answer or completion.

## opportunities.md
A Markdown table. Columns are matched by name: `Name`, `Link`, `Deadline/Date`, `Category`, `Status`, `Notes`.
A `## Watchlist` section is shown separately. Dates like `20 Nov 2026` or `6–8 Nov 2026` are parsed;
cells with "deadline", "due", "apply", "closes" are treated as deadlines. Status `expired`/`closed` hides a row.
