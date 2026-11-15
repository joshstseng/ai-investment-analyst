import { describe, expect, it } from 'vitest';
import { HOLDINGS_MD, OVERRIDES, POSITIONS_CSV, WATCHLIST_CSV } from './fixtures';
import { parseHoldingsMd } from './holdings-md';
import { seedOverridesSchema } from './overrides';
import { buildSeedPlan, SeedPlanError, type SeedInput } from './plan';
import { classifyRuleCell, parsePositionsCsv } from './positions-csv';
import { parseWatchlistCsv } from './watchlist-csv';

const input = (overrides: unknown = OVERRIDES): SeedInput => ({
  holdingsMd: parseHoldingsMd(HOLDINGS_MD),
  positions: parsePositionsCsv(POSITIONS_CSV),
  watchlist: parseWatchlistCsv(WATCHLIST_CSV),
  overrides: seedOverridesSchema.parse(overrides),
});

describe('parseHoldingsMd', () => {
  const md = parseHoldingsMd(HOLDINGS_MD);

  it('reads the as-of time in ET as UTC', () => {
    expect(md.asOf?.toISOString()).toBe('2026-11-12T21:33:00.000Z');
  });

  it('reads both accounts with totals and stops at other headings', () => {
    expect(md.accounts.map((a) => a.accountType)).toEqual(['roth_ira', 'individual_taxable']);
    expect(md.accounts[0]).toMatchObject({
      totalValue: '6000.5',
      cashBalance: '1000.25',
      balancesNote: 'before the XYZ order',
    });
    expect(md.accounts[1]).toMatchObject({ cashBalance: '86.1', balancesNote: null });
  });

  it('parses fractional shares, lots, contracts and cost notes', () => {
    const [roth, indiv] = md.accounts;
    expect(roth!.rows.find((r) => r.ticker === 'FRAC')!.lots).toEqual([
      { quantity: '12.345', avgCost: '7.03', costNote: null },
    ]);
    expect(roth!.rows.find((r) => r.ticker === 'XYZ')!.lots[0]!.costNote).toBe(
      'limit order placed; confirm fill',
    );
    expect(indiv!.rows.find((r) => r.ticker === 'ETFX')!.lots).toEqual([
      { quantity: '4', avgCost: '49.9', costNote: null },
      { quantity: '6', avgCost: '50.2', costNote: null },
    ]);
    const opt = indiv!.rows.find((r) => r.option)!;
    expect(opt.option).toEqual({
      underlying: 'OPTQ',
      right: 'call',
      strike: '6',
      expiry: '2027-03-19',
    });
    expect(opt.lots[0]!.quantity).toBe('1');
  });

  it.each([
    ['lots that do not add up', '| ETFX | 4 + 6 = 11 | $1 / $2 | | |', /do not add up/],
    ['lot/cost count mismatch', '| ETFX | 4 + 6 = 10 | $1 | | |', /2 lot\(s\)/],
    ['bad share count', '| AAA | ten | $1 | | |', /unrecognised share count/],
    ['bad cost', '| AAA | 10 | 100 | | |', /unrecognised avg cost/],
    ['bad ticker', '| aaa corp | 10 | $1 | | |', /unrecognised ticker/],
  ])('rejects %s with a line number', (_name, row, message) => {
    const text = `## Roth IRA\n| Ticker | Shares | Avg cost | Notes |\n|---|---|---|---|\n${row}\n`;
    expect(() => parseHoldingsMd(text)).toThrow(message);
    expect(() => parseHoldingsMd(text)).toThrow(/holdings\.md:4/);
  });

  it('rejects duplicate rows in one account', () => {
    const text = `## Roth IRA\n| Ticker | Shares | Avg cost |\n|---|---|---|\n| AAA | 1 | $1 |\n| AAA | 2 | $2 |\n`;
    expect(() => parseHoldingsMd(text)).toThrow(/duplicate row/);
  });
});

