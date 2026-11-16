# Decisions log (Step 1)

Decisions made while building Step 1 that later milestones must follow. Newest last.

## 2026-11-15: seed data and rules

- **Rules attach to instruments, not lots.** One rule covers every lot in both accounts. Holdings are one row per lot.
- **Missing values** ("NEEDS USER INPUT") are stored as NULL and listed in the row's `needs_input` array; DB checks reject unflagged NULLs.
- **Personal rule decisions** live in `data/seed/seed-overrides.json` (gitignored), not in code. `pnpm seed` is idempotent and verifies the DB against holdings.md.
- **Alert labels by status:** every status sends alerts. CONFIRMED = "action per plan"; DRAFT/PLACEHOLDER = "review". Alerts are held back only when a rule needs data we don't have.
- **Typed PLACEHOLDER rules are real, checkable rules:** the default ±7% one-day move for every held stock (a wider ±10% where seed-overrides.json sets it) and the 10/15/20% drawdown tiers for every held ETF.
- **Rules to write** (no rule type and no judgment text, e.g. positions.csv "DRAFT PENDING" cells) never fire. They are listed in a **weekly** "rules to write" section of the digest, not daily. See `isRuleToWrite` in `@aia/core`.
- **`alert_note`** on a rule is included in every alert it sends (e.g. a condition the price check cannot see). `notes` is internal and is not shown in alerts.
- **Take-profit `valid_until`:** the rule stops firing after that date (e.g. a spike rule that only applies until a results date).
- **`date_reminder`** rules fire once on their date with the alert_note as the text (e.g. a year-end tax decision).

## 2026-11-15: market data coverage

- **No data source is not a failure.** Symbols Alpaca has no data for (e.g. an OTC-only stock) and option contracts (no option prices collected in Step 1) are recorded in `symbol_data_status` as `no_data_source` and reported as "not checked: no data source". Rules on an option's underlying still run on the underlying's bars.

## 2026-11-15: rule semantics and alert escalation

- **ETF drawdown** is measured from the intraday 52-week high to the **close** (not the intraday low).
- **Rules are stateless:** a rule reports "fired" every day its condition holds. Alert state lives in milestone 8:
  - alert on the **first fire**;
  - then only on **escalation**: a new drawdown tier, warning → breach (stop), or a further **2%+ move** past the level;
  - **reset** once the condition clears (the next fire is a first fire again);
  - still-active conditions are listed in the **daily digest**.

## 2026-11-15: scheduler

- All schedules are in America/Los_Angeles and holiday-aware via `market_calendar`.
- **Close check** runs 20 min after a regular close (1:20 PM PT) and 60 min after an early close (11:00 AM PT). It is "due"-based (checked every 5 min) so restarts never skip or repeat a session. It refreshes bars itself before evaluating.

## 2026-11-15: email subjects

- Every subject starts with `[AIA]` and a tag: ACTION (CONFIRMED breach / trailing stop / take-profit / time stop), WARNING (CONFIRMED warning level), REVIEW (DRAFT/PLACEHOLDER rule alerts only), REMINDER (date reminders), HEALTH (feed failure/recovery), DIGEST (daily digest, e.g. `[AIA] DIGEST Mon, Nov 16: 3 active conditions`).

## 2026-11-15: email transport on Railway

- Railway's Hobby plan blocks outbound SMTP (ports 25/465/587), so Gmail SMTP times out there. **Email goes through Resend's HTTPS API when `RESEND_API_KEY` is set** (Railway); Gmail SMTP stays as the fallback when it isn't (local runs).
- Without a verified domain, Resend sends from `onboarding@resend.dev` and only to the Resend account's own email, so `ALERT_EMAIL_TO` must be that address.
- Each send carries an idempotency key derived from the alert's `dedupe_key`, so a retry after a lost response can't produce a duplicate.
- Sending never blocks other jobs: alerts are queued, then sent in the background; a send pass stops at its first failure and passes never overlap.

## 2026-11-16: morning email, events and new data sources

- **Morning email** at 5:45 AM PT on weekdays (due-based, once a day, catch-up until noon). Window = previous session's close → now. **Recap mode on the first trading day of the week** (Monday, or Tuesday after a Monday holiday). Holidays get a short "market closed" version.
- **No calendar-only tickers:** any ticker with seeded events is added to the watchlist, so it gets news, filings and prices too.
- **Events precedence** (see CLAUDE.md): seed > derived/rule (±3 days); Alpha Vantage > unconfirmed seed estimate (±45 days); a confirmed seeded date keeps Alpha Vantage's date, time and EPS estimate in its note (±3 days).
- **Alpha Vantage**: ≤ 2 calls per Pacific day (5:00, and 5:30 only if 5:00 failed), counted in `job_runs`; no in-request retries. HEALTH email after 2 failed days in a row, plus one on recovery.
- **Form 4**: open-market buys/sells (codes P, S) listed per insider and filing (shares, weighted average price, $ value, 10b5-1 flag); all other codes counted.
- **Pre-market** uses SIP 1-minute bars (15-min delayed on the free plan) up to now − 16 min, IEX as fallback.
- **Levels to watch**: stop, warning, take-profit, started trailing stop, and the next untriggered ETF drawdown tier within 5% of the last close; crossed levels are "still-active conditions" instead.
