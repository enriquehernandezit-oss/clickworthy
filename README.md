# Clickworthy

Photo enhancement for independent US restaurants (Miami, New York, Chicago, LA).
We enhance a restaurant's **real** dish photos — we never generate food.

Two revenue paths:

- **Self-serve one-time photos** — what the public landing page sells. Upload,
  pay per photo ($3.00 → $1.80 sliding), get them back. → `/enhance`
- **High-ticket packages** — sold *only* through cold outreach, never shown
  publicly: Menu Glow-Up $499 · Grand Opening $899 · Always Fresh $249/mo.

## Docs

| File | What's in it |
|---|---|
| [PIPELINE.md](PIPELINE.md) | How the whole system works, end to end |
| [HANDOFF.md](HANDOFF.md) | Current status, what's still needed to go live |
| [AGENTS.md](AGENTS.md) | Conventions for AI coding agents in this repo |
| [.env.example](.env.example) | Every environment variable, annotated |
| [worker/README.md](worker/README.md) | Worker deploy + env setup |

## Running locally

Requires [Bun](https://bun.sh) and a Postgres database.

```bash
bun install
```

Copy `.env.example` to `.env.local` and fill in what you have — the app runs
without most keys (features that need a missing key fail soft and log).

```bash
bun run dev
```

The worker is a separate process:

```bash
bun run worker
```

Useful flags: `WORKER_DRY_RUN=true` logs what the worker *would* send without
sending. Cold outreach is additionally gated behind `OUTREACH_ENABLED=true`, so
it stays off until you deliberately turn it on.

## Stack

Next.js 16 (App Router) · TypeScript · Bun · PostgreSQL + Drizzle · pg-boss
(Postgres-backed queue/cron, no Redis) · Tailwind v4 · Claid.ai · Claude Sonnet ·
Gmail API · Stripe · Resend · NeverBounce · Google Places · Cloudflare R2.

Deployed on **Railway** as two services from this one repo: `web` (Next.js) and
`worker` (start command `bun run worker`).

## Admin

`/admin` — behind HTTP Basic Auth (`ADMIN_USER` / `ADMIN_PASSWORD`). Fails closed
if either is unset. Seven tabs: an overview with a live activity feed, a lead
browser with per-restaurant detail pages, **approve/redraft/skip cold-email
drafts before they send**, edit and approve free samples, finish and deliver paid
orders, manage the do-not-contact list, and a Controls tab (pause switch,
approval↔autosend toggle, worker health, run-any-job-now). See
[PIPELINE.md](PIPELINE.md) for the full approval flow.
