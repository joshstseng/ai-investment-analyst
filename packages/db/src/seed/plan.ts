/**
 * Pure step: combines the parsed seed files and overrides into a SeedPlan (rows to upsert).
 * No database access, so every decision here is unit-testable.
 */
import {
  DEFAULT_ETF_DRAWDOWN_TIERS,
  DEFAULT_STOCK_DAY_MOVE_PCT,
  fromMicros,
  optionLabel,
  parseOptionDescriptor,
  parseRuleParams,
  toMicros,
  type OptionSpec,
  type RulePurpose,
  type RuleStatus,
  type RuleType,
  occSymbol,
} from '@aia/core';
import type { AccountType, ParsedHoldingsMd } from './holdings-md';
import type { ParsedPositionRow, PositionType, ThesisStatus } from './positions-csv';
import type { SeedOverrides } from './overrides';
import type { EventInput } from '../events';
import { seedEventInputs, type ParsedEventRow } from './events-csv';
import type { ParsedWatchlistRow } from './watchlist-csv';

export const ACCOUNT_NAMES: Record<AccountType, string> = {
  roth_ira: 'Roth IRA',
  individual_taxable: 'Individual (taxable)',
};

export interface AccountPlan {
  accountType: AccountType;
  name: string;
  taxAdvantaged: boolean;
  cashBalance: string | null;
  totalValue: string | null;
  balancesAsOf: Date | null;
  notes: string | null;
}

export interface InstrumentPlan {
  symbol: string;
  instrumentType: PositionType;
  name: string | null;
  underlyingSymbol: string | null;
  optionRight: 'call' | 'put' | null;
  strike: string | null;
  expiry: string | null;
  multiplier: number;
  listingNote: string | null;
}

export interface HoldingPlan {
  accountType: AccountType;
  symbol: string;
  lotNo: number;
  quantity: string;
  avgCost: string;
  costBasisTotal: string | null;
  status: 'open';
  needsConfirmation: boolean;
  confirmationNote: string | null;
  asOf: Date | null;
  source: string;
  notes: string | null;
  needsInput: string[];
}

export interface ThesisPlan {
  symbol: string;
  whyIOwnIt: string | null;
  entryPrice: string | null;
  entryDate: string | null;
  thesisStatus: ThesisStatus;
  thesisStatusNote: string | null;
  lastChecked: string | null;
  notes: string | null;
  needsInput: string[];
}

export interface RulePlan {
  externalKey: string;
  symbol: string;
  purpose: RulePurpose;
  ruleType: RuleType | null;
  params: Record<string, unknown>;
  status: RuleStatus;
  thesisBreakTriggers: string | null;
  alertNote: string | null;
  sourceText: string | null;
  confirmedAt: string | null;
  notes: string | null;
  needsInput: string[];
}

export interface WatchlistPlan extends Omit<ParsedWatchlistRow, 'line' | 'ticker' | 'name'> {
  symbol: string;
}

export interface SeedPlan {
  accounts: AccountPlan[];
  instruments: InstrumentPlan[];
  holdings: HoldingPlan[];
  theses: ThesisPlan[];
  rules: RulePlan[];
  watchlist: WatchlistPlan[];
  /** One-time seed events (events.csv). */
  events: EventInput[];
  warnings: string[];
}

export interface SeedInput {
  holdingsMd: ParsedHoldingsMd;
  positions: ParsedPositionRow[];
  watchlist: ParsedWatchlistRow[];
  overrides: SeedOverrides;
  /** events.csv rows (optional file). */
  events?: ParsedEventRow[];
}

export class SeedPlanError extends Error {
  override name = 'SeedPlanError';
}

/** Symbol for a ticker reference: OCC symbol for options, the ticker otherwise. */
export function resolveSymbol(ref: string): { symbol: string; option: OptionSpec | null } {
  const option = parseOptionDescriptor(ref);
  return { symbol: option ? occSymbol(option) : ref.trim().toUpperCase(), option };
}

