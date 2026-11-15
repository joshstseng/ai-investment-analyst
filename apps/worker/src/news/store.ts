import { createHash } from 'node:crypto';
import { newsItems, type Db } from '@aia/db';
import { desc } from 'drizzle-orm';
import type { AlpacaNewsItem } from '../alpaca/schemas';

/**
 * Content hash for duplicate detection across providers and ids: normalized headline plus the
 * sorted symbol set. (Symbols are included so generic headlines like "Earnings Scheduled For
 * ..." about different companies don't collide.)
 */
export function newsHash(headline: string, symbols: readonly string[]): string {
  const normalized = headline
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const syms = [...new Set(symbols.map((s) => s.toUpperCase()))].sort().join(',');
  return createHash('sha256').update(`${normalized}|${syms}`).digest('hex');
}

export type NewsRow = typeof newsItems.$inferInsert;

export function toNewsRow(item: AlpacaNewsItem, receivedAt: Date, via: 'rest' | 'stream'): NewsRow {
  const symbols = [...new Set(item.symbols.map((s) => s.toUpperCase()))].sort();
  return {
    source: `alpaca:${item.source.toLowerCase()}`,
    sourceId: String(item.id),
    headline: item.headline.trim(),
    summary: item.summary?.trim() || null,
    url: item.url || null,
    symbols,
    publishedAt: new Date(item.created_at),
    receivedAt,
    via,
    hash: newsHash(item.headline, symbols),
  };
}

/** Inserts news, silently dropping duplicates (same source id or same content hash). */
export async function insertNews(db: Db, rows: NewsRow[]) {
  if (rows.length === 0) return { inserted: 0, duplicates: 0 };
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const res = await db
      .insert(newsItems)
      .values(rows.slice(i, i + 500))
      .onConflictDoNothing()
      .returning({ id: newsItems.id });
    inserted += res.length;
  }
  return { inserted, duplicates: rows.length - inserted };
}

export async function latestPublishedAt(db: Db): Promise<Date | null> {
  const [row] = await db
    .select({ at: newsItems.publishedAt })
    .from(newsItems)
    .orderBy(desc(newsItems.publishedAt))
    .limit(1);
  return row?.at ?? null;
}
