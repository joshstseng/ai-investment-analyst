/** Storage behaviour against Postgres, inside rolled-back transactions. */
import { createDb, loadDatabaseUrl, newsItems, symbolDataStatus, type Db } from '@aia/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { setDataStatus } from './market/data-status';
import { insertNews, toNewsRow } from './news/store';

const url = (() => {
  try {
    return loadDatabaseUrl();
  } catch {
    return undefined;
  }
})();

class Rollback extends Error {}

describe.skipIf(!url)('worker storage (Postgres)', () => {
  const { db, sql: client } = createDb(url ?? '', { max: 1 });
  afterAll(() => client.end());

  async function inTx(fn: (tx: Db) => Promise<void>) {
    await expect(
      db.transaction(async (tx) => {
        // Serialize DB tests across packages (vitest runs projects in parallel).
        await tx.execute(sql`SELECT pg_advisory_xact_lock(4242)`);
        await tx.execute(sql`TRUNCATE news_items, symbol_data_status`);
        // The helpers take a Db; a transaction has the same query API.
        await fn(tx as unknown as Db);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  const item = (id: number, headline: string, symbols = ['ACMX']) => ({
    id,
    headline,
    summary: '',
    author: '',
    created_at: '2026-11-15T14:00:00Z',
    url: null,
    symbols,
    source: 'benzinga',
  });

  it('drops duplicates by source id and by content hash, keeping tickers', async () => {
    await inTx(async (tx) => {
      const now = new Date();
      const first = await insertNews(tx, [
        toNewsRow(item(1, 'Acme Medical cuts guidance'), now, 'stream'),
        toNewsRow(item(2, 'Bkx faces regulatory review', ['BKX']), now, 'stream'),
      ]);
      expect(first).toEqual({ inserted: 2, duplicates: 0 });

      const again = await insertNews(tx, [
        toNewsRow(item(1, 'Acme Medical cuts guidance'), now, 'rest'), // same id (REST gap fill)
        toNewsRow(item(99, 'Acme Medical Cuts Guidance!'), now, 'rest'), // republished, new id
        toNewsRow(item(3, 'Acme Medical cuts guidance', ['ACMX', 'MDX']), now, 'rest'), // different tickers
      ]);
      expect(again).toEqual({ inserted: 1, duplicates: 2 });

      const rows = await tx.select().from(newsItems).orderBy(newsItems.sourceId);
      expect(rows.map((r) => [r.sourceId, r.symbols, r.via])).toEqual([
        ['1', ['ACMX'], 'stream'],
        ['2', ['BKX'], 'stream'],
        ['3', ['ACMX', 'MDX'], 'rest'],
      ]);
    });
  });

  it('records no-data-source symbols and keeps the newest data timestamp', async () => {
    await inTx(async (tx) => {
      const t1 = new Date('2026-11-13T21:00:00Z');
      await setDataStatus(tx, [
        {
          symbol: 'OTCX',
          dataset: 'daily_bars',
          status: 'no_data_source',
          source: null,
          lastDataAt: null,
          note: 'not checked: no data source',
        },
        {
          symbol: 'SPY',
          dataset: 'daily_bars',
          status: 'ok',
          source: 'alpaca:sip',
          lastDataAt: t1,
          note: null,
        },
      ]);
      await setDataStatus(tx, [
        {
          symbol: 'SPY',
          dataset: 'daily_bars',
          status: 'stale',
          source: 'alpaca:sip',
          lastDataAt: null,
          note: 'no bars',
        },
      ]);
      const [spy] = await tx
        .select()
        .from(symbolDataStatus)
        .where(eq(symbolDataStatus.symbol, 'SPY'));
      expect(spy).toMatchObject({ status: 'stale', lastDataAt: t1 });
      const [fltcf] = await tx
        .select()
        .from(symbolDataStatus)
        .where(eq(symbolDataStatus.symbol, 'OTCX'));
      expect(fltcf!.status).toBe('no_data_source');
    });
  });
});
