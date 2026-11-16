import { addDays, nyDate } from '@aia/core';
import { pricesDaily, symbolDataStatus, type Db } from '@aia/db';
import { and, count, eq, getTableColumns, inArray, or, sql } from 'drizzle-orm';
import { isSubscriptionError, type AlpacaClient, type Feed } from '../alpaca/client';
import type { AlpacaBar } from '../alpaca/schemas';
import type { JobResult } from '../lib/jobs';
import { log } from '../lib/log';
import { loadSessions, type Session } from './calendar';
import { NO_OPTION_PRICES_NOTE, setDataStatus, type DataStatusRow } from './data-status';
import type { Universe } from './universe';

/** SIP data on the free plan is only queryable 15 minutes after the fact; keep a margin. */
export const BAR_SETTLE_MS = 16 * 60 * 1000;

/** Days of history a full backfill covers. */
export const FULL_HISTORY_DAYS = 365;

export interface BarRow {
  symbol: string;
  date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: number;
  vwap: string | null;
  tradeCount: number | null;
  source: string;
  receivedAt: Date;
}

/**
 * Converts Alpaca daily bars to rows, keeping only bars for sessions that have closed (plus the
 * settle margin). A partial bar for today must never reach the close-based rules.
 */
export function toBarRows(
  symbol: string,
  bars: readonly AlpacaBar[],
  sessions: ReadonlyMap<string, Session>,
  now: Date,
  source: string,
) {
  const rows: BarRow[] = [];
  let incomplete = 0;
  const unknownDates: string[] = [];
  for (const b of bars) {
    const date = nyDate(new Date(b.t));
    const session = sessions.get(date);
    if (!session) {
      unknownDates.push(date);
      continue;
    }
    if (session.closeAt.getTime() + BAR_SETTLE_MS > now.getTime()) {
      incomplete++;
      continue;
    }
    rows.push({
      symbol,
      date,
      open: String(b.o),
      high: String(b.h),
      low: String(b.l),
      close: String(b.c),
      volume: b.v,
      vwap: b.vw === undefined ? null : String(b.vw),
      tradeCount: b.n ?? null,
      source,
      receivedAt: now,
    });
  }
  return { rows, incomplete, unknownDates };
}

async function upsertBars(db: Db, rows: BarRow[]) {
  const cols = getTableColumns(pricesDaily);
  const keys = ['open', 'high', 'low', 'close', 'volume', 'vwap', 'tradeCount', 'source'] as const;
  let written = 0;
  for (let i = 0; i < rows.length; i += 2000) {
    const res = await db
      .insert(pricesDaily)
      .values(rows.slice(i, i + 2000))
      .onConflictDoUpdate({
        target: [pricesDaily.symbol, pricesDaily.date],
        set: {
          ...Object.fromEntries(keys.map((k) => [k, sql.raw(`excluded."${cols[k].name}"`)])),
          receivedAt: sql`excluded.received_at`,
        },
        // Only rewrite a stored bar if Alpaca's values changed (e.g. a late correction).
        setWhere: or(
          ...keys.map(
            (k) => sql`${cols[k]} IS DISTINCT FROM ${sql.raw(`excluded."${cols[k].name}"`)}`,
          ),
        ),
      })
      .returning({ symbol: pricesDaily.symbol });
    written += res.length;
  }
  return written;
}

