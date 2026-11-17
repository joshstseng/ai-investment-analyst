/**
 * Daily digest (trading days, ~2:15 PM PT): closes, % vs cost per lot, distance to the nearest
 * stop / take-profit, still-active conditions, alerts sent today, new filings and headlines per
 * ticker, rules not checked (and why), feed problems. On the week's last session it adds
 * "rules to write" and missing user input.
 */
import {
  accountTag,
  addDays,
  attentionRange,
  byAttention,
  COMPACT_RULE_TYPES,
  filingTitle,
  isRuleToWrite,
  levelsToWatch,
  lotLine,
  nextLevel,
  nyDate,
  portfolioDay,
  positionPL,
  ruleAlertTag,
  selectHeadlines,
  zonedTimeToUtc,
  type AttentionRange,
  type AttentionTag,
  type HeadlineSelection,
  type LevelToWatch,
  type Outcome,
  type PortfolioDay,
  type RuleStatus,
  type RuleType,
} from '@aia/core';
import {
  accounts,
  alerts,
  alertStates,
  events,
  exitRules,
  feedStatus,
  filings,
  holdings,
  instruments,
  marketCalendar,
  newsItems,
  positionTheses,
  pricesDaily,
  ruleEvaluations,
  symbolDataStatus,
  type Db,
} from '@aia/db';
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, ne } from 'drizzle-orm';
import { loadUniverse } from '../market/universe';
import { loadLevelInputs, WATCH_WITHIN } from '../morning/levels';
import { summarizeTrades, type Form4Summary, type TradeSummary } from '../sec/form4';
import { loadPullbackSummary, type PullbackSummary } from '../pullbacks/summary';
import { ACCOUNT_LABEL } from './format';

export interface DigestLevel {
  level: number;
  distPct: number;
  status: string;
  label: string;
}

export interface DigestPosition {
  display: string;
  symbol: string;
  evaluatedSymbol: string;
  isOption: boolean;
  noData: boolean;
  close: number | null;
  dayPct: number | null;
  lots: {
    account: string;
    quantity: number;
    avgCost: number;
    pctVsCost: number | null;
    unconfirmed: boolean;
  }[];
  stop: DigestLevel | null;
  takeProfit: DigestLevel | null;
  /** Total shares (contracts for options). */
  shares: number;
  /** Stocks/ETFs at today's close; null for options and positions without a close. */
  value: number | null;
  plDollars: number | null;
  plPct: number | null;
  /** Share of the counted portfolio value (stocks/ETFs). */
  weightPct: number | null;
  /** R / I / R+I */
  accountTag: string;
  /** Multi-lot detail, e.g. "12 @ 70.10 · 9 @ 84.40" or "3 lots · 140 sh". */
  lotLine: string | null;
  /** Nearest uncrossed level (stop, warning, tier, take-profit, cost, 52w low). */
  next: LevelToWatch | null;
  /** A new_52w_low rule fired today. */
  atNewLow: boolean;
  /** Options: the contract and how far the underlying is from the strike. */
  option: {
    right: string | null;
    strike: number | null;
    expiry: string | null;
    vsStrikePct: number | null;
  } | null;
  /** Next reminder event for the (underlying) ticker within 60 days. */
  reminder: { date: string; title: string } | null;
}

export interface AttentionItem {
  ruleId: number;
  display: string;
  symbol: string;
  evaluatedSymbol: string;
  tag: AttentionTag;
  status: string;
  ruleType: string;
  /** Fired level, e.g. "stop", "warning", "drawdown_15", "move_down", "new_low". */
  level: string;
  message: string;
  observed: Record<string, unknown>;
  /** Alerted today on an escalation (first fired before today). */
  escalated: boolean;
  alertedToday: boolean;
  firstFiredOn: string | null;
  close: number | null;
  dayPct: number | null;
  compact: boolean;
  range: AttentionRange | null;
  position: {
    shares: number;
    lots: number;
    plDollars: number | null;
    plPct: number | null;
    weightPct: number | null;
  } | null;
}

