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
  - Alpaca free plan: IEX real-time quotes, a 30-symbol websocket, Benzinga news over REST and websocket; daily and pre-market bars from the SIP feed (free, 15 min delayed); dividends/splits from the corporate-actions API. The same account is the paper-trading sandbox later.
  - SEC EDGAR (free; fair access means at most 10 requests/sec and a declared User-Agent): 8-K, 10-Q, 10-K, S-1, S-3, 424B and Form 4 (insider buys/sells parsed from the XML).
  - Alpha Vantage `EARNINGS_CALENDAR` (free key, 25 requests/day; we make ≤ 2/day): the authority for earnings dates.
  - ForexFactory weekly JSON (unofficial, optional): USD High/Medium economic events. No HEALTH alert if it fails.
  - FRED, later.
- **Alerts:** email and, later, in-app/web push. **No SMS.** On Railway, email goes through **Resend's HTTPS API** (`RESEND_API_KEY`) because the Hobby plan blocks outbound SMTP; Gmail SMTP (app password, nodemailer) is the local fallback.
- **Emails:** instant alerts (`[AIA] ACTION/WARNING/REVIEW/REMINDER/HEALTH`), the **daily digest** after the close (`[AIA] DIGEST`), and the **weekday morning email** at 5:45 AM PT (`[AIA] MORNING`; a "weekend recap + week ahead" on the first trading day of the week, a short "market closed" version on holidays). Code: `apps/worker/src/morning/`.
- **Events** (`events` table) are maintained automatically, never by hand: a one-time seed from `data/seed/events.csv`; earnings from Alpha Vantage; dividends/splits from Alpaca; reminders from `date_reminder` rules; option expiries and estimated IPO lockups (first trading day + 180 days) derived from our data. Each row has a `source` and a unique `source_ref`; a changed date is recorded (`previous_date`, `history`), not overwritten. Precedence between sources is a pure function (`reconcileEvents` in `@aia/core`): a seeded event beats a derived/rule one within ±3 days; Alpha Vantage replaces an unconfirmed seeded earnings estimate within ±45 days; a confirmed seeded date absorbs Alpha Vantage's within ±3 days. Losers are kept as `superseded`. A future AI step can insert `source=ai_extracted` events, which require `confidence` and `source_url`. Market-wide economic events live in `econ_events`.
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
