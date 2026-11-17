/**
 * One pullback check (Open / Midday / EOD): prices → metrics → decisions → state and
 * observations. Emails are sent by the caller from the returned alerts (Part 4).
 *
 * - Eligible: tickers that pass the quality filter, plus holdings and watchlist (always checked,
 *   flagged when they fail quality).
 * - Open/Midday: live IEX trades (Twelve Data fallback). EOD: official SIP closes (bars refreshed
 *   first). EOD is the source of truth for resets.
 * - First run: with no stored state, the first EOD run is a silent baseline (state recorded,
 *   alert kind "baseline"); Open/Midday checks wait for it.
 */
import {
  addDays,
  decidePullback,
  priceMetrics,
  type PriceMetrics,
  type PullbackCheck,
  type PullbackDecision,
  type PullbackState,
  type Scorecard,
} from '@aia/core';
import { alerts, pullbackObservations, pullbackState, scorecards, type Db } from '@aia/db';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { AlpacaClient, Feed } from '../alpaca/client';
import type { JobResult } from '../lib/jobs';
import { log } from '../lib/log';
import type { PullbackConfig } from './config';
import { collectScreenBars, fetchLivePrices, loadDailyBars, type LivePrice } from './prices';
import type { TwelveDataClient } from './twelvedata';
import { loadScreenUniverse, type UniverseSource } from './universe';

export interface PullbackResult {
  symbol: string;
  sources: UniverseSource[];
  metrics: PriceMetrics;
  price: { value: number; at: Date; source: string };
  decision: PullbackDecision;
  qualityPass: boolean | null;
  qualityReasons: string[];
  scorecard: Scorecard | null;
  marketCapUsd: number | null;
  windowStart: string | null;
}

export interface CheckOutcome extends JobResult {
  check: PullbackCheck;
  date: string;
  baseline: boolean;
  /** Tickers with an alert decided this run (excluding the silent baseline). */
  alerts: PullbackResult[];
  /** Every ticker currently qualifying, and EOD reversals/resets. */
  results: PullbackResult[];
}

const toState = (r: typeof pullbackState.$inferSelect): PullbackState => ({
  currentTier: r.currentTier,
  lastAlertedTier: r.lastAlertedTier,
  lastAlertedAt: r.lastAlertedAt?.toISOString() ?? null,
  lastAlertedCheck: (r.lastAlertedCheck as PullbackCheck | null) ?? null,
  qualifiedSince: r.qualifiedSince,
  alertedOneDayDropDate: r.alertedOneDayDropDate,
});

/** Spin-off ex-dates within the last year, per source symbol (latest wins). */
async function spinOffWindows(alpaca: AlpacaClient, symbols: string[], date: string) {
  const out = new Map<string, string>();
  try {
    for (const s of await alpaca.spinOffs({ symbols, start: addDays(date, -365), end: date })) {
      const prev = out.get(s.source_symbol);
      if (s.ex_date <= date && (!prev || s.ex_date > prev)) out.set(s.source_symbol, s.ex_date);
    }
  } catch (error) {
    log.warn('spin-off lookup failed; using plain 52-week windows', { error: String(error) });
  }
  return out;
}

