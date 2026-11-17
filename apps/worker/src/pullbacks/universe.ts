/**
 * Pullback screen universe: the largest S&P 500 members by market cap, the Nasdaq-100, core
 * names and extras from config/pullbacks.json, plus the stocks you hold or watch.
 * Index lists are checked-in CSVs (config/universe/), refreshed by `pnpm collect universe-refresh`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { holdings, instruments, symbolDataStatus, watchlist, type Db } from '@aia/db';
import { parse } from 'csv-parse/sync';
import { and, eq, ne } from 'drizzle-orm';
import { CONFIG_DIR, type PullbackConfig } from './config';

export type UniverseSource = 'sp500' | 'nasdaq100' | 'core' | 'extra' | 'holding' | 'watchlist';

export interface ScreenMember {
  symbol: string;
  sources: UniverseSource[];
}

export interface Sp500Row {
  rank: number | null;
  symbol: string;
  name: string;
  cik: string;
  marketCapUsd: number | null;
}

export interface Nasdaq100Row {
  symbol: string;
  name: string;
}

// ---- Wikipedia constituent tables (pure) --------------------------------------------------------

/** Wiki markup in a table cell → plain text: {{NyseSymbol|MMM}} → MMM, [[A|B]] → B, refs dropped. */
export function cleanWikiCell(cell: string): string {
  return cell
    .replace(/<ref[^>]*\/>/g, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '')
    .replace(/\{\{(?:Nyse|Nasdaq|NYSE|NASDAQ|Cboe|BATS)\w*Symbol\|([^}|]+)[^}]*\}\}/gi, '$1')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rows (arrays of cleaned cells) of the table with id="constituents" in raw wikitext. */
