import { filings, type Db } from '@aia/db';
import type { JobResult } from '../lib/jobs';
import { log } from '../lib/log';
import { setDataStatus, type DataStatusRow } from '../market/data-status';
import type { SecClient, Submissions } from './client';
import { loadCompanyCiks } from './ciks';

/** Forms we store: 8-K, 10-Q, 10-K, S-1 (and their amendments), and 424B1–424B8 prospectuses. */
export function isTrackedForm(form: string): boolean {
  return /^(8-K|10-Q|10-K|S-1)(\/A)?$/.test(form) || /^424B[1-8]$/.test(form);
}

export type FilingRow = typeof filings.$inferInsert;

/** Extracts tracked filings accepted at or after `since` from a submissions document (pure). */
export function toFilingRows(
  sub: Submissions,
  p: { cik: string; ticker: string; since: Date; receivedAt: Date; via: 'backfill' | 'poll' },
): FilingRow[] {
  const r = sub.filings.recent;
  const rows: FilingRow[] = [];
  const cikNum = String(Number(p.cik));
  for (let i = 0; i < r.accessionNumber.length; i++) {
    const form = r.form[i]!;
    if (!isTrackedForm(form)) continue;
    const filedAt = new Date(r.acceptanceDateTime[i]!);
    if (Number.isNaN(filedAt.getTime()) || filedAt < p.since) continue;
    const accession = r.accessionNumber[i]!;
    const folder = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accession.replace(/-/g, '')}`;
    const doc = r.primaryDocument[i];
    rows.push({
      accession,
      cik: p.cik,
      ticker: p.ticker,
      form,
      filingDate: r.filingDate[i] || null,
      items: form.startsWith('8-K')
        ? (r.items[i] ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      filedAt,
      url: doc ? `${folder}/${doc}` : `${folder}/${accession}-index.htm`,
      receivedAt: p.receivedAt,
      via: p.via,
    });
  }
  return rows;
}

/**
 * Polls submissions for each company CIK and stores new tracked filings (duplicates by
 * accession are dropped). `days` bounds how far back to look; `via` marks backfill vs poll.
 */
export async function collectFilings(
  db: Db,
  sec: SecClient,
  p: { symbols: readonly string[]; days: number; via: 'backfill' | 'poll'; now?: Date },
): Promise<JobResult> {
  const now = p.now ?? new Date();
  const since = new Date(now.getTime() - p.days * 86_400_000);
  const ciks = await loadCompanyCiks(db, p.symbols);
  if (ciks.length === 0)
    throw new Error('sec_ciks is empty for our symbols; run the CIK sync first');

  // Several tickers can share a CIK (e.g. share classes): fetch once, attach the first ticker.
  const byCik = new Map<string, string[]>();
  for (const c of ciks) byCik.set(c.cik, [...(byCik.get(c.cik) ?? []), c.ticker].sort());

  let fetched = 0;
  let inserted = 0;
  const failed: string[] = [];
  const statuses: DataStatusRow[] = [];
  const newFilings: string[] = [];
  for (const [cik, tickers] of byCik) {
    try {
      const sub = await sec.submissions(cik);
      const rows = toFilingRows(sub, {
        cik,
        ticker: tickers[0]!,
        since,
        receivedAt: now,
        via: p.via,
      });
      fetched += rows.length;
      if (rows.length) {
        const res = await db
          .insert(filings)
          .values(rows)
          .onConflictDoNothing({ target: filings.accession })
          .returning({ accession: filings.accession, form: filings.form, ticker: filings.ticker });
        inserted += res.length;
        newFilings.push(...res.map((f) => `${f.ticker} ${f.form} ${f.accession}`));
      }
      const latest = new Date(sub.filings.recent.acceptanceDateTime[0] ?? NaN);
      for (const ticker of tickers) {
        statuses.push({
          symbol: ticker,
          dataset: 'filings',
          status: 'ok',
          source: 'sec:edgar',
          lastDataAt: Number.isNaN(latest.getTime()) ? null : latest,
          note: null,
        });
      }
    } catch (error) {
      // One company failing must not stop the rest; record it and move on.
      failed.push(tickers.join(','));
      log.warn('edgar submissions failed', { cik, tickers, error: String(error) });
      for (const ticker of tickers) {
        statuses.push({
          symbol: ticker,
          dataset: 'filings',
          status: 'error',
          source: 'sec:edgar',
          lastDataAt: null,
          note: String(error).slice(0, 300),
        });
      }
    }
  }
  await setDataStatus(db, statuses, now);
  if (failed.length === byCik.size) throw new Error(`EDGAR: all ${failed.length} companies failed`);
  return {
    items: inserted,
    meta: {
      companies: byCik.size,
      since: since.toISOString(),
      fetched,
      inserted,
      duplicates: fetched - inserted,
      failed,
      newFilings: newFilings.slice(0, 50),
    },
  };
}
