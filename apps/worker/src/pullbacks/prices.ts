/**
 * Prices for the pullback screen.
 * - History: SIP daily bars (official closes, 15-min delayed on the free plan) in prices_daily,
 *   backfilled `historyYears` for every screened symbol (P/E medians need years of closes).
 * - Live (Open/Midday checks): Alpaca IEX latest trade (real time, one venue); symbols Alpaca
 *   doesn't return fall back to Twelve Data within its budget. Every price records its source
 *   and timestamp.
 */
import { addDays, nyDate, type PriceBar } from '@aia/core';
import { pricesDaily, type Db } from '@aia/db';
import { and, asc, gte, inArray, min } from 'drizzle-orm';
import type { AlpacaClient, Feed } from '../alpaca/client';
import type { AlpacaSnapshot } from '../alpaca/schemas';
import type { JobResult } from '../lib/jobs';
import { log } from '../lib/log';
import { collectDailyBars } from '../market/bars';
import type { PullbackConfig } from './config';
import type { TwelveDataClient } from './twelvedata';

export const INTRADAY_LABEL = 'intraday, single venue, may differ from the close';

export interface LivePrice {
  symbol: string;
  price: number;
  at: Date;
  source: 'alpaca:iex' | 'twelvedata';
}

/** The snapshot's latest trade if it happened today (New York date), else null (pure). */
export function liveFromSnapshot(
  symbol: string,
  snap: AlpacaSnapshot | undefined,
  today: string,
): LivePrice | null {
  const t = snap?.latestTrade;
  if (!t || !(t.p > 0)) return null;
  const at = new Date(t.t);
  if (Number.isNaN(at.getTime()) || nyDate(at) !== today) return null;
  return { symbol, price: t.p, at, source: 'alpaca:iex' };
}

export interface LivePriceResult {
  prices: Map<string, LivePrice>;
  stats: {
    requested: number;
    alpaca: number;
    twelveData: number;
    missing: string[];
    errors: string[];
    rateLimitRetries: number;
    twelveDataSkipped: number;
  };
}

/** Latest trades for today: Alpaca IEX first, then Twelve Data for what's missing. */
export async function fetchLivePrices(
  db: Db,
  p: {
    alpaca: AlpacaClient;
    twelveData: TwelveDataClient | null;
    cfg: PullbackConfig;
    symbols: readonly string[];
    now?: Date;
  },
): Promise<LivePriceResult> {
  const now = p.now ?? new Date();
  const today = nyDate(now);
  const prices = new Map<string, LivePrice>();
  const errors: string[] = [];
  try {
    const snaps = await p.alpaca.snapshots(p.symbols, 'iex');
    for (const s of p.symbols) {
      const live = liveFromSnapshot(s, snaps.get(s), today);
      if (live) prices.set(s, live);
    }
  } catch (error) {
    errors.push(`alpaca snapshots: ${String(error)}`);
    log.warn('alpaca snapshots failed; trying Twelve Data for all', { error: String(error) });
  }
  const alpacaCount = prices.size;

  let missing = p.symbols.filter((s) => !prices.has(s));
  let rateLimitRetries = 0;
  let skipped = 0;
  if (missing.length && p.twelveData) {
    const td = await p.twelveData.quotes(db, missing, p.cfg.prices.twelveData);
    for (const q of td.quotes.values()) {
      if (nyDate(q.at) === today) {
        prices.set(q.symbol, { symbol: q.symbol, price: q.price, at: q.at, source: 'twelvedata' });
      }
    }
    errors.push(...td.errors);
    rateLimitRetries = td.rateLimited;
    skipped = td.skipped.length;
    missing = p.symbols.filter((s) => !prices.has(s));
  }
  return {
    prices,
    stats: {
      requested: p.symbols.length,
      alpaca: alpacaCount,
      twelveData: prices.size - alpacaCount,
      missing,
      errors,
      rateLimitRetries,
      twelveDataSkipped: skipped,
    },
  };
}

/**
 * Daily bars for the screen universe: a full `historyYears` backfill for symbols whose stored
 * history starts too late, then a short refresh for all.
 */
export async function collectScreenBars(
  db: Db,
  alpaca: AlpacaClient,
  p: { symbols: readonly string[]; historyYears: number; feed: Feed; now?: Date },
): Promise<JobResult> {
  const now = p.now ?? new Date();
  const fullDays = Math.ceil(p.historyYears * 365.25) + 7;
  const wantFrom = addDays(nyDate(now), -fullDays + 14);
  const earliest = await db
    .select({ symbol: pricesDaily.symbol, first: min(pricesDaily.date) })
    .from(pricesDaily)
    .where(inArray(pricesDaily.symbol, [...p.symbols]))
    .groupBy(pricesDaily.symbol);
  const firstBy = new Map(earliest.map((r) => [r.symbol, r.first]));
  const needFull = p.symbols.filter((s) => {
    const first = firstBy.get(s);
    return !first || first > wantFrom;
  });
  const universe = (symbols: readonly string[]) => ({
    priceSymbols: [...symbols],
    newsSymbols: [],
    optionContracts: [],
  });
  let backfill: JobResult | null = null;
  if (needFull.length) {
    log.info('screen bars: full history backfill', {
      symbols: needFull.length,
      years: p.historyYears,
    });
    backfill = await collectDailyBars(db, alpaca, {
      universe: universe(needFull),
      days: fullDays,
      feed: p.feed,
      now,
    });
  }
  const refresh = await collectDailyBars(db, alpaca, {
    universe: universe(p.symbols),
    days: 10,
    feed: p.feed,
    now,
  });
  return {
    items: (backfill?.items ?? 0) + (refresh.items ?? 0),
    meta: {
      symbols: p.symbols.length,
      backfilled: needFull.length,
      backfillMeta: backfill?.meta ?? null,
      refreshMeta: refresh.meta,
    },
  };
}

/** Stored daily bars per symbol for the last `days` (oldest first). */
export async function loadDailyBars(
  db: Db,
  symbols: readonly string[],
  asOf: string,
  days = 400,
): Promise<Map<string, PriceBar[]>> {
  const rows = symbols.length
    ? await db
        .select({
          symbol: pricesDaily.symbol,
          date: pricesDaily.date,
          high: pricesDaily.high,
          low: pricesDaily.low,
          close: pricesDaily.close,
        })
        .from(pricesDaily)
        .where(
          and(
            inArray(pricesDaily.symbol, [...symbols]),
            gte(pricesDaily.date, addDays(asOf, -days)),
          ),
        )
        .orderBy(asc(pricesDaily.date))
    : [];
  const out = new Map<string, PriceBar[]>();
  for (const r of rows) {
    if (r.date > asOf) continue;
    const list = out.get(r.symbol) ?? [];
    list.push({ date: r.date, high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    out.set(r.symbol, list);
  }
  return out;
}
