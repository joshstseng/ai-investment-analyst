import { isIsoDate } from '@aia/core';
import { isNeedsInput, SeedParseError, TICKER_RE } from './errors';
import { readCsv } from './positions-csv';

const FILE = 'watchlist.csv';

export const WATCHLIST_COLUMNS = [
  'ticker',
  'company_or_fund',
  'date_added',
  'status',
  'thesis_summary',
  'primary_catalyst',
  'valuation_question',
  'key_risk',
  'review_by',
  'latest_source_url',
  'last_updated',
] as const;

export interface ParsedWatchlistRow {
  line: number;
  ticker: string;
  name: string | null;
  dateAdded: string | null;
  status: string | null;
  thesisSummary: string | null;
  primaryCatalyst: string | null;
  valuationQuestion: string | null;
  keyRisk: string | null;
  reviewBy: string | null;
  latestSourceUrl: string | null;
  lastUpdated: string | null;
  needsInput: string[];
}

export function parseWatchlistCsv(text: string): ParsedWatchlistRow[] {
  const seen = new Set<string>();
  return readCsv(FILE, text, WATCHLIST_COLUMNS).map(({ line, get }) => {
    const needsInput: string[] = [];
    const value = (col: string) => {
      const v = get(col);
      if (isNeedsInput(v)) needsInput.push(col);
      return v === '' || isNeedsInput(v) ? null : v;
    };
    const date = (col: string) => {
      const v = value(col);
      if (v !== null && !isIsoDate(v)) throw new SeedParseError(FILE, line, `bad ${col} "${v}"`);
      return v;
    };

    const ticker = get('ticker');
    if (!TICKER_RE.test(ticker)) throw new SeedParseError(FILE, line, `bad ticker "${ticker}"`);
    if (seen.has(ticker)) throw new SeedParseError(FILE, line, `duplicate ticker ${ticker}`);
    seen.add(ticker);

    return {
      line,
      ticker,
      name: value('company_or_fund'),
      dateAdded: date('date_added'),
      status: value('status'),
      thesisSummary: value('thesis_summary'),
      primaryCatalyst: value('primary_catalyst'),
      valuationQuestion: value('valuation_question'),
      keyRisk: value('key_risk'),
      reviewBy: date('review_by'),
      latestSourceUrl: value('latest_source_url'),
      lastUpdated: date('last_updated'),
      needsInput,
    };
  });
}