export async function collectDailyBars(
  db: Db,
  client: AlpacaClient,
  p: { universe: Universe; days: number; feed: Feed; now?: Date },
): Promise<JobResult> {
  const now = p.now ?? new Date();
  const symbols = p.universe.priceSymbols;

  // Symbols added since the last full backfill (e.g. new watchlist tickers) get a year of
  // history now, rather than waiting for the next worker restart. Symbols known to have no
  // data source are skipped so they don't cost a request on every refresh.
  let backfilled: string[] = [];
  if (p.days < FULL_HISTORY_DAYS) {
    const [stored, noData] = await Promise.all([
      db
        .selectDistinct({ symbol: pricesDaily.symbol })
        .from(pricesDaily)
        .where(inArray(pricesDaily.symbol, [...symbols])),
      db
        .select({ symbol: symbolDataStatus.symbol })
        .from(symbolDataStatus)
        .where(
          and(
            eq(symbolDataStatus.dataset, 'daily_bars'),
            eq(symbolDataStatus.status, 'no_data_source'),
          ),
        ),
    ]);
    const skip = new Set([...stored, ...noData].map((r) => r.symbol));
    backfilled = symbols.filter((s) => !skip.has(s));
    if (backfilled.length) {
      log.info('backfilling a year of bars for new symbols', { symbols: backfilled });
      await collectDailyBars(db, client, {
        ...p,
        universe: { ...p.universe, priceSymbols: backfilled, optionContracts: [] },
        days: FULL_HISTORY_DAYS,
      });
    }
  }

  const start = addDays(nyDate(now), -p.days);
  const sessions = await loadSessions(db, addDays(start, -5), nyDate(now));
  if (sessions.size === 0) throw new Error('market_calendar is empty; run the calendar sync first');

  let feed = p.feed;
  const end = new Date(now.getTime() - BAR_SETTLE_MS).toISOString();
  let barsBySymbol;
  try {
    barsBySymbol = await client.dailyBars({ symbols, start, end, feed });
  } catch (error) {
    if (!(feed === 'sip' && isSubscriptionError(error))) throw error;
    log.warn('SIP bars not permitted on this plan; falling back to IEX', { error: String(error) });
    feed = 'iex';
    barsBySymbol = await client.dailyBars({ symbols, start, end, feed });
  }
  const source = `alpaca:${feed}`;

  const allRows: BarRow[] = [];
  let incomplete = 0;
  const statuses: DataStatusRow[] = [];
  const empty: string[] = [];
  for (const symbol of symbols) {
    const result = toBarRows(symbol, barsBySymbol.get(symbol) ?? [], sessions, now, source);
    incomplete += result.incomplete;
    if (result.unknownDates.length) {
      log.warn('bars on dates missing from the market calendar were skipped', {
        symbol,
        dates: result.unknownDates.slice(0, 5),
      });
    }
    allRows.push(...result.rows);
    const last = result.rows.at(-1);
    if (last) {
      statuses.push({
        symbol,
        dataset: 'daily_bars',
        status: 'ok',
        source,
        lastDataAt: sessions.get(last.date)!.closeAt,
        note: null,
      });
    } else {
      empty.push(symbol);
    }
  }

  // No bars this run: "no data source" if we have never stored any, otherwise "stale".
  if (empty.length) {
    const stored = await db
      .select({ symbol: pricesDaily.symbol, n: count() })
      .from(pricesDaily)
      .where(inArray(pricesDaily.symbol, empty))
      .groupBy(pricesDaily.symbol);
    const has = new Set(stored.filter((s) => s.n > 0).map((s) => s.symbol));
    for (const symbol of empty) {
      statuses.push(
        has.has(symbol)
          ? {
              symbol,
              dataset: 'daily_bars',
              status: 'stale',
              source,
              lastDataAt: null,
              note: `no bars from ${source} since ${start}`,
            }
          : {
              symbol,
              dataset: 'daily_bars',
              status: 'no_data_source',
              source: null,
              lastDataAt: null,
              note: `not checked: no data source (no daily bars from Alpaca ${feed}; OTC data is not included in the free plan)`,
            },
      );
    }
  }
  for (const o of p.universe.optionContracts) {
    statuses.push({
      symbol: o.symbol,
      dataset: 'option_prices',
      status: 'no_data_source',
      source: null,
      lastDataAt: null,
      note: NO_OPTION_PRICES_NOTE,
    });
  }

  const written = await upsertBars(db, allRows);
  await setDataStatus(db, statuses, now);
  return {
    items: written,
    meta: {
      feed,
      start,
      symbols: symbols.length,
      barsReceived: allRows.length,
      barsWritten: written,
      backfilledNewSymbols: backfilled,
      skippedIncomplete: incomplete,
      noDataSource: statuses.filter((s) => s.status === 'no_data_source').map((s) => s.symbol),
      stale: statuses.filter((s) => s.status === 'stale').map((s) => s.symbol),
    },
  };
}
