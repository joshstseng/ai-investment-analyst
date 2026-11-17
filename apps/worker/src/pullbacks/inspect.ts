/** CLI helpers for the pullback screen (Part 1): universe refresh, screen bars, price metrics. */
import { nyDate, priceMetrics, type PriceMetrics, type Scorecard } from '@aia/core';
import { pullbackObservations, pullbackState, scorecards } from '@aia/db';
import { asc, desc, inArray, isNotNull, max } from 'drizzle-orm';
import type { Context } from '../context';
import { runJob } from '../lib/jobs';
import { loadPullbackConfig } from './config';
import { collectScreenBars, fetchLivePrices, INTRADAY_LABEL, loadDailyBars } from './prices';
import { loadScreenUniverse } from './universe';
import { refreshUniverse } from './universe-refresh';

export async function universeRefreshCommand(ctx: Context) {
  const res = await refreshUniverse({
    sec: ctx.requireSec(),
    alpaca: ctx.alpaca,
    cfg: loadPullbackConfig(),
  });
  console.log(
    `S&P 500: ${res.sp500} members · Nasdaq-100: ${res.nasdaq100} members\nTop 10: ${res.top10.join(', ')}\n` +
      `#${res.cutoff?.rank} cutoff: ${res.cutoff?.symbol} ($${((res.cutoff?.marketCapUsd ?? 0) / 1e9).toFixed(0)}B)\n` +
      `Not sized (no SEC share count; add large ones to config "extra"): ${res.unsized.join(', ') || 'none'}`,
  );
}

export async function screenBarsCommand(ctx: Context, years?: number) {
  const cfg = loadPullbackConfig();
  const universe = await loadScreenUniverse(ctx.db, cfg);
  const res = await runJob(ctx.db, 'screen_bars', () =>
    collectScreenBars(ctx.db, ctx.alpaca, {
      symbols: universe.map((m) => m.symbol),
      historyYears: years ?? cfg.prices.historyYears,
      feed: ctx.env.ALPACA_BARS_FEED,
    }),
  );
  console.log(JSON.stringify(res.meta, null, 2));
}

const f = (n: number | null, d = 2) => (n === null ? '—' : n.toFixed(d));

/** Prints price metrics for the universe, deepest pullbacks first. --live adds intraday prices. */
export async function screenPricesCommand(
  ctx: Context,
  opts: { live: boolean; symbols?: string[] },
) {
  const cfg = loadPullbackConfig();
  const universe = await loadScreenUniverse(ctx.db, cfg);
  const symbols = opts.symbols?.length ? opts.symbols : universe.map((m) => m.symbol);
  const today = nyDate(new Date());
  const bars = await loadDailyBars(ctx.db, symbols, today);
  const live = opts.live
    ? await fetchLivePrices(ctx.db, {
        alpaca: ctx.alpaca,
        twelveData: ctx.twelveData,
        cfg,
        symbols,
      })
    : null;
  const rows: { s: string; m: PriceMetrics; src: string }[] = [];
  const noHistory: string[] = [];
  for (const s of symbols) {
    const lp = live?.prices.get(s);
    const m = priceMetrics(bars.get(s) ?? [], {
      live: lp ? { price: lp.price, date: today } : null,
      dropWindowDays: cfg.qualify.multiDayWindowDays,
    });
    if (!m) noHistory.push(s);
    else
      rows.push({
        s,
        m,
        src: lp ? `${lp.source} ${lp.at.toISOString().slice(11, 19)}Z` : 'sip close',
      });
  }
  rows.sort((a, b) => b.m.belowHighPct - a.m.belowHighPct);
  console.log(
    `${symbols.length} symbols · ${universe.length} in universe${live ? ` · live: ${live.stats.alpaca} Alpaca IEX, ${live.stats.twelveData} Twelve Data, missing ${live.stats.missing.length} (${INTRADAY_LABEL})` : ''}`,
  );
  console.log(
    'symbol   price      prev     high52    low52   below%   d1%    d5%  worst(k)  atr14   source',
  );
  for (const { s, m, src } of rows) {
    console.log(
      `${s.padEnd(7)} ${f(m.price).padStart(8)} ${f(m.prevClose).padStart(9)} ${f(m.high52).padStart(9)} ${f(m.low52).padStart(8)} ${f(m.belowHighPct, 1).padStart(7)} ${f(m.d1Pct, 1).padStart(6)} ${f(m.d5Pct, 1).padStart(6)} ${`${f(m.worstDropPct, 1)}(${m.worstDropDays})`.padStart(9)} ${f(m.atr14).padStart(7)}   ${src}`,
    );
  }
  if (noHistory.length) console.log(`No price history: ${noHistory.join(', ')}`);
  if (live?.stats.missing.length) console.log(`No live price: ${live.stats.missing.join(', ')}`);
}

