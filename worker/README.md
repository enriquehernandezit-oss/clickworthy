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
| `ANTHROPIC_API_KEY` | scoring, group check, email copy | |
| `NEVERBOUNCE_API_KEY` | email verification | |
| `CLAID_API_KEY` | free-sample enhancement | shared with the web app |
| `GMAIL_SENDER` | sending + reading outreach | `mail@clickworthytool.com` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Gmail auth | full service-account JSON key, one line (see below) |
| `OUTREACH_ENABLED` | **live sending switch** | `true` to actually send cold email; anything else = log-only |
| `OUTREACH_POSTAL_ADDRESS` | CAN-SPAM footer | real business mailing address |
| `APP_ORIGIN` | magic-link URLs | e.g. `https://clickworthytool.com` |
| `RESEND_API_KEY` | operator alerts + weekly report | shared with the web app |
| `ALERT_EMAIL_TO` | who gets alerts/reports | your inbox |
| `ALERT_EMAIL_FROM` | alert sender | default `alerts@clickworthytool.com` (verify the domain in Resend) |
| `WORKER_DRY_RUN` | optional | `true` = log-only everywhere |
| `WORKER_SOURCE_LIMIT` | optional | max restaurants per sourcing run (default 20) |
| `WORKER_TARGET_CITIES` | optional | semicolon-separated; default `Miami, FL; New York, NY; Chicago, IL; Los Angeles, CA` |
| `WORKER_SOURCING_CRON` / `WORKER_SEND_CRON` / `WORKER_REPLY_POLL_CRON` | optional | cron overrides |

### Gmail service account (one-time, Enrique's Workspace)

Cold outreach is sent from `mail@clickworthytool.com` via a service account (not
Resend — Resend's AUP forbids cold email; Gmail is also the Lemwarm-warmed mailbox).

1. **GCP** → create a project → enable the **Gmail API** → create a **service
   account** → add a **JSON key** (download it).
2. **Workspace Admin** → Security → API controls → **Domain-wide delegation** →
   add the service account's **Client ID** with scopes:
   `https://www.googleapis.com/auth/gmail.send`,
   `https://www.googleapis.com/auth/gmail.readonly`
3. Set `GMAIL_SENDER=mail@clickworthytool.com` and paste the JSON key as
   `GOOGLE_SERVICE_ACCOUNT_JSON` (single line).

Until these are set, sending/reading are disabled and the worker logs what it
*would* do — safe to run.

### Admin review (web app, not worker)

The `/admin` page (Basic Auth via `ADMIN_USER` / `ADMIN_PASSWORD` on the **web**
service) shows the free-sample review queue. Approving a sample flips it to
`approved`; the worker's Touch 2 job then emails it. Nothing reaches a prospect
without a click here.

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
