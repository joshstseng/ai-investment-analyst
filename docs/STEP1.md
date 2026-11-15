# Step 1: Collect and check (no AI)

Goal: an always-on worker that collects prices, news and SEC filings for my holdings and watchlist into Postgres, checks my exit rules on a closing basis, and emails me when a rule fires. It runs locally first, then on Railway.

## Repo layout

```
apps/worker/            always-on process: scheduler, collectors, rule checks, notifier
packages/db/            Drizzle schema, migrations, seed importer
packages/core/          pure logic: rules engine, market calendar helpers, types
data/seed/              (gitignored) holdings.md, positions.csv, watchlist.csv exported from the claude.ai project
docker-compose.yml      local Postgres
.env.example            ALPACA_KEY_ID, ALPACA_SECRET, DATABASE_URL, SEC_USER_AGENT, GMAIL_USER, GMAIL_APP_PASSWORD, ALERT_EMAIL_TO
```

## Milestones

1. **Scaffold.** pnpm workspace, TS strict, eslint/prettier, vitest, docker-compose Postgres, `.env.example`, `.gitignore`.
2. **Schema** (Drizzle):
   - `accounts`
   - `holdings`: account, ticker, qty, cost_basis, instrument (stock/etf/option with strike and expiry)
   - `exit_rules`: holding_id, type, params jsonb, status CONFIRMED/DRAFT
   - `watchlist`
   - `prices_daily`, `quotes_latest`
   - `news_items`: source id, headline, summary, url, symbols[], published_at, received_at, hash
   - `filings`: cik, ticker, form, items, filed_at, url, accession
   - `rule_evaluations`
   - `alerts`: severity, dedupe_key, body, sent_at, channel
   - `job_runs`
3. **Seed importer.** Parse `data/seed/holdings.md`, `positions.csv` and `watchlist.csv` into the tables. Inspect the real files first, then write a parser with tests. Re-running it must not create duplicates.
4. **Alpaca collector:**
   - market calendar and clock
   - daily bars backfill (1 year) for holdings, watchlist, SPY and QQQ
   - latest quotes every 5 minutes during market hours
   - news: REST backfill, then the websocket stream with reconnect and backoff
   - Store with `received_at` so feed latency can be measured.
5. **EDGAR collector.** Map tickers to CIKs (company_tickers.json); poll submissions every 10 minutes; store new 8-K/10-Q/10-K/S-1/424B and the 8-K item codes. Use a declared User-Agent and stay at or under 10 requests/sec.
6. **Rules engine** (packages/core, pure functions and table-driven tests). Rule types:
   - `stop_close_below`, with a `warn_close_at_or_below` option
   - `take_profit_at_or_above` (high or close)
   - `trailing_close_pct_from_high` (from a start date)
   - `day_move_pct` (default ±7% for stocks)
   - `etf_drawdown_from_52w_high` (10/15/20% tiers)
   - `new_52w_low`
   - `close_below_cost` (first crossing only)
   - Options holdings: evaluate on the underlying and label it that way.
7. **Scheduler** (croner, America/Los_Angeles, holiday-aware):
   - news stream: always on
   - quotes: every 5 minutes in market hours
   - EDGAR: every 10 minutes from 5 AM to 9 PM PT
   - close check: 1:20 PM PT (1 hour after an early close)
   - bars refresh: 2:00 PM PT
   - feed health check: hourly
8. **Notifier.** Gmail (nodemailer) email for alerts at warn level and above, with a dedupe_key and cooldown. Send a daily digest email for anything below warn. Alert on feed outages.
9. **Deploy.** Railway: a worker service and Postgres, with the env vars set; confirm that it survives restarts.

## Done when

- The seed import matches holdings.md exactly: tickers, quantities, cost bases, both accounts.
- Unit tests pass for every rule type, including edge cases (exactly at the level, missing bar, holiday, early close).
- A fake bar that breaches a stop sends exactly one email, and re-running the check doesn't send another.
- News and filings for holdings arrive with their tickers attached, and duplicates are dropped.
- The worker runs 24 hours on Railway with job_runs logged, and recovers from a dropped websocket.
- No secrets are in git.

## Not in Step 1

Any LLM call, the web UI, push notifications (they come with the web app), and anything that touches a brokerage or trading.
