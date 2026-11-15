import { symbolDataStatus, type Db } from '@aia/db';
import { sql } from 'drizzle-orm';

export type Dataset = 'daily_bars' | 'quotes' | 'option_prices' | 'news' | 'filings';

export interface DataStatusRow {
  symbol: string;
  dataset: Dataset;
  status: 'ok' | 'no_data_source' | 'not_applicable' | 'stale' | 'error';
  source: string | null;
  lastDataAt: Date | null;
  note: string | null;
}

/** Upserts coverage rows. A symbol with no data is recorded, never treated as a failure. */
export async function setDataStatus(db: Db, rows: DataStatusRow[], now = new Date()) {
  if (rows.length === 0) return;
  await db
    .insert(symbolDataStatus)
    .values(rows.map((r) => ({ ...r, checkedAt: now })))
    .onConflictDoUpdate({
      target: [symbolDataStatus.symbol, symbolDataStatus.dataset],
      set: {
        status: sql`excluded.status`,
        source: sql`excluded.source`,
        // Keep the newest timestamp we have ever seen if this run returned nothing new.
        lastDataAt: sql`COALESCE(excluded.last_data_at, ${symbolDataStatus.lastDataAt})`,
        note: sql`excluded.note`,
        checkedAt: sql`excluded.checked_at`,
      },
    });
}

export const NO_OPTION_PRICES_NOTE =
  'not checked: no data source (option prices are not collected in Step 1; rules on the underlying still run)';
