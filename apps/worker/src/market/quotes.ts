import { quotesLatest, type Db } from '@aia/db';
import { sql } from 'drizzle-orm';
import type { AlpacaClient } from '../alpaca/client';
import type { AlpacaSnapshot } from '../alpaca/schemas';
import type { JobResult } from '../lib/jobs';
import { setDataStatus, type DataStatusRow } from './data-status';
import type { Universe } from './universe';

const SOURCE = 'alpaca:iex';

export function toQuoteRow(symbol: string, snap: AlpacaSnapshot, receivedAt: Date) {
  const q = snap.latestQuote ?? null;
  const t = snap.latestTrade ?? null;
  const ts = [q?.t, t?.t]
    .filter((x): x is string => !!x)
    .sort()
    .at(-1);
  return {
    symbol,
    bidPrice: q ? String(q.bp) : null,
    bidSize: q ? String(q.bs) : null,
    askPrice: q ? String(q.ap) : null,
    askSize: q ? String(q.as) : null,
    lastPrice: t ? String(t.p) : null,
    quoteTs: ts ? new Date(ts) : null,
    receivedAt,
    source: SOURCE,
  };
}

/** Latest IEX quote/trade per symbol. Skips (not fails) when the market is closed. */
export async function collectQuotes(
  db: Db,
  client: AlpacaClient,
  p: { universe: Universe; force?: boolean; now?: Date },
): Promise<JobResult> {
  if (!p.force) {
    const clock = await client.clock();
    if (!clock.is_open) {
      return { status: 'skipped', meta: { reason: 'market closed', nextOpen: clock.next_open } };
    }
  }
  const now = p.now ?? new Date();
  const symbols = p.universe.priceSymbols;
  const snaps = await client.snapshots(symbols, 'iex');
  const rows = [...snaps].map(([symbol, snap]) => toQuoteRow(symbol, snap, now));
  if (rows.length) {
    await db
      .insert(quotesLatest)
      .values(rows)
      .onConflictDoUpdate({
        target: quotesLatest.symbol,
        set: {
          bidPrice: sql`excluded.bid_price`,
          bidSize: sql`excluded.bid_size`,
          askPrice: sql`excluded.ask_price`,
          askSize: sql`excluded.ask_size`,
          lastPrice: sql`excluded.last_price`,
          quoteTs: sql`excluded.quote_ts`,
          receivedAt: sql`excluded.received_at`,
          source: sql`excluded.source`,
        },
      });
  }
  const missing = symbols.filter((s) => !snaps.has(s));
  const statuses: DataStatusRow[] = [
    ...rows.map((r) => ({
      symbol: r.symbol,
      dataset: 'quotes' as const,
      status: 'ok' as const,
      source: SOURCE,
      lastDataAt: r.quoteTs,
      note: null,
    })),
    ...missing.map((symbol) => ({
      symbol,
      dataset: 'quotes' as const,
      status: 'no_data_source' as const,
      source: null,
      lastDataAt: null,
      note: 'not checked: no data source (no IEX snapshot)',
    })),
  ];
  await setDataStatus(db, statuses, now);
  return { items: rows.length, meta: { symbols: symbols.length, missing } };
}