const big = (n: number | null | undefined) =>
  n === null || n === undefined
    ? '—'
    : Math.abs(n) >= 1e12
      ? `${(n / 1e12).toFixed(2)}T`
      : Math.abs(n) >= 1e9
        ? `${(n / 1e9).toFixed(1)}B`
        : `${(n / 1e6).toFixed(0)}M`;

/** Prints stored scorecards: quality pass/fail with reasons, key numbers. */
export async function scorecardCommand(ctx: Context, symbols?: string[]) {
  const rows = await ctx.db
    .select()
    .from(scorecards)
    .where(symbols?.length ? inArray(scorecards.symbol, symbols) : undefined)
    .orderBy(desc(scorecards.qualityPass), asc(scorecards.symbol));
  const pass = rows.filter((r) => r.qualityPass).length;
  console.log(`${rows.length} scorecards · ${pass} pass quality · ${rows.length - pass} fail`);
  console.log(
    'symbol  Q   rev TTM   y/y   3y CAGR  gross  oper   net   FCF mgn  net cash  dil y/y  P/E med  P/FCF med  why not',
  );
  for (const r of rows) {
    const s = r.scorecard as Partial<Scorecard> & { notes?: string[] };
    const p = (x: number | null | undefined, d = 1) =>
      x === null || x === undefined ? '—' : x.toFixed(d);
    console.log(
      `${r.symbol.padEnd(7)} ${r.qualityPass ? '✓' : '✗'} ${big(s.revenueTtm).padStart(9)} ${p(s.revenueYoYPct).padStart(5)} ${p(s.revenueCagr3yPct).padStart(8)} ${p(s.grossMarginPct).padStart(6)} ${p(s.operatingMarginPct).padStart(5)} ${p(s.netMarginPct).padStart(5)} ${p(s.fcfMarginPct).padStart(8)} ${big(s.netCash).padStart(9)} ${p(s.dilutionYoYPct).padStart(7)} ${p(s.peMedian).padStart(8)} ${p(s.pfcfMedian).padStart(10)}  ${r.qualityReasons.join('; ')}${s.currency && s.currency !== 'USD' ? ` [${s.currency}]` : ''}`,
    );
  }
}

/** Current screen: every ticker in an episode, with its tier and the latest observation. */
export async function pullbacksCommand(ctx: Context) {
  const states = await ctx.db
    .select()
    .from(pullbackState)
    .where(isNotNull(pullbackState.qualifiedSince))
    .orderBy(desc(pullbackState.lastAlertedTier), asc(pullbackState.symbol));
  const latest = await ctx.db
    .select()
    .from(pullbackObservations)
    .where(
      inArray(
        pullbackObservations.id,
        ctx.db
          .select({ id: max(pullbackObservations.id) })
          .from(pullbackObservations)
          .groupBy(pullbackObservations.symbol),
      ),
    );
  const obs = new Map(latest.map((o) => [o.symbol, o]));
  console.log(`${states.length} tickers in a pullback episode`);
  console.log(
    'symbol  tier  alerted  since       last check            price     below%   d1%  quality  reasons',
  );
  for (const s of states) {
    const o = obs.get(s.symbol);
    console.log(
      `${s.symbol.padEnd(7)} ${String(s.currentTier ?? '—').padStart(4)} ${String(s.lastAlertedTier ?? '—').padStart(8)}  ${s.qualifiedSince}  ${o ? `${o.date} ${o.check.padEnd(6)}` : '—'.padEnd(17)}  ${o ? Number(o.price).toFixed(2).padStart(9) : ''} ${o ? Number(o.belowHighPct).toFixed(1).padStart(7) : ''} ${o ? Number(o.d1Pct).toFixed(1).padStart(5) : ''}  ${o?.qualityPass === false ? 'FAIL' : o?.qualityPass ? 'pass' : '—'}     ${o?.reasons.join(',') ?? ''}${o?.windowStart ? ` (52w from spin-off ${o.windowStart})` : ''}`,
    );
  }
}