export function buildSeedPlan(input: SeedInput): SeedPlan {
  const { holdingsMd, positions, watchlist, overrides } = input;
  const warnings: string[] = [];
  const instruments = new Map<string, InstrumentPlan>();

  // positions.csv rows by the symbol they apply to (aliases redirect, e.g. OPTX → the call).
  const positionBySymbol = new Map<string, ParsedPositionRow>();
  const aliased = new Set<string>();
  for (const row of positions) {
    const alias = overrides.aliases[row.ticker];
    const { symbol } = resolveSymbol(alias ?? row.ticker);
    if (alias) aliased.add(symbol);
    if (positionBySymbol.has(symbol)) {
      throw new SeedPlanError(`positions.csv: two rows map to ${symbol} (check aliases)`);
    }
    positionBySymbol.set(symbol, row);
  }

  // --- Accounts and holdings (holdings.md is authoritative for quantities and costs) ---------
  const accounts: AccountPlan[] = holdingsMd.accounts.map((a) => ({
    accountType: a.accountType,
    name: ACCOUNT_NAMES[a.accountType],
    taxAdvantaged: a.accountType === 'roth_ira',
    cashBalance: a.cashBalance,
    totalValue: a.totalValue,
    balancesAsOf: holdingsMd.asOf,
    notes: a.balancesNote,
  }));
  if (!holdingsMd.asOf)
    warnings.push('holdings.md: no "as of" date and time found; as_of left empty');

  const holdings: HoldingPlan[] = [];
  for (const account of holdingsMd.accounts) {
    for (const row of account.rows) {
      const { symbol, option } = resolveSymbol(row.ticker);
      if (!instruments.has(symbol)) {
        instruments.set(symbol, instrumentFor(symbol, row.ticker, option, row.notes));
      }
      row.lots.forEach((lot, i) => {
        holdings.push({
          accountType: account.accountType,
          symbol,
          lotNo: i + 1,
          quantity: lot.quantity,
          avgCost: lot.avgCost,
          costBasisTotal: null,
          status: 'open',
          needsConfirmation: false,
          confirmationNote: null,
          asOf: holdingsMd.asOf,
          source: 'holdings.md',
          notes: [lot.costNote, row.notes].filter(Boolean).join('; ') || null,
          needsInput: [],
        });
      });
    }
  }

  function instrumentFor(
    symbol: string,
    ref: string,
    option: OptionSpec | null,
    holdingNotes: string | null,
  ): InstrumentPlan {
    const pos = aliased.has(symbol) ? undefined : positionBySymbol.get(symbol);
    let type: PositionType;
    if (option) type = 'option';
    else if (pos) type = pos.type;
    else if (holdingNotes && /^ETF\b/.test(holdingNotes)) type = 'etf';
    else {
      type = 'stock';
      warnings.push(`${symbol}: not in positions.csv; instrument type assumed "stock"`);
    }
    return {
      symbol,
      instrumentType: type,
      name: option ? (pos?.name ?? optionLabel(option)) : (pos?.name ?? null),
      underlyingSymbol: option?.underlying ?? null,
      optionRight: option?.right ?? null,
      strike: option?.strike ?? null,
      expiry: option?.expiry ?? null,
      multiplier: option ? 100 : 1,
      listingNote: pos?.listingNote ?? null,
    };
  }

  // Total cost from positions.csv ("cost $151.12", "$194.67 total"), only for single-lot positions.
  for (const [symbol, pos] of positionBySymbol) {
    const total = pos.entryCostTotal ?? pos.notesCostTotal;
    if (!total) continue;
    const lots = holdings.filter((h) => h.symbol === symbol);
    if (lots.length !== 1) {
      warnings.push(`${symbol}: total cost $${total} not applied (${lots.length} lots)`);
      continue;
    }
    const lot = lots[0]!;
    const multiplier = BigInt(instruments.get(symbol)!.multiplier);
    const implied = (toMicros(lot.quantity) * toMicros(lot.avgCost) * multiplier) / 1_000_000n;
    const diff = implied - toMicros(total);
    if ((diff < 0n ? -diff : diff) * 100n > toMicros(total)) {
      warnings.push(
        `${symbol}: positions.csv total cost $${total} is >1% from qty × avg cost ($${fromMicros(implied)}); not applied`,
      );
      continue;
    }
    lot.costBasisTotal = total;
  }

  for (const o of overrides.holdings) {
    const { symbol } = resolveSymbol(o.ticker);
    const lots = holdings.filter((h) => h.symbol === symbol && h.accountType === o.account);
    if (lots.length === 0) {
      throw new SeedPlanError(`seed-overrides holdings: no ${o.ticker} in ${o.account}`);
    }
    for (const lot of lots) {
      lot.needsConfirmation = o.needs_confirmation;
      lot.confirmationNote = o.confirmation_note ?? null;
    }
    if (o.cost_basis_total) {
      if (lots.length !== 1) {
        throw new SeedPlanError(
          `seed-overrides holdings: cost_basis_total for ${o.ticker} needs exactly 1 lot (found ${lots.length})`,
        );
      }
      const lot = lots[0]!;
      const multiplier = BigInt(instruments.get(symbol)!.multiplier);
      const implied = (toMicros(lot.quantity) * toMicros(lot.avgCost) * multiplier) / 1_000_000n;
      const diff = implied - toMicros(o.cost_basis_total);
      if ((diff < 0n ? -diff : diff) * 100n > toMicros(o.cost_basis_total)) {
        throw new SeedPlanError(
          `seed-overrides holdings: ${o.ticker} cost_basis_total $${o.cost_basis_total} is >1% from holdings.md qty × avg cost ($${fromMicros(implied)})`,
        );
      }
      lot.costBasisTotal = o.cost_basis_total;
    }
  }

  // --- Theses (positions.csv + overrides) -------------------------------------------------------
  const theses = new Map<string, ThesisPlan>();
  for (const [symbol, pos] of positionBySymbol) {
    if (!instruments.has(symbol)) {
      warnings.push(`positions.csv: ${pos.ticker} is not held in holdings.md; row skipped`);
      continue;
    }
    if (aliased.has(symbol)) {
      warnings.push(`positions.csv: ${pos.ticker} row applied to ${symbol} via alias`);
    }
    const broken = pos.ruleCells.find((c) => c.kind === 'thesis_broken');
    theses.set(symbol, {
      symbol,
      whyIOwnIt: pos.whyIOwnIt,
      entryPrice: pos.entryPrice,
      entryDate: pos.entryDate,
      thesisStatus: pos.thesisStatus,
      thesisStatusNote: [pos.thesisStatusNote, broken?.text].filter(Boolean).join('; ') || null,
      lastChecked: pos.lastChecked,
      notes: pos.notes,
      needsInput: [...pos.needsInput],
    });
  }
  for (const o of overrides.theses) {
    const { symbol } = resolveSymbol(o.ticker);
    if (!instruments.has(symbol))
      throw new SeedPlanError(`seed-overrides theses: ${o.ticker} not held`);
    const t: ThesisPlan = theses.get(symbol) ?? {
      symbol,
      whyIOwnIt: null,
      entryPrice: null,
      entryDate: null,
      thesisStatus: 'unknown',
      thesisStatusNote: null,
      lastChecked: null,
      notes: null,
      needsInput: ['why_i_own_it', 'entry_price', 'entry_date'],
    };
    const set = (col: string, apply: () => void) => {
      apply();
      t.needsInput = t.needsInput.filter((c) => c !== col);
    };
    if (o.entry_price) set('entry_price', () => (t.entryPrice = o.entry_price!));
    if (o.entry_date) set('entry_date', () => (t.entryDate = o.entry_date!));
    if (o.why_i_own_it) set('why_i_own_it', () => (t.whyIOwnIt = o.why_i_own_it!));
    theses.set(symbol, t);
  }

  // --- Watchlist ------------------------------------------------------------------------------
  const watchPlans: WatchlistPlan[] = watchlist.map(({ line: _line, ticker, name, ...rest }) => {
    if (!instruments.has(ticker)) {
      warnings.push(`${ticker}: watchlist-only; instrument type assumed "stock"`);
      instruments.set(ticker, {
        symbol: ticker,
        instrumentType: 'stock',
        name,
        underlyingSymbol: null,
        optionRight: null,
        strike: null,
        expiry: null,
        multiplier: 1,
        listingNote: null,
      });
    }
    return { symbol: ticker, ...rest };
  });

  // --- Rules ----------------------------------------------------------------------------------
  const rules = new Map<string, RulePlan>();
  for (const [symbol, pos] of positionBySymbol) {
    if (!instruments.has(symbol)) continue;
    for (const cell of pos.ruleCells) {
      if (cell.kind !== 'rule') continue;
      const key = `positions:${symbol}:${cell.purpose}`;
      const placeholder = cell.status === 'PLACEHOLDER';
      rules.set(key, {
        externalKey: key,
        symbol,
        purpose: cell.purpose,
        ruleType: null,
        params: {},
        status: cell.status,
        // Untyped rules are judgment rules: their text is the trigger description.
        thesisBreakTriggers: placeholder ? null : cell.text,
        alertNote: null,
        sourceText: cell.text,
        confirmedAt: cell.confirmedAt,
        notes: null,
        needsInput: placeholder ? ['rule_type', 'params'] : [],
      });
    }
  }

  for (const o of overrides.rules) {
    const { symbol } = resolveSymbol(o.ticker);
    if (!instruments.has(symbol)) throw new SeedPlanError(`${o.key}: unknown ticker ${o.ticker}`);
    const existing = rules.get(o.key);
    if (o.key.startsWith('positions:')) {
      if (!existing) throw new SeedPlanError(`${o.key}: no such positions.csv rule to override`);
      if (existing.symbol !== symbol) throw new SeedPlanError(`${o.key}: ticker mismatch`);
    } else if (existing) {
      throw new SeedPlanError(`${o.key}: duplicate key in seed-overrides`);
    }
    rules.set(o.key, {
      externalKey: o.key,
      symbol,
      purpose: o.purpose,
      ruleType: o.rule_type,
      params: o.params,
      status: o.status,
      thesisBreakTriggers:
        o.thesis_break_triggers ?? (o.rule_type ? null : (existing?.thesisBreakTriggers ?? null)),
      alertNote: o.alert_note ?? null,
      sourceText: existing?.sourceText ?? null,
      confirmedAt: o.confirmed_at ?? existing?.confirmedAt ?? null,
      notes: o.notes ?? null,
      needsInput: o.needs_input,
    });
  }

  // Defaults: ±7% day move for every held stock; 10/15/20% drawdown tiers for every held ETF.
  const heldSymbols = new Set(holdings.map((h) => h.symbol));
  const hasType = (symbol: string, type: RuleType) =>
    [...rules.values()].some((r) => r.symbol === symbol && r.ruleType === type);
  for (const symbol of heldSymbols) {
    const inst = instruments.get(symbol)!;
    const add = (ruleType: RuleType, params: Record<string, unknown>) => {
      if (hasType(symbol, ruleType)) return;
      const key = `default:${symbol}:${ruleType}`;
      rules.set(key, {
        externalKey: key,
        symbol,
        purpose: 'monitor',
        ruleType,
        params,
        status: 'PLACEHOLDER',
        thesisBreakTriggers: null,
        alertNote: null,
        sourceText: null,
        confirmedAt: null,
        notes: 'default rule',
        needsInput: [],
      });
    };
    if (inst.instrumentType === 'stock' || inst.instrumentType === 'otc_stock') {
      add('day_move_pct', { pct: DEFAULT_STOCK_DAY_MOVE_PCT });
    } else if (inst.instrumentType === 'etf') {
      add('etf_drawdown_from_52w_high', { tiers: [...DEFAULT_ETF_DRAWDOWN_TIERS] });
    }
  }

  for (const r of rules.values()) {
    if (r.ruleType) parseRuleParams(r.ruleType, r.params);
    if (r.status === 'CONFIRMED' && !r.ruleType && !r.thesisBreakTriggers) {
      throw new SeedPlanError(
        `${r.externalKey}: CONFIRMED rule needs a rule_type or judgment text`,
      );
    }
  }

  const bySymbol = (a: { symbol: string }, b: { symbol: string }) =>
    a.symbol.localeCompare(b.symbol);
  return {
    accounts,
    instruments: [...instruments.values()].sort(bySymbol),
    holdings,
    theses: [...theses.values()].sort(bySymbol),
    rules: [...rules.values()].sort(
      (a, b) => a.symbol.localeCompare(b.symbol) || a.externalKey.localeCompare(b.externalKey),
    ),
    watchlist: watchPlans,
    events: planEvents(input.events ?? [], instruments, warnings),
    warnings,
  };
}

/** Seed events, warning about tickers we don't follow (they get no news/filings/prices). */
function planEvents(
  rows: readonly ParsedEventRow[],
  instruments: ReadonlyMap<string, InstrumentPlan>,
  warnings: string[],
): EventInput[] {
  const followed = new Set<string>();
  for (const i of instruments.values()) followed.add(i.underlyingSymbol ?? i.symbol);
  for (const r of rows) {
    if (!followed.has(r.ticker)) {
      warnings.push(`events.csv:${r.line}: ${r.ticker} is not a holding or on the watchlist`);
    }
  }
  return seedEventInputs(rows);
}
