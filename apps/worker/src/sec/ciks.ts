import { secCiks, type Db } from '@aia/db';
import { inArray, sql } from 'drizzle-orm';
import type { JobResult } from '../lib/jobs';
import { setDataStatus, type DataStatusRow } from '../market/data-status';
import type { fundTickersSchema, companyTickersSchema, SecClient } from './client';
import { padCik } from './client';
import type { z } from 'zod';

export interface CikEntry {
  ticker: string;
  cik: string;
  title: string | null;
  kind: 'company' | 'fund';
}

/** Resolves our tickers against the SEC company and fund ticker files (pure). */
export function resolveCiks(
  symbols: readonly string[],
  companies: z.infer<typeof companyTickersSchema>,
  funds: z.infer<typeof fundTickersSchema>,
) {
  const companyBy = new Map(Object.values(companies).map((c) => [c.ticker.toUpperCase(), c]));
  const symIdx = funds.fields.indexOf('symbol');
  const cikIdx = funds.fields.indexOf('cik');
  if (symIdx < 0 || cikIdx < 0) throw new Error('company_tickers_mf.json: unexpected fields');
  const fundBy = new Map(funds.data.map((row) => [String(row[symIdx]).toUpperCase(), row]));

  const found: CikEntry[] = [];
  const statuses: DataStatusRow[] = [];
  for (const symbol of symbols) {
    const c = companyBy.get(symbol);
    const f = fundBy.get(symbol);
    if (c) {
      found.push({ ticker: symbol, cik: padCik(c.cik_str), title: c.title, kind: 'company' });
    } else if (f) {
      found.push({ ticker: symbol, cik: padCik(String(f[cikIdx])), title: null, kind: 'fund' });
      statuses.push({
        symbol,
        dataset: 'filings',
        status: 'not_applicable',
        source: 'sec:edgar',
        lastDataAt: null,
        note: 'fund/ETF: does not file 8-K/10-Q/10-K/S-1/424B',
      });
    } else {
      statuses.push({
        symbol,
        dataset: 'filings',
        status: 'no_data_source',
        source: null,
        lastDataAt: null,
        note: 'not checked: no data source (not an SEC registrant; no CIK in company_tickers.json)',
      });
    }
  }
  return { found, statuses };
}

/** Refreshes the ticker→CIK map for our symbols (the SEC files change rarely; daily is plenty). */
export async function syncCiks(
  db: Db,
  sec: SecClient,
  symbols: readonly string[],
): Promise<JobResult> {
  const [companies, funds] = await Promise.all([sec.companyTickers(), sec.fundTickers()]);
  const { found, statuses } = resolveCiks(symbols, companies, funds);
  if (found.length) {
    await db
      .insert(secCiks)
      .values(found)
      .onConflictDoUpdate({
        target: secCiks.ticker,
        set: { cik: sql`excluded.cik`, title: sql`excluded.title`, kind: sql`excluded.kind` },
        setWhere: sql`(${secCiks.cik}, ${secCiks.title}, ${secCiks.kind}) IS DISTINCT FROM (excluded.cik, excluded.title, excluded.kind)`,
      });
  }
  await setDataStatus(db, statuses);
  return {
    items: found.length,
    meta: {
      companies: found.filter((f) => f.kind === 'company').length,
      funds: found.filter((f) => f.kind === 'fund').map((f) => f.ticker),
      noCik: statuses.filter((s) => s.status === 'no_data_source').map((s) => s.symbol),
    },
  };
}

export async function loadCompanyCiks(db: Db, symbols: readonly string[]) {
  if (symbols.length === 0) return [];
  const rows = await db
    .select()
    .from(secCiks)
    .where(inArray(secCiks.ticker, [...symbols]));
  return rows.filter((r) => r.kind === 'company');
}
