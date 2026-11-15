/**
 * Parser for positions.csv: per-ticker thesis fields plus four free-text rule columns.
 * Rule text is kept verbatim; turning it into typed rules is done explicitly in
 * seed-overrides.json, never by guessing from prose.
 */
import {
  isIsoDate,
  parseDecimal,
  parseOptionDescriptor,
  type OptionSpec,
  type RulePurpose,
  type RuleStatus,
} from '@aia/core';
import { parse } from 'csv-parse/sync';
import { isNeedsInput, SeedParseError, TICKER_RE } from './errors';

const FILE = 'positions.csv';

export const POSITIONS_COLUMNS = [
  'ticker',
  'name',
  'type',
  'entry_price',
  'entry_date',
  'why_i_own_it',
  'thesis_break_triggers',
  'catalyst_take_profit',
  'valuation_trim_point',
  'risk_stop',
  'thesis_status',
  'last_checked',
  'notes',
] as const;

/** CSV rule column → rule purpose. */
export const RULE_COLUMNS = [
  ['risk_stop', 'risk_stop'],
  ['catalyst_take_profit', 'take_profit'],
  ['valuation_trim_point', 'valuation_trim'],
  ['thesis_break_triggers', 'thesis_break'],
] as const satisfies readonly (readonly [(typeof POSITIONS_COLUMNS)[number], RulePurpose])[];

export type ThesisStatus = 'unknown' | 'intact' | 'weakening' | 'breaking' | 'broken';
export type PositionType = 'stock' | 'etf' | 'otc_stock' | 'option';

export type RuleCell =
  | {
      kind: 'rule';
      purpose: RulePurpose;
      status: RuleStatus;
      confirmedAt: string | null;
      text: string;
    }
  | { kind: 'skip'; purpose: RulePurpose; reason: string; text: string }
  /** e.g. "BROKEN 2026-11-12: ..." — a statement that the thesis already broke, not a rule. */
  | { kind: 'thesis_broken'; purpose: RulePurpose; text: string };

export interface ParsedPositionRow {
  line: number;
  ticker: string;
  option: OptionSpec | null;
  name: string | null;
  listingNote: string | null;
  type: PositionType;
  entryPrice: string | null;
  /** From "1.95 (per share; $194.67 total)". */
  entryCostTotal: string | null;
  entryDate: string | null;
  whyIOwnIt: string | null;
  ruleCells: RuleCell[];
  thesisStatus: ThesisStatus;
  thesisStatusNote: string | null;
  lastChecked: string | null;
  notes: string | null;
  /** From "cost $151.12" in notes. */
  notesCostTotal: string | null;
  /** Thesis columns whose value is "NEEDS USER INPUT" or empty. */
  needsInput: string[];
}

export function readCsv(file: string, text: string, columns: readonly string[]) {
  const records = parse(text, { columns: true, skip_empty_lines: true, trim: true }) as Record<
    string,
    string
  >[];
  const header = Object.keys(records[0] ?? {});
  const missing = columns.filter((c) => !header.includes(c));
  if (records.length > 0 && missing.length > 0) {
    throw new SeedParseError(file, 1, `missing column(s): ${missing.join(', ')}`);
  }
  // Header is line 1; data rows have no embedded newlines in practice, so line = index + 2.
  return records.map((r, i) => ({ line: i + 2, get: (c: string) => (r[c] ?? '').trim() }));
}

export function parsePositionsCsv(text: string): ParsedPositionRow[] {
  const rows = readCsv(FILE, text, POSITIONS_COLUMNS).map(({ line, get }) => parseRow(line, get));
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.ticker)) throw new SeedParseError(FILE, r.line, `duplicate ticker ${r.ticker}`);
    seen.add(r.ticker);
  }
  return rows;
}

