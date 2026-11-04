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

Frontmatter `title`, `unit`, `minutes`, `xp` (default 20), then normal Markdown (headings, lists, tables,
callouts, code). Fenced code gets a label, copy button and highlighting for python, bash/sh, js/ts, powershell.

Quiz: one ` ```quiz ` fence per question, with keys `question:`, optional `lang:` + `code: |` (indent 2 spaces),
`A:`..`D:` (2-4 options), `answer:` (letter), `explain:`. 3-5 questions per lesson works well.

Work box: a ` ```submit ` fence (keys `prompt:`, optional `placeholder:`) shows a **"Your work"** box: a
textarea plus attachments (images and common text/code/pdf files, 10 MB each, 5 per submission). Each send
becomes a submission in the app database and is posted to the submission webhook (or the chat webhook).
The coach answers with `box/submission-feedback.sh <submission_id> -`. See POSTING.md.

## XP and streak
First completion: `xp` + 5 per correct quiz answer. Retakes only add xp for a better score.
Streak: consecutive days (in `timezone` from kit.config.json) with any quiz answer or completion.

## opportunities.md
A Markdown table. Columns are matched by name: `Name`, `Link`, `Deadline/Date`, `Category`, `Status`, `Notes`.
A `## Watchlist` section is shown separately. Dates like `20 Nov 2026` or `6–8 Nov 2026` are parsed;
cells with "deadline", "due", "apply", "closes" are treated as deadlines. Status `expired`/`closed` hides a row.
