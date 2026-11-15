import type { Db } from '@aia/db';
import type { AlpacaClient } from '../alpaca/client';
import type { JobResult } from '../lib/jobs';
import { insertNews, latestPublishedAt, toNewsRow } from './store';

/** Overlap when resuming, so items published right at the boundary aren't missed. */
const RESUME_OVERLAP_MS = 10 * 60 * 1000;

/**
 * REST backfill. Resumes from the newest stored item (minus an overlap) or, on an empty table,
 * goes back `days`. Duplicates from the overlap are dropped by insertNews.
 */
export async function collectNews(
  db: Db,
  client: AlpacaClient,
  p: { symbols: readonly string[]; days: number; since?: Date; now?: Date },
): Promise<JobResult> {
  const now = p.now ?? new Date();
  const latest = p.since ?? (await latestPublishedAt(db));
  const start = latest
    ? new Date(latest.getTime() - RESUME_OVERLAP_MS)
    : new Date(now.getTime() - p.days * 86_400_000);
  const items = await client.news({ symbols: p.symbols, start: start.toISOString() });
  const result = await insertNews(
    db,
    items.map((i) => toNewsRow(i, now, 'rest')),
  );
  return {
    items: result.inserted,
    meta: { start: start.toISOString(), fetched: items.length, ...result },
  };
}
