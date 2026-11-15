/**
 * Parser for holdings.md (exported from the claude.ai project).
 *
 * Expected shape:
 *   **Source:** ... as of Nov 12, 2026 ~4:33 PM ET ...
 *   ## Roth IRA (...)            → account section
 *   Total $10,000.00. Cash $1,000.00, before the pending order.
 *   | Ticker | Shares | Avg cost | ... | Notes |
 *   | ETFX | 4 + 6 = 10 | $49.90 / $50.20 | ... |   → two lots
 *   ## Concentration notes       → any other "## " heading ends the account section
 */
import {
  decimalEquals,
  parseDecimal,
  parseOptionDescriptor,
  sumDecimals,
  zonedTimeToUtc,
  type OptionSpec,
} from '@aia/core';
import { SeedParseError, TICKER_RE } from './errors';

export type AccountType = 'roth_ira' | 'individual_taxable';

export interface ParsedLot {
  quantity: string;
  avgCost: string;
  /** Text in parentheses after the cost, e.g. "limit order placed; confirm fill". */
  costNote: string | null;
}

export interface ParsedHoldingRow {
  line: number;
  /** Ticker cell as written, e.g. "ACMX" or "OPTY Mar-19-2027 $6 call". */
  ticker: string;
  option: OptionSpec | null;
  lots: ParsedLot[];
  notes: string | null;
}

export interface ParsedAccount {
  accountType: AccountType;
  heading: string;
  totalValue: string | null;
  cashBalance: string | null;
  balancesNote: string | null;
  rows: ParsedHoldingRow[];
}

export interface ParsedHoldingsMd {
  asOf: Date | null;
  accounts: ParsedAccount[];
}

const FILE = 'holdings.md';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;

const ACCOUNT_HEADINGS: [RegExp, AccountType][] = [
  [/^##\s+Roth IRA\b/i, 'roth_ira'],
  [/^##\s+Individual\b/i, 'individual_taxable'],
];

export function parseHoldingsMd(text: string): ParsedHoldingsMd {
  const lines = text.split(/\r?\n/);
  const accounts: ParsedAccount[] = [];
  let asOf: Date | null = null;
  let current: ParsedAccount | null = null;
  let header: string[] | null = null;

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();

    if (asOf === null && /as of/i.test(line)) asOf = parseAsOf(line);

    if (line.startsWith('## ')) {
      header = null;
      const match = ACCOUNT_HEADINGS.find(([re]) => re.test(line));
      if (!match) {
        current = null;
        return;
      }
      const accountType = match[1];
      if (accounts.some((a) => a.accountType === accountType)) {
        throw new SeedParseError(FILE, lineNo, `duplicate section for ${accountType}`);
      }
      current = {
        accountType,
        heading: line.slice(3),
        totalValue: null,
        cashBalance: null,
        balancesNote: null,
        rows: [],
      };
      accounts.push(current);
      return;
    }
    if (!current) return;
    const account: ParsedAccount = current;

    const totals = new RegExp(
      String.raw`^Total \$(${NUM})\.?\s*Cash \$(${NUM})[.,]?\s*(.*)$`,
      'i',
    ).exec(line);
    if (totals) {
      account.totalValue = parseDecimal(totals[1]!);
      account.cashBalance = parseDecimal(totals[2]!);
      account.balancesNote = totals[3]!.replace(/\.$/, '').trim() || null;
      return;
    }

    if (!line.startsWith('|')) return;
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-+:?$/.test(c))) return; // separator row
    if (!header) {
      header = cells.map((c) => c.toLowerCase());
      for (const required of ['ticker', 'shares', 'avg cost']) {
        if (!header.includes(required)) {
          throw new SeedParseError(FILE, lineNo, `table header is missing "${required}"`);
        }
      }
      return;
    }
    const cell = (name: string) => cells[header!.indexOf(name)]?.trim() ?? '';
    const row = parseRow(lineNo, cell('ticker'), cell('shares'), cell('avg cost'), cell('notes'));
    if (account.rows.some((r) => r.ticker === row.ticker)) {
      throw new SeedParseError(
        FILE,
        lineNo,
        `duplicate row for ${row.ticker} in ${account.heading}`,
      );
    }
    account.rows.push(row);
  });

  if (accounts.length === 0) throw new SeedParseError(FILE, null, 'no account sections found');
  return { asOf, accounts };
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** "as of Nov 12, 2026 ~4:33 PM ET" → UTC instant. Date without time → null (never guessed). */
function parseAsOf(line: string): Date | null {
  const m =
    /as of ([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4})\s*~?(\d{1,2}):(\d{2})\s*(AM|PM)\s*ET/i.exec(line);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.toLowerCase()) + 1;
  if (month === 0) return null;
  let hour = Number(m[4]) % 12;
  if (m[6]!.toUpperCase() === 'PM') hour += 12;
  return zonedTimeToUtc(
    { year: Number(m[3]), month, day: Number(m[2]), hour, minute: Number(m[5]) },
    'America/New_York',
  );
}

function parseRow(
  lineNo: number,
  ticker: string,
  shares: string,
  avgCost: string,
  notes: string,
): ParsedHoldingRow {
  const option = parseOptionDescriptor(ticker);
  if (!option && !TICKER_RE.test(ticker)) {
    throw new SeedParseError(FILE, lineNo, `unrecognised ticker "${ticker}"`);
  }

  const quantities = parseShares(lineNo, shares, option !== null);
  const costs = avgCost.split(/\s+\/\s+/).map((c) => parseCost(lineNo, c));
  if (costs.length !== quantities.length) {
    throw new SeedParseError(
      FILE,
      lineNo,
      `${quantities.length} lot(s) in "${shares}" but ${costs.length} cost(s) in "${avgCost}"`,
    );
  }
  return {
    line: lineNo,
    ticker,
    option,
    lots: quantities.map((quantity, i) => ({ quantity, ...costs[i]! })),
    notes: notes === '' ? null : notes,
  };
}

/** "40" | "12.345" | "1 contract" | "4 + 6 = 10" → one quantity per lot. */
function parseShares(lineNo: number, cell: string, isOption: boolean): string[] {
  const unit = isOption ? String.raw`\s*contracts?` : String.raw`(?:\s*(?:sh|shares))?`;
  const single = new RegExp(String.raw`^(${NUM})${unit}$`, 'i').exec(cell);
  if (single) return [parseDecimal(single[1]!)!];

  const multi = new RegExp(String.raw`^(${NUM}(?:\s*\+\s*${NUM})+)\s*=\s*(${NUM})$`).exec(cell);
  if (multi && !isOption) {
    const lots = multi[1]!.split('+').map((p) => parseDecimal(p)!);
    const total = parseDecimal(multi[2]!)!;
    if (!decimalEquals(sumDecimals(lots), total)) {
      throw new SeedParseError(FILE, lineNo, `lots in "${cell}" do not add up to ${total}`);
    }
    return lots;
  }
  throw new SeedParseError(FILE, lineNo, `unrecognised share count "${cell}"`);
}

/** "$61.03" | "$61.03 (limit order placed; confirm fill)". */
function parseCost(lineNo: number, cell: string): { avgCost: string; costNote: string | null } {
  const m = new RegExp(String.raw`^\$(${NUM})\s*(?:\((.+)\))?$`).exec(cell.trim());
  if (!m) throw new SeedParseError(FILE, lineNo, `unrecognised avg cost "${cell}"`);
  return { avgCost: parseDecimal(m[1]!)!, costNote: m[2]?.trim() ?? null };
}
