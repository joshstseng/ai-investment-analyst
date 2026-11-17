# AI Investment Analyst

A personal research assistant for one investor: it collects market data, checks exit rules in
plain code, screens for pullbacks in quality companies, and emails alerts, a daily digest and a
morning brief. **Research and alerts only: there is no trading or order code.**

## How it's built

```
apps/worker        always-on Node 22 process (Railway): collectors, rule checks, scheduler, emails
packages/core      pure logic + unit tests: rule engine, alert policy, fundamentals, pullback engine
packages/db        Drizzle ORM schema, migrations, seed importer (Postgres)
packages/emails    React Email templates and components (digest, morning, alerts, health, pullbacks)
config/            pullback screen config and index lists (ships with the worker)
data/seed/         your holdings and rules (gitignored: never committed)
```

Data sources: Alpaca (SIP daily bars 15-min delayed, IEX real-time trades, Benzinga news,
corporate actions), SEC EDGAR (filings, Form 4, XBRL company facts), Alpha Vantage (earnings
calendar), ForexFactory (economic calendar), Twelve Data (fallback quotes).

## Setup (local)

```sh
pnpm install
cp .env.example .env          # fill in the keys (see the comments in the file)
pnpm db:up                    # Postgres in Docker
pnpm db:migrate
pnpm seed                     # imports data/seed/ (holdings.md, positions.csv, watchlist.csv, ...)
pnpm worker                   # or run single jobs with `pnpm collect …`
```

Checks: `pnpm check` (typecheck, lint, format, tests). Database tests only run against a local
database.

## Emails

| Email           | When (Pacific)                                   | Subject                                                  |
| --------------- | ------------------------------------------------ | -------------------------------------------------------- |
| Morning brief   | 5:45 AM, weekdays                                | `☀️ [AIA] MORNING …` (`🗓️` weekly recap)                 |
| Rule alerts     | after the close check (~1:20 PM)                 | `‼️ ACTION` · `⚠️ WARNING` · `📝 REVIEW` · `💡 REMINDER` |
| Pullback alerts | Open (6:40 AM), Midday (9:30 AM), EOD (~1:20 PM) | `📝 [AIA] REVIEW Pullback opportunity – …`               |
| Daily digest    | 2:15 PM, trading days                            | `📊 [AIA] DIGEST …`                                      |
| Feed health     | when a feed fails or recovers                    | `🩺 [AIA] HEALTH …`                                      |

Preview any email with real data: `pnpm collect digest|morning --html out.html`,
`pnpm collect alert --ticker T --html f`, `pnpm collect pullback-preview --symbols A,B --html f`,
or add `--test-send` to email yourself a copy marked "(test)". `pnpm email:preview` starts the
React Email dev server.

## Pullback opportunity screen

Finds proven-profitable companies that have pulled back hard and emails as soon as it happens.

- **Universe:** the 100 largest S&P 500 members by market cap, the Nasdaq-100, core names and
  extras from `config/pullbacks.json`, plus your stock holdings and watchlist. Refresh the index
  lists with `pnpm collect universe-refresh` (writes `config/universe/*.csv`; commit them).
- **Quality filter (weekly, Saturdays):** SEC XBRL company facts → GAAP net income > 0 in each of
  the last 3 fiscal years and TTM, free cash flow > 0 TTM, revenue growth ≥ 0 y/y, market cap ≥
  $10B. Holdings and watchlist are always checked and flagged when they fail. Scorecard: revenue
  TTM / growth / 3-yr CAGR, margins, FCF, net cash, dilution, P/E and P/FCF vs their own 5-yr
  medians. `pnpm collect fundamentals`, `pnpm collect scorecard`.
- **Three checks per trading day** (New York time): Open 09:40 (gap-downs vs the previous close),
  Midday 12:30 (live IEX trades, Twelve Data fallback), EOD after the close check (official closes;
  the source of truth for resets).
- **Qualifies:** ≥ 20% below the 52-week high, or down ≥ 10% over 1–5 days, or down ≥ 7% on the
  day. Tiers −20/−25/−30/−35%. Alerts when a ticker first qualifies, reaches a deeper tier, or
  has a new ≥ 7% one-day drop (once per ticker per day); tiers never repeat; state resets only on
  a close less than 15% below the high. Spin-offs restart the 52-week window at the ex-date.
- **First run:** a silent baseline at the first EOD check, then one "starting list" email.
- **Shared output:** every check is stored in `pullback_observations`;
  `pnpm collect pullback-export [--format csv] [--out f]`, or
  `GET /pullbacks.json|csv` on the worker with `Authorization: Bearer $PULLBACK_EXPORT_TOKEN`.
- **V2 hook:** `apps/worker/src/pullbacks/researcher.ts` defines the AI story check (cause of the
  drop with sources, earnings power, bull/bear case, staged entry, exit plan); not built yet.

All thresholds, check times and lists are in `config/pullbacks.json`. Each run is logged to
`job_runs` (check, screened, qualifiers, emails queued, sources, missing prices, API errors and
rate-limit retries).

## Environment variables

See `.env.example`. Secrets live only in `.env` (gitignored) or Railway variables. Required:
`DATABASE_URL`, `ALPACA_KEY_ID`, `ALPACA_SECRET`, `ALERT_EMAIL_TO` and an email transport
(`RESEND_API_KEY`, or Gmail SMTP locally). Optional: `SEC_USER_AGENT` (EDGAR; required for
fundamentals), `ALPHAVANTAGE_API_KEY`, `TWELVEDATA_API_KEY`, `PULLBACK_EXPORT_TOKEN`.

## Deploy (Railway)

One worker service (Dockerfile) plus Postgres. Migrations run on startup. Push to `main` to
deploy. Seed data never ships: run `pnpm seed` against Railway's database from your machine
(`DATABASE_URL="$RAILWAY_DB" pnpm seed`).