export interface DigestFiling {
  /** Ticker chips; grouped Form 4 lines use "ACMX ×3". */
  tickers: string[];
  held: boolean;
  title: string;
  itemsNote: string | null;
  /** Results, dilution, management change, insider buys/sells. */
  strong: boolean;
  url: string | null;
  filedAt: Date | null;
  /** Form 4 open-market buys/sells (P/S), one per insider and direction. */
  trades: TradeSummary[];
}

/**
 * Positions order: best day first, worst last (options by their underlying's move). Positions
 * with no day % (no data source, missing bar) go at the end; ties are alphabetical.
 */
export function byDayMoveDesc(
  a: Pick<DigestPosition, 'display' | 'dayPct'>,
  b: Pick<DigestPosition, 'display' | 'dayPct'>,
): number {
  if (a.dayPct === null || b.dayPct === null) {
    if (a.dayPct !== b.dayPct) return a.dayPct === null ? 1 : -1;
  } else if (a.dayPct !== b.dayPct) {
    return b.dayPct - a.dayPct;
  }
  return a.display.localeCompare(b.display);
}

export interface DigestData {
  date: string;
  generatedAt: Date;
  since: Date;
  until: Date;
  weekly: boolean;
  positions: DigestPosition[];
  active: {
    display: string;
    level: string;
    status: string;
    firstFiredOn: string;
    message: string;
  }[];
  alertsToday: string[];
  notChecked: { reason: string; items: string[] }[];
  filings: {
    ticker: string;
    items: { form: string; items: string[]; filedAt: Date; url: string }[];
  }[];
  headlines: {
    ticker: string;
    items: { headline: string; url: string | null; publishedAt: Date }[];
    more: number;
  }[];
  feedIssues: { feed: string; status: string; detail: string | null; since: Date }[];
  rulesToWrite: { display: string; purposes: string[] }[];
  needsInput: string[];
  /** Day change and value over stocks/ETFs (options excluded). */
  portfolio: PortfolioDay;
  /** Alerts today and still-active conditions, most severe first. */
  attention: AttentionItem[];
  /** Within 5% of a stop/warning/take-profit/tier/cost, or 8% of a 52-week low. */
  levelsToWatch: LevelToWatch[];
  filingList: DigestFiling[];
  filingCounts: { total: number; earnings8k: number };
  headlineSelection: HeadlineSelection;
  /** Today's rule alerts by tag. */
  alertMix: Partial<Record<AttentionTag, number>>;
  /** Pullback screen EOD summary: names in an episode and what changed at each check today. */
  pullbacks: PullbackSummary | null;
}

const HEADLINES_PER_TICKER = 5;
const DIGEST_HOUR_PT = 14;
const DIGEST_MINUTE_PT = 15;

/** Monday (YYYY-MM-DD) of the week containing `date`. */
const weekOf = (date: string) => {
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -dow);
};

/** The digest time for a session date: 2:15 PM Pacific. */
export function digestTimeFor(date: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return zonedTimeToUtc(
    { year: y, month: m, day: d, hour: DIGEST_HOUR_PT, minute: DIGEST_MINUTE_PT },
    'America/Los_Angeles',
  );
}

const REASON_TEXT: Record<string, string> = {
  no_data_source: 'no data source',
  missing_bar: 'missing bar',
  insufficient_history: 'insufficient history',
  not_started: 'not started yet',
  expired: 'rule ended',
  not_trading_day: 'not a trading day',
};