describe('parsePositionsCsv', () => {
  const rows = parsePositionsCsv(POSITIONS_CSV);
  const by = (t: string) => rows.find((r) => r.ticker === t)!;

  it('stores NEEDS USER INPUT as null plus a flag', () => {
    expect(by('AAA')).toMatchObject({ entryPrice: null, entryDate: null, whyIOwnIt: null });
    expect(by('AAA').needsInput).toEqual(['entry_price', 'entry_date', 'why_i_own_it']);
  });

  it('detects OTC listings, option rows and cost totals', () => {
    expect(by('OTCF')).toMatchObject({
      type: 'otc_stock',
      name: 'Otc Co plc',
      listingNote: 'OTC; LSE:OTC',
      notesCostTotal: '151.12',
      thesisStatus: 'weakening',
      thesisStatusNote: 'reason changed',
    });
    expect(by('OPTQ 2027-03-19 6C')).toMatchObject({
      type: 'option',
      entryPrice: '1.95',
      entryCostTotal: '194.67',
    });
  });

  it.each([
    ['DRAFT PENDING (needs entry price)', { kind: 'rule', status: 'PLACEHOLDER' }],
    ['DRAFT: something', { kind: 'rule', status: 'DRAFT' }],
    ['CONFIRMED: close below $2', { kind: 'rule', status: 'CONFIRMED', confirmedAt: null }],
    ['CONFIRMED by user 2026-11-12: x', { kind: 'rule', confirmedAt: '2026-11-12' }],
    ['n/a', { kind: 'skip', reason: 'n/a' }],
    ['See catalyst_take_profit', { kind: 'skip', reason: 'cross-reference' }],
    ['BROKEN 2026-11-12: x', { kind: 'thesis_broken' }],
    ['', { kind: 'skip', reason: 'empty' }],
  ])('classifies %j', (text, expected) => {
    expect(classifyRuleCell(2, 'risk_stop', text)).toMatchObject(expected);
  });

  it('rejects unknown rule text, types and statuses', () => {
    expect(() => classifyRuleCell(5, 'risk_stop', 'maybe sell?')).toThrow(/positions\.csv:5/);
    const header = POSITIONS_CSV.split('\n')[0];
    expect(() => parsePositionsCsv(`${header}\nAAA,A,Bond,1,2026-01-01,x,,,,,Unknown,,\n`)).toThrow(
      /unknown type/,
    );
    expect(() => parsePositionsCsv(`${header}\nAAA,A,Stock,1,2026-01-01,x,,,,,Great,,\n`)).toThrow(
      /thesis_status/,
    );
    expect(() => parsePositionsCsv('ticker,name\nAAA,A\n')).toThrow(/missing column/);
  });
});

describe('parseWatchlistCsv', () => {
  it('reads quoted fields and dates', () => {
    expect(parseWatchlistCsv(WATCHLIST_CSV)[0]).toMatchObject({
      ticker: 'WATCH',
      thesisSummary: 'Summary, with commas',
      reviewBy: '2027-02-28',
    });
  });
});