export function parseConstituentsTable(raw: string): string[][] {
  const start = raw.indexOf('id="constituents"');
  if (start < 0) throw new Error('no table with id="constituents" found');
  const end = raw.indexOf('\n|}', start);
  const body = raw.slice(raw.indexOf('\n', start), end < 0 ? undefined : end);
  const rows: string[][] = [];
  for (const chunk of body.split(/\n\|-[^\n]*/)) {
    const text = chunk.trim();
    if (!text || text.startsWith('!')) continue; // header
    // Cells are separated by "||"; a row may span lines that each start with "|" or "||".
    const joined = text
      .split('\n')
      .map((l) => l.replace(/^\|\|?/, '||'))
      .join('');
    const cells = joined.split('||').slice(1).map(cleanWikiCell);
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** S&P 500 page: Symbol, Security, Sector, Sub-Industry, HQ, Date added, CIK, Founded. */
export function parseSp500(raw: string): Omit<Sp500Row, 'rank' | 'marketCapUsd'>[] {
  return parseConstituentsTable(raw)
    .filter((c) => c.length >= 7 && /^[A-Z.]+$/.test(c[0]!))
    .map((c) => ({ symbol: c[0]!, name: c[1]!, cik: c[6]!.replace(/\D/g, '').padStart(10, '0') }));
}

/** Nasdaq-100 list page: Ticker, Company, ISIN, Industry, Subsector. */
export function parseNasdaq100(raw: string): Nasdaq100Row[] {
  return parseConstituentsTable(raw)
    .filter((c) => c.length >= 2 && /^[A-Z.]+$/.test(c[0]!))
    .map((c) => ({ symbol: c[0]!, name: c[1]!.replace(/\s*\(Class [A-Z]\)$/, '') }));
}

// ---- Market-cap ranking (pure) ------------------------------------------------------------------

/**
 * Market cap = shares × last close; ranked 1..n, largest first. Share classes of one company
 * (same CIK) get one rank: the class listed in `preferred` (core names), else the first listed.
 */
export function rankSp500(
  members: readonly Omit<Sp500Row, 'rank' | 'marketCapUsd'>[],
  sharesByCik: ReadonlyMap<string, number>,
  closeBySymbol: ReadonlyMap<string, number>,
  preferred: readonly string[] = [],
): Sp500Row[] {
  const rows: Sp500Row[] = members.map((m) => {
    const shares = sharesByCik.get(m.cik);
    const close = closeBySymbol.get(m.symbol);
    return {
      ...m,
      rank: null,
      marketCapUsd: shares && close ? Math.round(shares * close) : null,
    };
  });
  const byCik = new Map<string, Sp500Row[]>();
  for (const r of rows) byCik.set(r.cik, [...(byCik.get(r.cik) ?? []), r]);
  const ranked = [...byCik.values()]
    .map((g) => g.find((r) => preferred.includes(r.symbol)) ?? g[0]!)
    .filter((r) => r.marketCapUsd !== null)
    .sort((a, b) => b.marketCapUsd! - a.marketCapUsd!);
  ranked.forEach((r, i) => (r.rank = i + 1));
  return rows.sort(
    (a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.symbol.localeCompare(b.symbol),
  );
}

// ---- CSV files ----------------------------------------------------------------------------------

const csvEscape = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function sp500Csv(rows: readonly Sp500Row[]): string {
  return [
    'rank,symbol,name,cik,market_cap_usd',
    ...rows.map((r) => [r.rank, r.symbol, r.name, r.cik, r.marketCapUsd].map(csvEscape).join(',')),
  ].join('\n');
}

export function nasdaq100Csv(rows: readonly Nasdaq100Row[]): string {
  return ['symbol,name', ...rows.map((r) => [r.symbol, r.name].map(csvEscape).join(','))].join(
    '\n',
  );
}

export function readSp500(dir = CONFIG_DIR): Sp500Row[] {
  const rows = parse(readFileSync(`${dir}universe/sp500.csv`, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
  }) as Record<string, string>[];
  return rows.map((r) => ({
    rank: r.rank ? Number(r.rank) : null,
    symbol: r.symbol!,
    name: r.name!,
    cik: r.cik!,
    marketCapUsd: r.market_cap_usd ? Number(r.market_cap_usd) : null,
  }));
}

export function readNasdaq100(dir = CONFIG_DIR): Nasdaq100Row[] {
  return (
    parse(readFileSync(`${dir}universe/nasdaq100.csv`, 'utf8'), {
      columns: true,
      skip_empty_lines: true,
    }) as Record<string, string>[]
  ).map((r) => ({ symbol: r.symbol!, name: r.name! }));
}

export function writeUniverseCsvs(sp500: readonly Sp500Row[], ndx: readonly Nasdaq100Row[]) {
  writeFileSync(`${CONFIG_DIR}universe/sp500.csv`, `${sp500Csv(sp500)}\n`);
  writeFileSync(`${CONFIG_DIR}universe/nasdaq100.csv`, `${nasdaq100Csv(ndx)}\n`);
}

// ---- Universe assembly --------------------------------------------------------------------------

/** Combines the lists (pure). Symbols keep every source they came from; `exclude` wins. */
export function buildScreenUniverse(
  cfg: PullbackConfig['universe'],
  lists: {
    sp500: readonly Sp500Row[];
    nasdaq100: readonly Nasdaq100Row[];
    held: readonly string[];
    watched: readonly string[];
  },
): ScreenMember[] {
  const map = new Map<string, Set<UniverseSource>>();
  const add = (symbol: string, source: UniverseSource) => {
    if (cfg.exclude.includes(symbol)) return;
    map.set(symbol, (map.get(symbol) ?? new Set()).add(source));
  };
  for (const r of lists.sp500)
    if (r.rank !== null && r.rank <= cfg.sp500Top) add(r.symbol, 'sp500');
  if (cfg.nasdaq100) for (const r of lists.nasdaq100) add(r.symbol, 'nasdaq100');
  for (const s of cfg.core) add(s, 'core');
  for (const s of cfg.extra) add(s, 'extra');
  for (const s of lists.held) add(s, 'holding');
  for (const s of lists.watched) add(s, 'watchlist');
  return [...map]
    .map(([symbol, s]) => ({ symbol, sources: [...s] }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/**
 * The screen universe from config, the CSVs and the database. Holdings and watchlist add their
 * stocks (an option adds its underlying); ETFs and names with no data source are left out.
 */
export async function loadScreenUniverse(db: Db, cfg: PullbackConfig): Promise<ScreenMember[]> {
  const [held, watched, noData] = await Promise.all([
    db
      .selectDistinct({
        symbol: instruments.symbol,
        type: instruments.instrumentType,
        underlying: instruments.underlyingSymbol,
      })
      .from(holdings)
      .innerJoin(instruments, eq(holdings.instrumentId, instruments.id))
      .where(ne(holdings.status, 'closed')),
    db
      .select({
        symbol: instruments.symbol,
        type: instruments.instrumentType,
        underlying: instruments.underlyingSymbol,
      })
      .from(watchlist)
      .innerJoin(instruments, eq(watchlist.instrumentId, instruments.id)),
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
  const skip = new Set(noData.map((r) => r.symbol));
  const stocks = (rows: { symbol: string; type: string; underlying: string | null }[]) =>
    rows
      .map((r) => (r.type === 'option' ? r.underlying : r.type === 'stock' ? r.symbol : null))
      .filter((s): s is string => !!s && !skip.has(s));
  return buildScreenUniverse(cfg.universe, {
    sp500: readSp500(),
    nasdaq100: readNasdaq100(),
    held: stocks(held),
    watched: stocks(watched),
  });
}
