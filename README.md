# hey studu kit

## What it is
A phone-first study app (PWA) for one student: lessons with quizzes, a roadmap, submissions with feedback, an inbox, and chat.
A small team of Grok Bots (Coach, Projects, Opportunities, News, Chat) posts to it and replies through push notifications.
It runs for free on Render + Neon. The **hey studu** setup bot deploys it for any student in any field.

## Start
- Deploy: [SETUP.md](SETUP.md) (accounts, keys, `scripts/setup/deploy.sh`, phone install)
- Branding and bot roster: [`kit.config.json`](kit.config.json) (env `KIT_*` overrides it)
- Content format: [CONTENT.md](CONTENT.md). Example content is in [`examples/`](examples/).
- Bots posting and replying: [POSTING.md](POSTING.md), scripts in [`box/`](box/)

## Layout
| Path | |
|---|---|
| `server.js` `auth.js` `chat.js` `study.js` `submissions.js` `uploads.js` `content.js` `context.js` `hook.js` | Express 5 app |
| `db.js` `store.js` | Postgres (Neon) storage, in-memory cache |
| `kit.js` + `kit.config.json` | per-student branding and bot roster |
| `public/` | PWA (vanilla JS, service worker, push) |
| `box/` | scripts the bots run on their box (token and URL come from `~/.hey-studu/`) |
| `scripts/setup/` | non-interactive deploy helpers for the setup bot |
| `examples/` | EXAMPLE roadmap, curriculum and lessons |
| `test/` | `e2e.sh` (app + box scripts) and `setup.sh` (setup scripts against a mock Render API). Both need a throwaway local Postgres. |

## Test
```bash
E2E_DATABASE_URL=postgres://u:p@127.0.0.1:5432/throwaway npm test          # app end to end
E2E_DATABASE_URL=postgres://u:p@127.0.0.1:5432/throwaway npm run test:setup
```
The tests DROP the app tables, so never point them at a real database.

MIT licensed.