export async function gatherDigest(db: Db, date: string, now = new Date()): Promise<DigestData> {
  const sessions = (
    await db
      .select({ date: marketCalendar.date })
      .from(marketCalendar)
      .where(
        and(
          gte(marketCalendar.date, addDays(date, -10)),
          lt(marketCalendar.date, addDays(date, 10)),
        ),
      )
      .orderBy(asc(marketCalendar.date))
  ).map((s) => s.date);
  const idx = sessions.indexOf(date);
  const prevDate = idx > 0 ? sessions[idx - 1]! : null;
  const nextDate = sessions[idx + 1] ?? null;
  const since = prevDate ? digestTimeFor(prevDate) : new Date(now.getTime() - 86_400_000);
  const weekly = !nextDate || weekOf(nextDate) !== weekOf(date);
  // Window ends at this session's digest time, so a late or historical digest doesn't pull in
  // items that belong to the next one.
  const until = new Date(Math.min(now.getTime(), digestTimeFor(date).getTime()));

  // Holdings and their instruments.
  const lotRows = await db
    .select({
      instrumentId: instruments.id,
      symbol: instruments.symbol,
      name: instruments.name,
      type: instruments.instrumentType,
      underlying: instruments.underlyingSymbol,
      account: accounts.accountType,
      quantity: holdings.quantity,
      avgCost: holdings.avgCost,
      costBasisTotal: holdings.costBasisTotal,
      unconfirmed: holdings.needsConfirmation,
      optionRight: instruments.optionRight,
      strike: instruments.strike,
      expiry: instruments.expiry,
    })
    .from(holdings)
    .innerJoin(instruments, eq(holdings.instrumentId, instruments.id))
    .innerJoin(accounts, eq(holdings.accountId, accounts.id))
    .where(ne(holdings.status, 'closed'))
    .orderBy(asc(instruments.symbol), asc(accounts.accountType), asc(holdings.lotNo));

  const evalSymbols = [...new Set(lotRows.map((l) => l.underlying ?? l.symbol))];
  const bars = evalSymbols.length
    ? await db
        .select({ symbol: pricesDaily.symbol, date: pricesDaily.date, close: pricesDaily.close })
        .from(pricesDaily)
        .where(
          and(
            inArray(pricesDaily.symbol, evalSymbols),
            inArray(pricesDaily.date, [date, ...(prevDate ? [prevDate] : [])]),
          ),
        )
    : [];
  const closeOf = (sym: string, d: string | null) => {
    const b = bars.find((x) => x.symbol === sym && x.date === d);
    return b ? Number(b.close) : null;
  };
  const noData = new Set(
    (
      await db
        .select({ symbol: symbolDataStatus.symbol })
        .from(symbolDataStatus)
        .where(
          and(
            eq(symbolDataStatus.dataset, 'daily_bars'),
            eq(symbolDataStatus.status, 'no_data_source'),
          ),
        )
    ).map((r) => r.symbol),
  );

  const rules = await db
    .select({
      id: exitRules.id,
      instrumentId: exitRules.instrumentId,
      ruleType: exitRules.ruleType,
      params: exitRules.params,
      status: exitRules.status,
      purpose: exitRules.purpose,
      judgment: exitRules.thesisBreakTriggers,
    })
    .from(exitRules);
  const todaysEvals = await db
    .select()
    .from(ruleEvaluations)
    .where(eq(ruleEvaluations.asOfDate, date));
  const evalBy = new Map(todaysEvals.map((e) => [e.exitRuleId, e]));

  const levelInputs = await loadLevelInputs(db, date);
  const levelInputBy = new Map(levelInputs.map((l) => [l.instrumentSymbol, l]));
  const firedToday = todaysEvals.filter((e) => e.outcome === 'fired');
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const newLowToday = new Set(
    firedToday
      .filter((e) => ruleById.get(e.exitRuleId)?.ruleType === 'new_52w_low')
      .map((e) => ruleById.get(e.exitRuleId)!.instrumentId),
  );
  const reminderRows = await db
    .select({ ticker: events.ticker, date: events.date, title: events.title })
    .from(events)
    .where(
      and(
        eq(events.eventType, 'reminder'),
        eq(events.status, 'active'),
        gte(events.date, date),
        lte(events.date, addDays(date, 60)),
      ),
    )
    .orderBy(asc(events.date));

  const byInstrument = new Map<number, typeof lotRows>();
  for (const l of lotRows)
    byInstrument.set(l.instrumentId, [...(byInstrument.get(l.instrumentId) ?? []), l]);

  const positions: DigestPosition[] = [];
  for (const [instrumentId, lots] of byInstrument) {
    const f = lots[0]!;
    const evaluatedSymbol = f.underlying ?? f.symbol;
    const isOption = f.type === 'option';
    const close = closeOf(evaluatedSymbol, date);
    const prev = closeOf(evaluatedSymbol, prevDate);
    const stops: DigestLevel[] = [];
    const tps: DigestLevel[] = [];
    for (const r of rules.filter((x) => x.instrumentId === instrumentId)) {
      const p = r.params as Record<string, number | string | null | undefined>;
      if (close === null) break;
      if (r.ruleType === 'stop_close_below' && typeof p.level === 'number') {
        stops.push({
          level: p.level,
          distPct: ((close - p.level) / close) * 100,
          status: r.status,
          label: 'stop',
        });
      }
      if (r.ruleType === 'trailing_close_pct_from_high') {
        const trigger = (evalBy.get(r.id)?.observed as { triggerLevel?: number } | undefined)
          ?.triggerLevel;
        if (typeof trigger === 'number') {
          stops.push({
            level: trigger,
            distPct: ((close - trigger) / close) * 100,
            status: r.status,
            label: 'trailing stop',
          });
        }
      }
      if (
        r.ruleType === 'take_profit_at_or_above' &&
        typeof p.level === 'number' &&
        !(typeof p.valid_until === 'string' && p.valid_until < date)
      ) {
        tps.push({
          level: p.level,
          distPct: ((p.level - close) / close) * 100,
          status: r.status,
          label: 'take-profit',
        });
      }
    }
    const nearest = (xs: DigestLevel[]) =>
      xs.length ? xs.reduce((a, b) => (Math.abs(b.distPct) < Math.abs(a.distPct) ? b : a)) : null;
    const lotInputs = lots.map((l) => ({
      account: l.account,
      quantity: Number(l.quantity ?? 0),
      avgCost: Number(l.avgCost ?? 0),
      costBasisTotal: l.costBasisTotal === null ? null : Number(l.costBasisTotal),
    }));
    const pl = !isOption && close !== null ? positionPL(lotInputs, close) : null;
    const levelInput = levelInputBy.get(f.symbol);
    const strike = f.strike === null ? null : Number(f.strike);
    const reminder = reminderRows.find((e) => e.ticker === evaluatedSymbol) ?? null;
    positions.push({
      display: isOption && f.name ? f.name : f.symbol,
      symbol: f.symbol,
      evaluatedSymbol,
      isOption,
      noData: noData.has(evaluatedSymbol),
      close,
      dayPct: close !== null && prev !== null ? ((close - prev) / prev) * 100 : null,
      lots: lots.map((l) => {
        const avg = Number(l.avgCost);
        return {
          account: l.account,
          quantity: Number(l.quantity),
          avgCost: avg,
          pctVsCost: !isOption && close !== null && avg > 0 ? ((close - avg) / avg) * 100 : null,
          unconfirmed: l.unconfirmed,
        };
      }),
      stop: nearest(stops),
      takeProfit: nearest(tps),
      shares: lotInputs.reduce((a, l) => a + l.quantity, 0),
      value: pl?.value ?? null,
      plDollars: pl?.plDollars ?? null,
      plPct: pl?.plPct ?? null,
      weightPct: null, // set below, once the portfolio total is known
      accountTag: accountTag(lots.map((l) => l.account)),
      lotLine: lotLine(lotInputs),
      next: levelInput ? nextLevel(levelInput, date) : null,
      atNewLow: newLowToday.has(instrumentId),
      option: isOption
        ? {
            right: f.optionRight,
            strike,
            expiry: f.expiry,
            vsStrikePct:
              close !== null && strike ? Math.round(((close - strike) / strike) * 1000) / 10 : null,
          }
        : null,
      reminder: reminder ? { date: reminder.date, title: reminder.title } : null,
    });
  }

  const portfolio = portfolioDay(
    positions.map((p) => ({
      display: p.display,
      isOption: p.isOption,
      shares: p.shares,
      close: p.close,
      prevClose: closeOf(p.evaluatedSymbol, prevDate),
    })),
  );
  for (const p of positions) {
    if (p.value !== null && portfolio.value > 0) {
      p.weightPct = Math.round((p.value / portfolio.value) * 1000) / 10;
    }
  }
  const positionBySymbol = new Map(positions.map((p) => [p.symbol, p]));

  // Still-active conditions and today's alerts.
  const activeRows = await db
    .select({
      ruleId: alertStates.exitRuleId,
      level: alertStates.level,
      firstFiredOn: alertStates.firstFiredOn,
      status: exitRules.status,
      symbol: instruments.symbol,
      name: instruments.name,
      type: instruments.instrumentType,
    })
    .from(alertStates)
    .innerJoin(exitRules, eq(alertStates.exitRuleId, exitRules.id))
    .innerJoin(instruments, eq(exitRules.instrumentId, instruments.id))
    .where(eq(alertStates.active, true))
    .orderBy(asc(instruments.symbol));
  const display = (r: { symbol: string; name: string | null; type: string }) =>
    r.type === 'option' && r.name ? r.name : r.symbol;
  const active = activeRows.map((r) => ({
    display: display(r),
    level: r.level,
    status: r.status,
    firstFiredOn: r.firstFiredOn,
    message: evalBy.get(r.ruleId)?.message ?? '',
  }));
  // Needs attention: every rule that fired today (= active conditions), with alert history.
  const states = firedToday.length
    ? await db
        .select()
        .from(alertStates)
        .where(
          inArray(
            alertStates.exitRuleId,
            firedToday.map((e) => e.exitRuleId),
          ),
        )
    : [];
  const stateBy = new Map(states.map((s) => [s.exitRuleId, s]));
  const instrumentSymbolById = new Map(lotRows.map((l) => [l.instrumentId, l.symbol]));
  const attention: AttentionItem[] = [];
  for (const e of firedToday) {
    const r = ruleById.get(e.exitRuleId);
    const sym = r ? instrumentSymbolById.get(r.instrumentId) : undefined;
    const p = sym ? positionBySymbol.get(sym) : undefined;
    if (!r || !r.ruleType || !p) continue;
    const observed = e.observed;
    const level = typeof observed.level === 'string' ? observed.level : '';
    const tag = ruleAlertTag(
      r.status as RuleStatus,
      r.ruleType as RuleType,
      {
        kind: 'fired',
        severity: e.severity ?? 'info',
        level,
        message: e.message ?? '',
        observed,
      } as Extract<Outcome, { kind: 'fired' }>,
    ) as AttentionTag;
    const st = stateBy.get(r.id);
    const alertedToday = st?.lastAlertedOn === date;
    const compact = COMPACT_RULE_TYPES.has(r.ruleType);
    const sibling = rules.filter((x) => x.instrumentId === r.instrumentId);
    const lvl = (x: (typeof rules)[number]) => (x.params as { level?: unknown }).level;
    attention.push({
      ruleId: r.id,
      display: p.display,
      symbol: p.symbol,
      evaluatedSymbol: p.evaluatedSymbol,
      tag,
      status: r.status,
      ruleType: r.ruleType,
      level,
      message: e.message ?? '',
      observed,
      escalated: alertedToday && !!st && st.firstFiredOn < date,
      alertedToday,
      firstFiredOn: st?.firstFiredOn ?? null,
      close: p.close,
      dayPct: p.dayPct,
      compact,
      range:
        compact || p.close === null
          ? null
          : attentionRange({
              ruleType: r.ruleType,
              observed,
              close: p.close,
              stops: sibling
                .filter((x) => x.ruleType === 'stop_close_below')
                .map(lvl)
                .filter((v): v is number => typeof v === 'number'),
              takeProfits: sibling
                .filter((x) => x.ruleType === 'take_profit_at_or_above')
                .map(lvl)
                .filter((v): v is number => typeof v === 'number'),
              avgCost:
                p.value !== null && p.shares > 0 && p.plDollars !== null
                  ? (p.value - p.plDollars) / p.shares
                  : null,
            }),
      position:
        p.lots.length === 0
          ? null
          : {
              shares: p.shares,
              lots: p.lots.length,
              plDollars: p.plDollars,
              plPct: p.plPct,
              weightPct: p.weightPct,
            },
    });
  }
  attention.sort(byAttention);

  const alertsToday = (
    await db
      .select({ subject: alerts.subject })
      .from(alerts)
      .where(and(eq(alerts.asOfDate, date), inArray(alerts.kind, ['rule'])))
      .orderBy(asc(alerts.id))
  ).map((a) => a.subject);

  // Rules not checked today, grouped by reason.
  const ruleInfo = await db
    .select({
      id: exitRules.id,
      ruleType: exitRules.ruleType,
      symbol: instruments.symbol,
      name: instruments.name,
      type: instruments.instrumentType,
    })
    .from(exitRules)
    .innerJoin(instruments, eq(exitRules.instrumentId, instruments.id));
  const infoBy = new Map(ruleInfo.map((r) => [r.id, r]));
  const nc = new Map<string, string[]>();
  for (const e of todaysEvals.filter((x) => x.outcome === 'not_checked')) {
    const r = infoBy.get(e.exitRuleId);
    if (!r) continue;
    const key = REASON_TEXT[e.reason ?? ''] ?? e.reason ?? 'unknown';
    nc.set(key, [...(nc.get(key) ?? []), `${display(r)} ${r.ruleType}`]);
  }

  // Filings and headlines since the previous digest, per ticker we follow.
  const universe = await loadUniverse(db);
  const tickers = universe.newsSymbols;
  const heldSymbols = new Set(lotRows.map((l) => l.underlying ?? l.symbol));
  const order = (a: string, b: string) =>
    Number(heldSymbols.has(b)) - Number(heldSymbols.has(a)) || a.localeCompare(b);

  const fRows = tickers.length
    ? await db
        .select()
        .from(filings)
        .where(
          and(
            inArray(filings.ticker, tickers),
            gt(filings.filedAt, since),
            lte(filings.filedAt, until),
          ),
        )
        .orderBy(desc(filings.filedAt))
    : [];
  const filingGroups = [...new Set(fRows.map((f) => f.ticker!))].sort(order).map((ticker) => ({
    ticker,
    items: fRows
      .filter((f) => f.ticker === ticker)
      .map((f) => ({ form: f.form, items: f.items, filedAt: f.filedAt, url: f.url })),
  }));

  // Filings for the new layout: one item per filing; Form 4s with open-market buys/sells listed
  // per filing, the rest grouped into one line (holdings, then the watchlist).
  const filingList: DigestFiling[] = [];
  for (const held of [true, false]) {
    const form4Counts = new Map<string, number>();
    for (const ticker of filingGroups
      .map((g) => g.ticker)
      .filter((t) => heldSymbols.has(t) === held)) {
      // Notable filings (results, dilution, management change…) first, then newest first.
      const notable = (x: (typeof fRows)[number]) => {
        const ft = filingTitle(x.form, x.items);
        return ft.notable || ft.dilution;
      };
      const rows = fRows
        .filter((x) => x.ticker === ticker)
        .sort((a, b) => Number(notable(b)) - Number(notable(a)));
      for (const f of rows) {
        const t = filingTitle(f.form, f.items);
        if (f.form === '4' || f.form === '4/A') {
          const s = (f.details as { form4?: Form4Summary } | null)?.form4;
          const trades = s ? summarizeTrades(s.trades) : [];
          if (trades.length === 0) {
            form4Counts.set(ticker, (form4Counts.get(ticker) ?? 0) + 1);
            continue;
          }
          filingList.push({
            tickers: [ticker],
            held,
            title: `Form 4 · open-market ${[...new Set(trades.map((x) => (x.code === 'P' ? 'buy' : 'sale')))].join(' & ')}`,
            itemsNote: null,
            strong: true,
            url: f.url,
            filedAt: f.filedAt,
            trades,
          });
          continue;
        }
        filingList.push({
          tickers: [ticker],
          held,
          title: t.title,
          itemsNote: t.itemsNote,
          strong: t.notable || t.dilution,
          url: f.url,
          filedAt: f.filedAt,
          trades: [],
        });
      }
    }
    if (form4Counts.size) {
      filingList.push({
        tickers: [...form4Counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)),
        held,
        title: 'Form 4 · insider filings · no open-market buys/sells',
        itemsNote: null,
        strong: false,
        url: null,
        filedAt: null,
        trades: [],
      });
    }
  }
  const filingCounts = {
    total: fRows.length,
    earnings8k: fRows.filter((f) => filingTitle(f.form, f.items).earnings).length,
  };

  const nRows = await db
    .select({
      headline: newsItems.headline,
      url: newsItems.url,
      source: newsItems.source,
      publishedAt: newsItems.publishedAt,
      symbols: newsItems.symbols,
    })
    .from(newsItems)
    .where(and(gt(newsItems.publishedAt, since), lte(newsItems.publishedAt, until)))
    .orderBy(desc(newsItems.publishedAt));
  const headlines = tickers
    .map((ticker) => {
      const all = nRows.filter((n) => n.symbols.includes(ticker));
      return {
        ticker,
        items: all
          .slice(0, HEADLINES_PER_TICKER)
          .map(({ headline, url, publishedAt }) => ({ headline, url, publishedAt })),
        more: Math.max(0, all.length - HEADLINES_PER_TICKER),
      };
    })
    .filter((h) => h.items.length)
    .sort((a, b) => order(a.ticker, b.ticker));

  const heldList = [...heldSymbols].sort();
  const headlineSelection = selectHeadlines(nRows, {
    holdings: heldList,
    watchlist: tickers.filter((t) => !heldSymbols.has(t)),
  });

  const feedIssues = (await db.select().from(feedStatus))
    .filter((f) => !f.feed.includes(':') && (f.status === 'degraded' || f.status === 'down'))
    .map((f) => ({ feed: f.feed, status: f.status, detail: f.detail, since: f.since }));

  // Weekly: rules to write and missing user input.
  let rulesToWrite: DigestData['rulesToWrite'] = [];
  let needsInput: string[] = [];
  if (weekly) {
    const tw = new Map<string, string[]>();
    for (const r of rules) {
      if (!isRuleToWrite({ ruleType: r.ruleType, thesisBreakTriggers: r.judgment })) continue;
      const info = infoBy.get(r.id)!;
      tw.set(display(info), [...(tw.get(display(info)) ?? []), r.purpose.replace('_', ' ')]);
    }
    rulesToWrite = [...tw]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([d, purposes]) => ({ display: d, purposes }));
    const theses = await db
      .select({
        symbol: instruments.symbol,
        name: instruments.name,
        type: instruments.instrumentType,
        needs: positionTheses.needsInput,
      })
      .from(positionTheses)
      .innerJoin(instruments, eq(positionTheses.instrumentId, instruments.id))
      .orderBy(asc(instruments.symbol));
    needsInput = [
      ...lotRows
        .filter((l) => l.unconfirmed)
        .map((l) => `${l.symbol} (${ACCOUNT_LABEL[l.account]}): confirm the fill`),
      ...theses
        .filter((t) => t.needs.length)
        .map((t) => `${display(t)}: ${t.needs.map((n) => n.replace(/_/g, ' ')).join(', ')}`),
    ];
  }

  return {
    date,
    generatedAt: now,
    since,
    until,
    weekly,
    positions: positions.sort(byDayMoveDesc),
    active,
    alertsToday,
    notChecked: [...nc].map(([reason, items]) => ({ reason, items })),
    filings: filingGroups,
    headlines,
    feedIssues,
    rulesToWrite,
    needsInput,
    portfolio,
    attention,
    levelsToWatch: levelsToWatch(levelInputs, { ...WATCH_WITHIN, asOfDate: date }),
    filingList,
    filingCounts,
    headlineSelection,
    pullbacks: await loadPullbackSummary(db, date),
    alertMix: alertsToday.reduce<Partial<Record<AttentionTag, number>>>((acc, subject) => {
      const tag = /\[AIA\] (ACTION|WARNING|REVIEW|REMINDER)\b/.exec(subject)?.[1] as
        AttentionTag | undefined;
      if (tag) acc[tag] = (acc[tag] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

/** The session whose digest should go out now (trading day, 2:15 PM PT passed, not yet sent). */
export function digestDue(
  sessionDates: readonly string[],
  now: Date,
  lastDigestDate: string | null,
): string | null {
  const today = nyDate(now);
  if (!sessionDates.includes(today)) return null;
  if (now < digestTimeFor(today)) return null;
  if (lastDigestDate && lastDigestDate >= today) return null;
  return today;
}
