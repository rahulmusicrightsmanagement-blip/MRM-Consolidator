# MRM-Consolidator – catalogue reconciliation app

Django API in `backend/` (port 8010), React + Vite in `frontend/`. Run with `./start.sh` (dev) or `docker compose up -d --build` (production; settings via `MRM_*` env vars, see `.env.example`).
Database: PostgreSQL only (`MRM_DATABASE_URL` in `.env`: the team's server; Neon also works); there is no SQLite.
Each query is a network round trip, so write in bulk and avoid per-row queries.
Backend tests: `cd backend && ../.venv/bin/python manage.py test catalogue` (uses a temporary `test_<dbname>` database on the same server). Frontend check: `cd frontend && npm run build`.

## Versioning – do this after every change

The app version is in `VERSION` (single source; the footer shows it as "MRM-Consolidator … vX.Y.Z").
At the end of every task that changes the app's code or behaviour, bump it once with:

```
scripts/bump-version.sh patch|minor|major "one line on what changed, in the user's words"
```

- **patch** (+0.0.1): bug fix, wording, styling, small tweak to an existing screen or export.
- **minor** (+0.1.0, patch resets to 0): a new feature – new button/action, new download, new screen, new society, new step.
- **major** (+1.0.0): only when the user asks, or a change breaks existing data/reports.

One bump per task (pick the biggest kind of change in it), not one per file edit. Do not bump for
changes that touch only docs, memory or tests. The script also updates `frontend/package.json` and
`CHANGELOG.md`. Rebuild the frontend (`npm run build`) so the footer shows the new number, and tell
the user the new version in the final message.