function parseRow(line: number, get: (c: string) => string): ParsedPositionRow {
  const fail = (msg: string): never => {
    throw new SeedParseError(FILE, line, msg);
  };
  const needsInput: string[] = [];
  const optional = (col: string, value: string): string | null => {
    if (value === '' || isNeedsInput(value)) {
      needsInput.push(col);
      return null;
    }
    return value;
  };

  const ticker = get('ticker');
  const option = parseOptionDescriptor(ticker);
  if (!option && !TICKER_RE.test(ticker)) fail(`unrecognised ticker "${ticker}"`);

  // "Otcx Holdings plc (OTC; LSE:OTX)" → name + listing note.
  const rawName = get('name');
  const listing = /^(.*?)\s*\(([^)]*\bOTC\b[^)]*)\)$/.exec(rawName);
  const name = (listing ? listing[1]! : rawName) || null;
  const listingNote = listing ? listing[2]! : null;

  const rawType = get('type').toLowerCase();
  let type: PositionType;
  if (rawType === 'stock') type = listingNote ? 'otc_stock' : 'stock';
  else if (rawType === 'etf') type = 'etf';
  else if (rawType === 'option') type = 'option';
  else return fail(`unknown type "${get('type')}"`);
  if ((type === 'option') !== (option !== null)) {
    fail(`type "${get('type')}" does not match ticker "${ticker}"`);
  }

  let entryPrice: string | null = null;
  let entryCostTotal: string | null = null;
  const rawEntry = optional('entry_price', get('entry_price'));
  if (rawEntry !== null) {
    const m = /^(\d[\d,]*(?:\.\d+)?)(?:\s*\(per share;\s*\$(\d[\d,]*(?:\.\d+)?) total\))?$/.exec(
      rawEntry,
    );
    if (!m) fail(`unrecognised entry_price "${rawEntry}"`);
    entryPrice = parseDecimal(m![1]!);
    entryCostTotal = m![2] ? parseDecimal(m![2]) : null;
  }

  const entryDate = optional('entry_date', get('entry_date'));
  if (entryDate !== null && !isIsoDate(entryDate)) fail(`bad entry_date "${entryDate}"`);

  const statusMatch = /^(unknown|intact|weakening|breaking|broken)\b\s*(?:\((.*)\))?$/i.exec(
    get('thesis_status'),
  );
  if (!statusMatch) fail(`unknown thesis_status "${get('thesis_status')}"`);

  const lastChecked = get('last_checked') || null;
  if (lastChecked !== null && !isIsoDate(lastChecked)) fail(`bad last_checked "${lastChecked}"`);

  const notes = get('notes') || null;
  const notesCost = notes ? /\bcost \$(\d[\d,]*\.\d{2})\b/i.exec(notes) : null;

  return {
    line,
    ticker,
    option,
    name,
    listingNote,
    type,
    entryPrice,
    entryCostTotal,
    entryDate,
    whyIOwnIt: optional('why_i_own_it', get('why_i_own_it')),
    ruleCells: RULE_COLUMNS.map(([col, purpose]) => classifyRuleCell(line, purpose, get(col))),
    thesisStatus: statusMatch![1]!.toLowerCase() as ThesisStatus,
    thesisStatusNote: statusMatch![2]?.trim() || null,
    lastChecked,
    notes,
    notesCostTotal: notesCost ? parseDecimal(notesCost[1]!) : null,
    needsInput,
  };
}

/** Classifies a rule cell by its leading status word. Unknown prefixes are an error. */
export function classifyRuleCell(line: number, purpose: RulePurpose, text: string): RuleCell {
  if (text === '') return { kind: 'skip', purpose, reason: 'empty', text };
  if (/^DRAFT PENDING\b/.test(text)) {
    return { kind: 'rule', purpose, status: 'PLACEHOLDER', confirmedAt: null, text };
  }
  if (/^CONFIRMED\b/.test(text)) {
    const by = /^CONFIRMED by user (\d{4}-\d{2}-\d{2})/.exec(text);
    return { kind: 'rule', purpose, status: 'CONFIRMED', confirmedAt: by?.[1] ?? null, text };
  }
  if (/^DRAFT\b/.test(text))
    return { kind: 'rule', purpose, status: 'DRAFT', confirmedAt: null, text };
  if (/^n\/a\b/i.test(text)) return { kind: 'skip', purpose, reason: 'n/a', text };
  if (/^See \w+/.test(text)) return { kind: 'skip', purpose, reason: 'cross-reference', text };
  if (/^BROKEN\b/.test(text)) return { kind: 'thesis_broken', purpose, text };
  throw new SeedParseError(FILE, line, `${purpose}: unrecognised rule text "${text.slice(0, 60)}"`);
}
