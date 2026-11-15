# AI Investment Analyst: Claude Code context

Personal AI investment research assistant for one user. Research and alerts only: **no trading and no brokerage order code** until Phase 6 (live trading, only with explicit per-order approval).

## Where we are

- **Phase 1 (live):** runs inside a claude.ai Project, "AI Investment Analyst". Scheduled tasks write the morning, after-market and weekly briefs, using project files (holdings.md, positions.csv, watchlist.csv, research_journal.csv).
- **Phase 2/3 (this repo):** an always-on app that collects market data, checks exit rules in code, triages news and sends alerts.

## Decisions (2026-11-13/15)

- **Hosting:** Railway, one project with:
  - `apps/worker`: always-on Node process
  - `apps/web`: Next.js, comes later
  - Postgres
- **Data:**
  - Alpaca free plan: IEX real-time prices, a 30-symbol websocket, Benzinga news over REST and websocket. The same account is the paper-trading sandbox later.
  - SEC EDGAR (free; fair access means at most 10 requests/sec and a declared User-Agent).
  - FRED, later.
- **Alerts:** email (Gmail with an app password, via nodemailer) and in-app/web push. **No SMS.**
- **AI:** Claude API (API key, billed separately from the user's Claude Pro subscription).
  - Haiku: news triage
  - Sonnet: investigations and chat
  - Opus: rare deep dives
  - The heavy briefs stay on Pro scheduled tasks for now (hybrid).
  - Hard spend cap: $50/month.
- **Budget:** about $30–70/month all-in to start.

## Build order

1. **Step 1 (now): collect and check, in plain code, no AI.** Spec: `docs/STEP1.md`.
2. Step 2: Haiku triage of news and filings, with importance scores.
3. Step 3: Sonnet/Opus investigations as a tool-using agent; reports saved with sources.
4. Step 4: Next.js app (dashboard, briefs, alerts inbox, chat) and web push.
5. Step 5: run alongside the Pro scheduled tasks; retire the intraday, overnight and position-monitor tasks first.

## Engineering rules

- TypeScript (strict), Node 22, pnpm workspaces, Drizzle ORM with Postgres, zod at every external boundary, vitest.
- Exit rules and screeners are **pure functions with unit tests**. The LLM explains alerts; it never decides whether a rule fired.
- Every external call needs a timeout, a retry with backoff, and must respect rate limits. Log each job run to `job_runs`.
- Store timestamps in UTC; show them in America/Los_Angeles. Use the market calendar for holidays and early closes.
- No duplicate alerts: every alert carries a `dedupe_key`, plus a cooldown.
- Secrets live only in `.env` (gitignored) or Railway variables. Never commit keys, account numbers or personal holdings data (`data/seed/` is gitignored).
- Never fabricate data. If a feed is missing or stale, record that and alert on the feed's health instead.
