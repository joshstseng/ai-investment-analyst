/**
 * Postgres schema (Drizzle).
 *
 * Conventions
 * - Every table has created_at / updated_at as timestamptz (UTC). updated_at is maintained by a
 *   database trigger (see the set_updated_at migration), so raw SQL and upserts keep it correct.
 * - Money and quantities are numeric (exact; Drizzle returns them as strings). Fractional shares OK.
 * - Missing user input ("NEEDS USER INPUT") is stored as NULL *and* the column name is listed in
 *   that row's `needs_input` array. CHECK constraints reject a NULL in a required-by-meaning
 *   column unless it is flagged, so missing data is never silent.
 * - Market-data tables are keyed by plain symbol text (they also hold SPY/QQQ and option
 *   underlyings that are not instruments we own).
 */
import { RULE_PURPOSES, RULE_STATUSES, RULE_TYPES } from '@aia/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------------------------

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

const timestamps = {
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
};

/** Column names whose value is missing and still needs user input. */
const needsInput = () =>
  text('needs_input')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`);

/** CHECK: `col` may only be NULL if 'col' is listed in needs_input. */
const nullOnlyIfFlagged = (table: string, col: string) =>
  check(
    `${table}_${col}_null_flagged`,
    sql.raw(`"${col}" IS NOT NULL OR '${col}' = ANY("needs_input")`),
  );

const money = (name: string) => numeric(name, { precision: 20, scale: 6 });

// ---------------------------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------------------------

export const accountTypeEnum = pgEnum('account_type', ['roth_ira', 'individual_taxable']);

export const instrumentTypeEnum = pgEnum('instrument_type', [
  'stock',
  'etf',
  'otc_stock',
  'option',
]);

export const optionRightEnum = pgEnum('option_right', ['call', 'put']);

export const holdingStatusEnum = pgEnum('holding_status', ['open', 'pending_fill', 'closed']);

export const thesisStatusEnum = pgEnum('thesis_status', [
  'unknown',
  'intact',
  'weakening',
  'breaking',
  'broken',
]);

/** Machine-checkable rule types (params validated by zod schemas in @aia/core). */
export const ruleTypeEnum = pgEnum('rule_type', RULE_TYPES);

/** What the rule is for. Mirrors the rule columns in positions.csv, plus time stops. */
export const rulePurposeEnum = pgEnum('rule_purpose', RULE_PURPOSES);

export const ruleStatusEnum = pgEnum('rule_status', RULE_STATUSES);

export const severityEnum = pgEnum('severity', ['info', 'warn', 'critical']);

export const alertChannelEnum = pgEnum('alert_channel', ['email', 'digest', 'push']);

export const jobStatusEnum = pgEnum('job_status', ['running', 'success', 'error', 'skipped']);

export const dataStatusEnum = pgEnum('data_status', [
  'ok',
  'no_data_source',
  'not_applicable',
  'stale',
  'error',
]);

export const feedStateEnum = pgEnum('feed_state', ['ok', 'degraded', 'down', 'disabled']);

export const ruleOutcomeEnum = pgEnum('rule_outcome', ['fired', 'not_fired', 'not_checked']);

export const filingViaEnum = pgEnum('filing_via', ['backfill', 'poll']);

export const newsViaEnum = pgEnum('news_via', ['rest', 'stream']);

// ---------------------------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------------------------

export const accounts = pgTable('accounts', {
  id: serial('id').primaryKey(),
  /** Display name, e.g. "Roth IRA". No account numbers are ever stored. */
  name: text('name').notNull().unique(),
  accountType: accountTypeEnum('account_type').notNull().unique(),
  taxAdvantaged: boolean('tax_advantaged').notNull(),
  cashBalance: money('cash_balance'),
  totalValue: money('total_value'),
  balancesAsOf: tstz('balances_as_of'),
  notes: text('notes'),
  ...timestamps,
});

/**
 * Anything we hold or watch. For options, `symbol` is the OCC symbol (e.g. OPTY270319C00006000)
 * and price checks run on `underlying_symbol`.
 */
export const instruments = pgTable(
  'instruments',
  {
    id: serial('id').primaryKey(),
    symbol: text('symbol').notNull().unique(),
    instrumentType: instrumentTypeEnum('instrument_type').notNull(),
    name: text('name'),
    underlyingSymbol: text('underlying_symbol'),
    optionRight: optionRightEnum('option_right'),
    strike: money('strike'),
    expiry: date('expiry', { mode: 'string' }),
    /** Shares per contract for options (100); 1 otherwise. */
    multiplier: integer('multiplier').notNull().default(1),
    /** Free-text listing info, e.g. "OTC; LSE:OTX". */
    listingNote: text('listing_note'),
    ...timestamps,
  },
  (t) => [
    check(
      'instruments_option_fields',
      sql`CASE WHEN ${t.instrumentType} = 'option'
        THEN ${t.underlyingSymbol} IS NOT NULL AND ${t.optionRight} IS NOT NULL
          AND ${t.strike} IS NOT NULL AND ${t.expiry} IS NOT NULL
        ELSE ${t.underlyingSymbol} IS NULL AND ${t.optionRight} IS NULL
          AND ${t.strike} IS NULL AND ${t.expiry} IS NULL
        END`,
    ),
    check('instruments_multiplier_positive', sql`${t.multiplier} > 0`),
    index('instruments_underlying_idx').on(t.underlyingSymbol),
  ],
);

/** One row per lot. The same instrument may have several lots in one account (e.g. 4 + 6). */
export const holdings = pgTable(
  'holdings',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    instrumentId: integer('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'restrict' }),
    /** 1-based lot number within (account, instrument). */
    lotNo: integer('lot_no').notNull().default(1),
    /** Shares, or contracts for options. Fractional allowed. */
    quantity: numeric('quantity', { precision: 20, scale: 6 }),
    /** Average cost per share (per underlying share for options), as reported by the broker. */
    avgCost: money('avg_cost'),
    /** Total cost basis when known; can differ from qty × avg_cost because of rounding. */
    costBasisTotal: money('cost_basis_total'),
    status: holdingStatusEnum('status').notNull().default('open'),
    /** Set while the position still needs the user's confirmation (e.g. an unconfirmed fill). */
    needsConfirmation: boolean('needs_confirmation').notNull().default(false),
    confirmationNote: text('confirmation_note'),
    /** Snapshot time of the source data (e.g. brokerage screenshot). */
    asOf: tstz('as_of'),
    source: text('source'),
    notes: text('notes'),
    needsInput: needsInput(),
    ...timestamps,
  },
  (t) => [
    unique('holdings_account_instrument_lot').on(t.accountId, t.instrumentId, t.lotNo),
    nullOnlyIfFlagged('holdings', 'quantity'),
    nullOnlyIfFlagged('holdings', 'avg_cost'),
    check('holdings_lot_no_positive', sql`${t.lotNo} >= 1`),
    check('holdings_quantity_nonneg', sql`${t.quantity} IS NULL OR ${t.quantity} >= 0`),
    index('holdings_instrument_idx').on(t.instrumentId),
  ],
);

/** Per-instrument thesis notes from positions.csv (applies across accounts and lots). */
export const positionTheses = pgTable(
  'position_theses',
  {
    id: serial('id').primaryKey(),
    instrumentId: integer('instrument_id')
      .notNull()
      .unique()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    whyIOwnIt: text('why_i_own_it'),
    entryPrice: money('entry_price'),
    entryDate: date('entry_date', { mode: 'string' }),
    thesisStatus: thesisStatusEnum('thesis_status').notNull().default('unknown'),
    /** Anything after the status word, e.g. "reason changed after a new purchase". */
    thesisStatusNote: text('thesis_status_note'),
    lastChecked: date('last_checked', { mode: 'string' }),
    notes: text('notes'),
    needsInput: needsInput(),
    ...timestamps,
  },
  () => [
    nullOnlyIfFlagged('position_theses', 'why_i_own_it'),
    nullOnlyIfFlagged('position_theses', 'entry_price'),
    nullOnlyIfFlagged('position_theses', 'entry_date'),
  ],
);

/**
 * Exit rules attach to an instrument, so one rule covers every lot in both accounts.
 * - rule_type set   → machine-checkable; `params` holds its settings (validated by zod in core).
 * - rule_type NULL  → judgment-only (see thesis_break_triggers) or a PLACEHOLDER.
 * Every status sends alerts; only the label differs (CONFIRMED = "action per plan",
 * DRAFT/PLACEHOLDER = "review"). Alerts are held back only when required data is missing.
 */
export const exitRules = pgTable(
  'exit_rules',
  {
    id: serial('id').primaryKey(),
    instrumentId: integer('instrument_id')
      .notNull()
      .references(() => instruments.id, { onDelete: 'cascade' }),
    purpose: rulePurposeEnum('purpose').notNull(),
    ruleType: ruleTypeEnum('rule_type'),
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    status: ruleStatusEnum('status').notNull(),
    /** Text included in every alert this rule sends (e.g. "only if the catalyst is confirmed"). */
    alertNote: text('alert_note'),
    /** Free-text conditions that need judgment rather than a price check. */
    thesisBreakTriggers: text('thesis_break_triggers'),
    /** Verbatim text the rule was parsed from, for traceability. */
    sourceText: text('source_text'),
    /** Stable key for idempotent imports, e.g. "seed:positions:OTCX:risk_stop". */
    externalKey: text('external_key').unique(),
    confirmedAt: date('confirmed_at', { mode: 'string' }),
    notes: text('notes'),
    needsInput: needsInput(),
    ...timestamps,
  },
  (t) => [
    check(
      'exit_rules_confirmed_is_actionable',
      sql`${t.status} <> 'CONFIRMED' OR ${t.ruleType} IS NOT NULL OR ${t.thesisBreakTriggers} IS NOT NULL`,
    ),
    check('exit_rules_params_object', sql`jsonb_typeof(${t.params}) = 'object'`),
    index('exit_rules_instrument_idx').on(t.instrumentId),
  ],
);

export const watchlist = pgTable('watchlist', {
  id: serial('id').primaryKey(),
  instrumentId: integer('instrument_id')
    .notNull()
    .unique()
    .references(() => instruments.id, { onDelete: 'cascade' }),
  dateAdded: date('date_added', { mode: 'string' }),
  /** Free text ("Researching", "Watch", ...) so new statuses never block an import. */
  status: text('status'),
  thesisSummary: text('thesis_summary'),
  primaryCatalyst: text('primary_catalyst'),
  valuationQuestion: text('valuation_question'),
  keyRisk: text('key_risk'),
  reviewBy: date('review_by', { mode: 'string' }),
  latestSourceUrl: text('latest_source_url'),
  lastUpdated: date('last_updated', { mode: 'string' }),
  needsInput: needsInput(),
  ...timestamps,
});

// ---------------------------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------------------------

export const pricesDaily = pgTable(
  'prices_daily',
  {
    symbol: text('symbol').notNull(),
    /** Trading date (exchange local, America/New_York). */
    date: date('date', { mode: 'string' }).notNull(),
    open: money('open').notNull(),
    high: money('high').notNull(),
    low: money('low').notNull(),
    close: money('close').notNull(),
    volume: bigint('volume', { mode: 'number' }).notNull(),
    vwap: money('vwap'),
    tradeCount: integer('trade_count'),
    /** e.g. "alpaca:iex". */
    source: text('source').notNull(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.symbol, t.date] })],
);

export const quotesLatest = pgTable('quotes_latest', {
  symbol: text('symbol').primaryKey(),
  bidPrice: money('bid_price'),
  bidSize: numeric('bid_size'),
  askPrice: money('ask_price'),
  askSize: numeric('ask_size'),
  lastPrice: money('last_price'),
  /** Exchange timestamp of the quote/trade. */
  quoteTs: tstz('quote_ts'),
  receivedAt: tstz('received_at').notNull().defaultNow(),
  source: text('source').notNull(),
  ...timestamps,
});

/** Trading days from the Alpaca calendar (holidays are absent; early closes flagged). */
export const marketCalendar = pgTable('market_calendar', {
  /** Trading date in America/New_York. */
  date: date('date', { mode: 'string' }).primaryKey(),
  openAt: tstz('open_at').notNull(),
  closeAt: tstz('close_at').notNull(),
  sessionOpenAt: tstz('session_open_at'),
  sessionCloseAt: tstz('session_close_at'),
  earlyClose: boolean('early_close').notNull(),
  ...timestamps,
});

/**
 * Per-symbol data coverage, e.g. ('OTCX', 'daily_bars') = no_data_source. Checks report such
 * symbols as "not checked: no data source" instead of failing.
 */
export const symbolDataStatus = pgTable(
  'symbol_data_status',
  {
    symbol: text('symbol').notNull(),
    /** 'daily_bars' | 'quotes' | 'option_prices' | 'news' */
    dataset: text('dataset').notNull(),
    status: dataStatusEnum('status').notNull(),
    source: text('source'),
    /** Timestamp of the newest data we hold for this symbol/dataset. */
    lastDataAt: tstz('last_data_at'),
    note: text('note'),
    checkedAt: tstz('checked_at').notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.symbol, t.dataset] })],
);

// ---------------------------------------------------------------------------------------------
// News and filings
// ---------------------------------------------------------------------------------------------

export const newsItems = pgTable(
  'news_items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** e.g. "alpaca:benzinga". */
    source: text('source').notNull(),
    sourceId: text('source_id').notNull(),
    headline: text('headline').notNull(),
    summary: text('summary'),
    url: text('url'),
    symbols: text('symbols')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    publishedAt: tstz('published_at').notNull(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    /** How we received it; feed latency is only meaningful for 'stream'. */
    via: newsViaEnum('via').notNull(),
    /** Content hash for cross-source duplicate detection. */
    hash: text('hash').notNull().unique(),
    ...timestamps,
  },
  (t) => [
    unique('news_items_source_source_id').on(t.source, t.sourceId),
    index('news_items_symbols_gin').using('gin', t.symbols),
    index('news_items_published_at_idx').on(t.publishedAt),
  ],
);

export const filings = pgTable(
  'filings',
  {
    id: serial('id').primaryKey(),
    accession: text('accession').notNull().unique(),
    cik: text('cik').notNull(),
    ticker: text('ticker'),
    form: text('form').notNull(),
    filingDate: date('filing_date', { mode: 'string' }),
    /** 8-K item codes, e.g. {"2.02","9.01"}. */
    items: text('items')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    filedAt: tstz('filed_at').notNull(),
    url: text('url').notNull(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    /** 'poll' = seen by the regular poll; latency (received_at - filed_at) is meaningful only for these. */
    via: filingViaEnum('via').notNull(),
    ...timestamps,
  },
  (t) => [
    index('filings_ticker_filed_at_idx').on(t.ticker, t.filedAt),
    index('filings_cik_idx').on(t.cik),
  ],
);

/** Ticker → SEC CIK, from company_tickers.json (companies) and company_tickers_mf.json (funds). */
export const secCiks = pgTable('sec_ciks', {
  ticker: text('ticker').primaryKey(),
  /** 10-digit zero-padded CIK, as used in data.sec.gov URLs. */
  cik: text('cik').notNull(),
  title: text('title'),
  kind: text('kind').notNull(), // 'company' | 'fund'
  ...timestamps,
});

// ---------------------------------------------------------------------------------------------
// Rule checks, alerts, job runs

/**
 * Health of each data feed (news stream, quotes, bars, EDGAR, scheduler). Written by the news
 * stream itself and by the hourly feed-health job; milestone 8 alerts on outages.
 */
export const feedStatus = pgTable('feed_status', {
  feed: text('feed').primaryKey(),
  status: feedStateEnum('status').notNull(),
  detail: text('detail'),
  /** When the current status began. */
  since: tstz('since').notNull().defaultNow(),
  /** Last time the feed was known to be healthy. */
  lastOkAt: tstz('last_ok_at'),
  checkedAt: tstz('checked_at').notNull().defaultNow(),
  meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
});
// ---------------------------------------------------------------------------------------------

export const ruleEvaluations = pgTable(
  'rule_evaluations',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    exitRuleId: integer('exit_rule_id')
      .notNull()
      .references(() => exitRules.id, { onDelete: 'cascade' }),
    /** Trading date of the bar the rule was evaluated against. */
    asOfDate: date('as_of_date', { mode: 'string' }).notNull(),
    /** Symbol actually evaluated (the underlying for options). */
    evaluatedSymbol: text('evaluated_symbol').notNull(),
    outcome: ruleOutcomeEnum('outcome').notNull(),
    /** Why a rule was not checked: no_data_source, missing_bar, insufficient_history, ... */
    reason: text('reason'),
    fired: boolean('fired').notNull(),
    severity: severityEnum('severity'),
    /** Inputs and computed values (close, level, distance %, ...). */
    observed: jsonb('observed').$type<Record<string, unknown>>().notNull().default({}),
    message: text('message'),
    evaluatedAt: tstz('evaluated_at').notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [unique('rule_evaluations_rule_date').on(t.exitRuleId, t.asOfDate)],
);

export const alerts = pgTable(
  'alerts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    severity: severityEnum('severity').notNull(),
    /** Unique per logical event, e.g. "rule:12:2026-11-14" or "feed:alpaca-news:down". */
    dedupeKey: text('dedupe_key').notNull().unique(),
    channel: alertChannelEnum('channel').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    /** Optional HTML version of the body (emails render this; body is the plain-text part). */
    html: text('html'),
    symbol: text('symbol'),
    ruleEvaluationId: bigint('rule_evaluation_id', { mode: 'number' }).references(
      () => ruleEvaluations.id,
      { onDelete: 'set null' },
    ),
    /** 'rule' | 'health' | 'digest' | 'test' */
    kind: text('kind').notNull().default('rule'),
    asOfDate: date('as_of_date', { mode: 'string' }),
    sentAt: tstz('sent_at'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    ...timestamps,
  },
  (t) => [index('alerts_unsent_idx').on(t.channel, t.sentAt)],
);

/** Alert policy state per rule (see decideAlert in @aia/core). */
export const alertStates = pgTable('alert_states', {
  exitRuleId: integer('exit_rule_id')
    .primaryKey()
    .references(() => exitRules.id, { onDelete: 'cascade' }),
  active: boolean('active').notNull(),
  rank: integer('rank').notNull(),
  /** Price at the last alert, the reference for "a further 2% move". */
  price: money('price').notNull(),
  level: text('level').notNull(),
  firstFiredOn: date('first_fired_on', { mode: 'string' }).notNull(),
  lastAlertedOn: date('last_alerted_on', { mode: 'string' }),
  ...timestamps,
});

export const jobRuns = pgTable(
  'job_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    job: text('job').notNull(),
    status: jobStatusEnum('status').notNull().default('running'),
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
    itemsProcessed: integer('items_processed'),
    error: text('error'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [index('job_runs_job_started_idx').on(t.job, t.startedAt)],
);
