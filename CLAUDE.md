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
  - Alpha Vantage `EARNINGS_CALENDAR` (free key, 25 requests/day; we make ≤ 2/day): the authority for earnings dates (holdings, watchlist and the pullback universe).
  - Twelve Data (free key, 8/min, 800/day): fallback quotes for the pullback screen only.
  - ForexFactory weekly JSON (unofficial, optional): USD High/Medium economic events. No HEALTH alert if it fails.
  - FRED, later.
- **Alerts:** email and, later, in-app/web push. **No SMS.** On Railway, email goes through **Resend's HTTPS API** (`RESEND_API_KEY`) because the Hobby plan blocks outbound SMTP; Gmail SMTP (app password, nodemailer) is the local fallback.
- **Emails:** instant alerts (`‼️ [AIA] ACTION`, `⚠️ WARNING`, `📝 REVIEW`, `💡 REMINDER`, `🩺 HEALTH`), the **daily digest** at 2:15 PM PT on trading days (`📊 [AIA] DIGEST Nov 16 · −2.5% · 4 alerts`), and the **weekday morning email** at 5:45 AM PT (`☀️ [AIA] MORNING …`; `🗓️` "weekend recap + week ahead" on the first trading day of the week; a "market closed" version on holidays). `📰 [AIA] NEWS` is reserved for Step 2. The digest and morning email share one section order: alerts → filings → headlines → prices (positions / pre-market) → levels to watch → still-active conditions → the rest.
- **Events** (`events` table) are maintained automatically, never by hand: a one-time seed from `data/seed/events.csv`; earnings from Alpha Vantage; dividends/splits from Alpaca; reminders from `date_reminder` rules; option expiries and estimated IPO lockups (first trading day + 180 days) derived from our data. Each row has a `source` and a unique `source_ref`; a changed date is recorded (`previous_date`, `history`), not overwritten. Precedence between sources is a pure function (`reconcileEvents` in `@aia/core`): a seeded event beats a derived/rule one within ±3 days; Alpha Vantage replaces an unconfirmed seeded earnings estimate within ±45 days; a confirmed seeded date absorbs Alpha Vantage's within ±3 days. Losers are kept as `superseded`. A future AI step can insert `source=ai_extracted` events, which require `confidence` and `source_url`. Market-wide economic events live in `econ_events`.
- **AI:** Claude API (API key, billed separately from the user's Claude Pro subscription).
  - Haiku: news triage
  - Sonnet: investigations and chat
  - Opus: rare deep dives
  - The heavy briefs stay on Pro scheduled tasks for now (hybrid).
  - Hard spend cap: $50/month.
- **Budget:** about $30–70/month all-in to start.

## Email design system (`packages/emails`)

- **React Email** (`@react-email/components`) templates rendered to HTML in the worker; every email also has a hand-written plain-text part built from the same props. Visual reference: `docs/email-mockup.html` (local only, gitignored: it holds real positions).
- **Layers:** a pure **view model** in the worker turns gathered data into JSON-safe props (`notify/digest-email.ts`, `notify/rule-alerts.ts`, `notify/health-alerts.ts`, `morning/render.ts`); the **templates** in `packages/emails/src/emails/` only lay props out. Put math and wording in the view model (unit-tested), not in components. Pure portfolio/headline logic lives in `@aia/core` (`portfolio.ts`, `headlines.ts`, `levels.ts`, `filings.ts`).
- **Components** (`packages/emails/src/components/`): `EmailShell`, `Header` (navy band; severity pill + large ticker for alerts), `KpiTiles`, `AttentionCard` (full or compact), `RangeBar`, `Pill`/`SeverityPill`, `PositionsTable`, `FilingsList`, `HeadlinesList`, `Footer`, plus `Section`, `Box` (gray / Plan) and `Note`.
- **Email-safe rules:** tables only, inline styles, 640px max, system fonts; no images, SVG, scripts or external CSS. Colors are tokens in `tokens.ts` (gain #16a34a, loss #dc2626, warning #d97706, review #2563eb, action #dc2626, reminder #7c3aed, muted #5b6577). Dark mode: `color-scheme: light`, `bgcolor` fallbacks, and the Gmail iOS blend fix on white header text. Phones (≤600px) hide secondary columns (`hide-sm`).
- **Size:** `renderHtml` refuses HTML over 90 KB (Gmail clips at ~102 KB); the digest falls back to a trimmed version (one-line cards, capped filings/headlines) instead of failing.
- **Every `.tsx` file starts with** `/** @jsxRuntime automatic @jsxImportSource react */` (tsx compiles files outside the worker without its tsconfig).
- **Previews:** `pnpm email:preview` (dev server on :3030; reads `.preview/<name>-props.json` written by the CLI, else the made-up samples in `packages/emails/preview/`). `pnpm collect digest|morning|alert --ticker T|health-email … [--html f] [--test-send]` writes HTML or emails a copy marked "(test)".
- **Tests:** snapshot tests per email type plus unit tests for the view models, with made-up tickers and numbers only (`notify/digest-fixture.ts`). Update snapshots with `pnpm vitest run -u` after an intended change.
- **Headlines (no AI yet):** dedupe by URL or near-identical title within 24 h; noise filter = `NOISE_PATTERNS` in `@aia/core` plus stories tagged with 5+ tickers; holdings ranked by holdings mentioned, then recency (digest 6, morning 6/10 on recap days); watchlist as one summary line.
- **Alerts' Plan box:** CONFIRMED rules show `plan_action` (seed-overrides `plan_action`, column `exit_rules.plan_action`), else a generic line from the rule; DRAFT/PLACEHOLDER say "review the position" and note when no exit rule is confirmed.

## Pullback opportunity screen (`apps/worker/src/pullbacks/`, `@aia/core` pullback*.ts)

- **Goal:** email as soon as a proven-profitable company pulls back hard. Email only (no push). Research only.
- **Universe:** top `sp500Top` S&P 500 by market cap + Nasdaq-100 (`config/universe/*.csv`, from `pnpm collect universe-refresh`; public data, committed) + core/extra lists in `config/pullbacks.json` + stock holdings and watchlist (from the DB at runtime). `exclude` removes duplicate share classes (GOOG).
- **Fundamentals (weekly, Sat 6:00 AM PT; on startup if stale):** SEC `companyfacts` → `fundamentals` (compact series) → `scorecards` (quality pass/fail + reasons). TTM = last annual + YTD − prior YTD. `predecessorCiks` merges history after a re-registration (XOM). Non-USD filers (IFRS) get ratios but no valuation multiples.
- **Checks:** Open 09:40 ET (until 11:00), Midday 12:30 ET, EOD right after the close check (official SIP closes; resets happen only here). Due-based, once per date (`job_runs` `pullback_open|midday|eod`). Live prices: Alpaca IEX latest trade (today only), Twelve Data fallback within its budget (`api_usage`).
- **Engine (pure, tested):** qualify (20% off high / −10% over 1–5 days / −7% day), tiers, `decidePullback` (first, deeper tier, one one-day-drop alert per day, no repeated tiers, reset on an EOD close < 15% below the high), gap-down label at the open, spin-off windows, exit levels (risk stop = max(52w low, price − 2×ATR14); valuation trim = median P/E × TTM EPS; re-underwrite = next earnings).
- **State and output:** `pullback_state` (per ticker), `pullback_observations` (every ticker at every check; the shared output). First EOD with empty state = silent baseline + one starting-list email. Export: `pnpm collect pullback-export` or `GET /pullbacks.json|csv` (worker HTTP server, `PULLBACK_EXPORT_TOKEN`).
- **Emails:** one per ticker, or one combined above `maxSeparateEmails` (5); digest and morning email have a "Pullback screen" section (`pullbacks/summary.ts`). Bull evidence is numbers-only. A rule alert on the same ticker that day suppresses the pullback one-day-drop alert.
- **V2:** `pullbacks/researcher.ts` is the interface for the Claude story check; it must never decide qualification or state.

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