describe('buildSeedPlan', () => {
  const plan = buildSeedPlan(input());
  const holding = (account: string, symbol: string, lot = 1) =>
    plan.holdings.find((h) => h.accountType === account && h.symbol === symbol && h.lotNo === lot);
  const rulesFor = (symbol: string) => plan.rules.filter((r) => r.symbol === symbol);

  it('keeps the same ticker in both accounts and multiple lots per account', () => {
    expect(holding('roth_ira', 'AAA')).toMatchObject({ quantity: '10', avgCost: '100' });
    expect(holding('individual_taxable', 'AAA')).toMatchObject({ quantity: '2', avgCost: '120.5' });
    expect(holding('individual_taxable', 'ETFX', 2)).toMatchObject({
      quantity: '6',
      avgCost: '50.2',
    });
    expect(plan.holdings).toHaveLength(10);
  });

  it('builds option and OTC instruments', () => {
    const opt = plan.instruments.find((i) => i.symbol === 'OPTQ270319C00006000');
    expect(opt).toMatchObject({
      instrumentType: 'option',
      underlyingSymbol: 'OPTQ',
      multiplier: 100,
    });
    expect(plan.instruments.find((i) => i.symbol === 'OTCF')).toMatchObject({
      instrumentType: 'otc_stock',
      listingNote: 'OTC; LSE:OTC',
    });
    expect(plan.instruments.find((i) => i.symbol === 'ETFX')!.instrumentType).toBe('etf');
  });

  it('applies total cost only when it is within 1% of qty × avg cost', () => {
    expect(holding('individual_taxable', 'OTCF')!.costBasisTotal).toBe('151.12');
    expect(holding('individual_taxable', 'OPTQ270319C00006000')!.costBasisTotal).toBe('194.67');
  });

  it('flags the unconfirmed fill and fills thesis fields from overrides', () => {
    expect(holding('roth_ira', 'XYZ')).toMatchObject({
      needsConfirmation: true,
      confirmationNote: 'confirm',
    });
    expect(plan.theses.find((t) => t.symbol === 'XYZ')).toMatchObject({
      entryPrice: '50.00',
      entryDate: '2026-11-12',
      needsInput: ['why_i_own_it'],
    });
  });

  it('applies aliased positions rows to the target instrument', () => {
    expect(plan.theses.find((t) => t.symbol === 'CALLZ280616C00045000')).toBeDefined();
    const keys = rulesFor('CALLZ280616C00045000').map((r) => r.externalKey);
    expect(keys).toContain('positions:CALLZ280616C00045000:risk_stop');
    expect(plan.instruments.find((i) => i.symbol === 'ALIAS')).toBeUndefined();
  });

  it('rejects an alias onto an instrument that already has its own row', () => {
    expect(() =>
      buildSeedPlan(input({ ...OVERRIDES, aliases: { ALIAS: 'OPTQ Mar-19-2027 $6 call' } })),
    ).toThrow(/two rows map to OPTQ270319C00006000/);
  });

  it('records a BROKEN thesis as a note, not a rule', () => {
    expect(plan.theses.find((t) => t.symbol === 'OPTQ270319C00006000')).toMatchObject({
      thesisStatus: 'breaking',
      thesisStatusNote: 'BROKEN 2026-11-12: customer missed target',
    });
    expect(rulesFor('OPTQ270319C00006000')).toEqual([]);
  });

  it('upgrades a positions.csv cell to a typed rule and keeps its text', () => {
    expect(plan.rules.find((r) => r.externalKey === 'positions:OTCF:risk_stop')).toMatchObject({
      ruleType: 'stop_close_below',
      params: { level: 1.2 },
      status: 'CONFIRMED',
      sourceText: 'CONFIRMED: exit on a daily close below $1.20',
      thesisBreakTriggers: null,
    });
    expect(plan.rules.find((r) => r.externalKey === 'positions:OTCF:thesis_break')).toMatchObject({
      ruleType: null,
      confirmedAt: '2026-11-12',
      thesisBreakTriggers: 'CONFIRMED by user 2026-11-12: exit if guidance cut',
    });
  });

  it('adds default rules unless a rule of that type exists', () => {
    expect(rulesFor('AAA').find((r) => r.ruleType === 'day_move_pct')).toMatchObject({
      externalKey: 'default:AAA:day_move_pct',
      params: { pct: 7 },
      status: 'PLACEHOLDER',
    });
    const frac = rulesFor('FRAC').filter((r) => r.ruleType === 'day_move_pct');
    expect(frac).toHaveLength(1);
    expect(frac[0]!.params).toEqual({ pct: 10 });
    expect(
      rulesFor('ETFX').find((r) => r.ruleType === 'etf_drawdown_from_52w_high')!.params,
    ).toEqual({
      tiers: [10, 15, 20],
    });
    expect(rulesFor('OPTQ270319C00006000').some((r) => r.externalKey.startsWith('default:'))).toBe(
      false,
    );
  });

  it('marks DRAFT PENDING cells as placeholders that need a rule type', () => {
    expect(plan.rules.find((r) => r.externalKey === 'positions:AAA:risk_stop')).toMatchObject({
      status: 'PLACEHOLDER',
      ruleType: null,
      needsInput: ['rule_type', 'params'],
    });
  });

  it('rejects overrides that point at nothing or carry bad params', () => {
    const bad = (rules: unknown[]) => () => buildSeedPlan(input({ ...OVERRIDES, rules }));
    const base = { ticker: 'AAA', purpose: 'risk_stop', status: 'DRAFT' };
    expect(
      bad([{ ...base, key: 'positions:AAA:nope', rule_type: null, thesis_break_triggers: 'x' }]),
    ).toThrow(SeedPlanError);
    expect(bad([{ ...base, key: 'manual:x', ticker: 'NOPE', rule_type: null }])).toThrow(
      /unknown ticker/,
    );
    expect(() =>
      seedOverridesSchema.parse({
        rules: [{ ...base, key: 'manual:x', rule_type: 'stop_close_below', params: { level: -1 } }],
      }),
    ).toThrow();
    expect(() =>
      buildSeedPlan(
        input({
          ...OVERRIDES,
          holdings: [{ account: 'roth_ira', ticker: 'OTCF', needs_confirmation: true }],
        }),
      ),
    ).toThrow(/no OTCF in roth_ira/);
  });
});
