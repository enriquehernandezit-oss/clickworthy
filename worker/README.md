# Clickworthy Worker

The background service: nightly lead sourcing (Google Places → filters → DB) and
per-restaurant enrichment (email discovery, hospitality-group check, Claude
Vision photo scoring, priority scoring). Runs as a **second Railway service** in
the same repo, sharing the Postgres database with the Next.js web app.

Queue + cron are provided by **pg-boss** (Postgres-backed) — no Redis needed.

## Local

```bash
# One-off run: source + enrich a small batch synchronously (best for testing)
bun run worker:once "Santo Domingo, Dominican Republic" 10

# Long-running service (cron + queue consumers), same as production
bun run worker
```

## Environment

| Var | Needed for | Notes |
|---|---|---|
| `DATABASE_URL` | everything | internal `${{Postgres.DATABASE_URL}}` on Railway |
| `GOOGLE_MAPS_API_KEY` | sourcing + photo fetch | Places API (New) enabled |
| `ANTHROPIC_API_KEY` | photo scoring, group check | |
| `NEVERBOUNCE_API_KEY` | email verification | |
| `WORKER_DRY_RUN` | optional | `true` caps volume, no outbound (there is no outbound in Phase 1 yet) |
| `WORKER_SOURCE_LIMIT` | optional | max restaurants per sourcing run (default 20) |
| `WORKER_TARGET_CITIES` | optional | semicolon-separated, e.g. `Santo Domingo, Dominican Republic; Santiago, Dominican Republic` |
| `WORKER_SOURCING_CRON` | optional | default `17 2 * * *` (local) |

## Railway setup (second service)

1. In the existing Railway project, **New → GitHub Repo** → pick the same
   `clickworthy` repo (or **Empty Service** linked to the repo).
2. **Settings → Deploy → Start Command:** `bun run worker`
   **Build Command:** `bun install`
3. **Variables:** add `DATABASE_URL = ${{Postgres.DATABASE_URL}}` (internal
   reference) plus the API keys above.
4. Deploy. The worker creates its own `pgboss` schema and queues on first boot
   and logs `[worker] up.` once the cron is scheduled.

> The web service keeps its own `railway.json` (`bun run start`). This worker
> service overrides the start command in its Railway settings instead, so the
> two services build from one repo without conflicting config files.