export async function runPullbackCheck(
  p: {
    db: Db;
    alpaca: AlpacaClient;
    twelveData: TwelveDataClient | null;
    cfg: PullbackConfig;
    feed: Feed;
  },
  check: PullbackCheck,
  date: string,
  now = new Date(),
  /** Previews: write nothing, limit to `symbols`, and treat them as new (no prior state). */
  preview?: { symbols: string[] },
): Promise<CheckOutcome> {
  const { db, cfg } = p;
  const [{ n: stateRows }] = (await db.select({ n: count() }).from(pullbackState)) as [
    { n: number },
  ];
  const baseline = !preview && stateRows === 0;
  if (baseline && check !== 'eod') {
    return {
      items: 0,
      check,
      date,
      baseline,
      alerts: [],
      results: [],
      meta: { check, date, skipped: 'waiting for the first EOD check (silent baseline)' },
    };
  }

  // Universe, quality and eligibility.
  const universe = await loadScreenUniverse(db, cfg);
  const cards = new Map((await db.select().from(scorecards)).map((c) => [c.symbol, c] as const));
  const eligible = universe.filter((m) =>
    preview
      ? preview.symbols.includes(m.symbol)
      : cards.get(m.symbol)?.qualityPass ||
        m.sources.includes('holding') ||
        m.sources.includes('watchlist'),
  );
  const symbols = eligible.map((m) => m.symbol);

  // Prices.
  let live: Map<string, LivePrice> | null = null;
  const sourceStats: Record<string, number> = {};
  let errors: string[] = [];
  let rateLimitRetries = 0;
  if (check === 'eod') {
    await collectScreenBars(db, p.alpaca, {
      symbols,
      historyYears: cfg.prices.historyYears,
      feed: p.feed,
      now,
    });
  } else {
    const res = await fetchLivePrices(db, {
      alpaca: p.alpaca,
      twelveData: p.twelveData,
      cfg,
      symbols,
      now,
    });
    live = res.prices;
    sourceStats['alpaca:iex'] = res.stats.alpaca;
    sourceStats.twelvedata = res.stats.twelveData;
    errors = res.stats.errors;
    rateLimitRetries = res.stats.rateLimitRetries;
  }
  const bars = await loadDailyBars(db, symbols, date);
  const windows = await spinOffWindows(p.alpaca, symbols, date);

  // State and same-day rule alerts (they suppress the one-day-drop alert).
  const states = new Map(
    (symbols.length
      ? await db.select().from(pullbackState).where(inArray(pullbackState.symbol, symbols))
      : []
    ).map((r) => [r.symbol, toState(r)] as const),
  );
  const ruleAlerted = new Set(
    (
      await db
        .select({ symbol: alerts.symbol })
        .from(alerts)
        .where(and(eq(alerts.kind, 'rule'), eq(alerts.asOfDate, date)))
    ).map((r) => r.symbol),
  );

  const results: PullbackResult[] = [];
  const missing: string[] = [];
  for (const member of eligible) {
    const s = member.symbol;
    const history = bars.get(s) ?? [];
    const lp = live?.get(s);
    let metrics: PriceMetrics | null;
    let price: PullbackResult['price'];
    if (check === 'eod') {
      // The official close for today must be stored; otherwise the ticker is reported missing.
      if (history.at(-1)?.date !== date) {
        missing.push(s);
        continue;
      }
      metrics = priceMetrics(history, {
        dropWindowDays: cfg.qualify.multiDayWindowDays,
        windowStart: windows.get(s) ?? null,
      });
      price = { value: history.at(-1)!.close, at: now, source: `alpaca:${p.feed}` };
    } else {
      if (!lp) {
        missing.push(s);
        continue;
      }
      metrics = priceMetrics(history, {
        live: { price: lp.price, date },
        dropWindowDays: cfg.qualify.multiDayWindowDays,
        windowStart: windows.get(s) ?? null,
      });
      price = { value: lp.price, at: lp.at, source: lp.source };
    }
    if (!metrics) {
      missing.push(s);
      continue;
    }
    const decision = decidePullback(preview ? null : (states.get(s) ?? null), metrics, {
      check,
      date,
      now,
      rules: cfg,
      suppressOneDayDrop: ruleAlerted.has(s),
    });
    const card = cards.get(s);
    results.push({
      symbol: s,
      sources: member.sources,
      metrics,
      price,
      decision,
      qualityPass: card ? card.qualityPass : null,
      qualityReasons: card?.qualityReasons ?? ['no scorecard'],
      scorecard: (card?.scorecard as Scorecard | undefined) ?? null,
      marketCapUsd: card?.marketCapUsd ? Number(card.marketCapUsd) : null,
      windowStart: windows.get(s) ?? null,
    });
    if (check === 'eod') sourceStats[price.source] = (sourceStats[price.source] ?? 0) + 1;
  }

  // Persist state and observations.
  if (!preview)
    await db.transaction(async (tx) => {
      for (const r of results) {
        const n = r.decision.next;
        const row = {
          symbol: r.symbol,
          currentTier: n.currentTier,
          lastAlertedTier: n.lastAlertedTier,
          lastAlertedAt: n.lastAlertedAt ? new Date(n.lastAlertedAt) : null,
          lastAlertedCheck: n.lastAlertedCheck,
          qualifiedSince: n.qualifiedSince,
          alertedOneDayDropDate: n.alertedOneDayDropDate,
          updatedAt: now,
        };
        await tx
          .insert(pullbackState)
          .values(row)
          .onConflictDoUpdate({ target: pullbackState.symbol, set: row });
        const m = r.metrics;
        const obs = {
          date,
          check,
          checkedAt: now,
          symbol: r.symbol,
          price: String(r.price.value),
          priceAt: r.price.at,
          priceSource: r.price.source,
          intraday: m.intraday,
          prevClose: String(m.prevClose),
          high52: String(m.high52),
          high52Date: m.high52Date,
          low52: String(m.low52),
          belowHighPct: String(m.belowHighPct),
          d1Pct: String(m.d1Pct),
          d5Pct: m.d5Pct === null ? null : String(m.d5Pct),
          worstDropPct: String(m.worstDropPct),
          worstDropDays: m.worstDropDays,
          atr14: m.atr14 === null ? null : String(m.atr14),
          windowStart: r.windowStart,
          qualifies: r.decision.q.qualifies,
          reasons: r.decision.q.reasons,
          tier: r.decision.q.tier,
          gapDown: r.decision.q.gapDown,
          qualityPass: r.qualityPass,
          alertKinds: r.decision.alert ? (baseline ? ['baseline'] : r.decision.alert.kinds) : [],
          reversedTier: r.decision.reversed?.tier ?? null,
          reset: r.decision.reset,
          scorecard:
            r.decision.q.qualifies && r.scorecard
              ? (r.scorecard as unknown as Record<string, unknown>)
              : null,
          updatedAt: now,
        };
        await tx
          .insert(pullbackObservations)
          .values(obs)
          .onConflictDoUpdate({
            target: [
              pullbackObservations.date,
              pullbackObservations.check,
              pullbackObservations.symbol,
            ],
            set: { ...obs, createdAt: sql`${pullbackObservations.createdAt}` },
          });
      }
    });

  const decided = results.filter((r) => r.decision.alert);
  const qualifying = results.filter((r) => r.decision.q.qualifies);
  return {
    items: results.length,
    check,
    date,
    baseline,
    alerts: baseline ? [] : decided,
    results: results.filter(
      (r) => r.decision.q.qualifies || r.decision.reversed || r.decision.reset,
    ),
    meta: {
      check,
      date,
      baseline,
      universe: universe.length,
      eligible: eligible.length,
      skippedQuality: universe.length - eligible.length,
      screened: results.length,
      qualifiers: qualifying.length,
      alertsDecided: decided.length,
      alertTickers: decided.map((r) => `${r.symbol}:${r.decision.alert!.kinds.join('+')}`),
      reversed: results.filter((r) => r.decision.reversed).map((r) => r.symbol),
      resets: results.filter((r) => r.decision.reset).map((r) => r.symbol),
      spinOffWindows: Object.fromEntries(windows),
      sources: sourceStats,
      missing,
      errors: errors.slice(0, 10),
      rateLimitRetries,
      emailsSent: 0,
    },
  };
}
