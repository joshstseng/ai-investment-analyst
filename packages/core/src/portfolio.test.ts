import { describe, expect, it } from 'vitest';
import { filingTitle } from './filings';
import { nextLevel, levelsToWatch, type LevelInstrumentInput } from './levels';
import {
  accountTag,
  attentionRange,
  byAttention,
  lotLine,
  portfolioDay,
  positionPL,
  type AttentionSortKey,
} from './portfolio';

describe('portfolioDay', () => {
  it('sums shares × (close − previous close) over stocks/ETFs; % is vs the previous value', () => {
    const d = portfolioDay([
      { display: 'ACMX', isOption: false, shares: 10, close: 110, prevClose: 100 }, // +100
      { display: 'ETFX', isOption: false, shares: 4, close: 45, prevClose: 50 }, // −20
      { display: 'OPTX Jan-21-2028 $55 call', isOption: true, shares: 1, close: 70, prevClose: 60 },
      { display: 'OTCQ', isOption: false, shares: 60, close: null, prevClose: null },
    ]);
    expect(d.change).toBe(80);
    expect(d.pct).toBe(6.67); // 80 / (1000 + 200)
    expect(d.value).toBe(1280);
    expect(d.excluded).toEqual([
      { display: 'OPTX Jan-21-2028 $55 call', reason: 'option' },
      { display: 'OTCQ', reason: 'no price' },
    ]);
  });

  it('handles fractional shares and an empty portfolio', () => {
    expect(
      portfolioDay([
        { display: 'FRAC', isOption: false, shares: 12.345, close: 50, prevClose: 52.5 },
      ]).change,
    ).toBe(-30.86);
    expect(portfolioDay([])).toEqual({ change: 0, pct: null, value: 0, excluded: [] });
  });
});

describe('positionPL', () => {
  it('uses the broker cost basis total when known, else quantity × avg cost', () => {
    expect(
      positionPL(
        [
          { account: 'roth_ira', quantity: 9, avgCost: 50.01, costBasisTotal: 450.07 },
          { account: 'individual_taxable', quantity: 1, avgCost: 60 },
        ],
        55,
      ),
    ).toEqual({ shares: 10, value: 550, cost: 510.07, plDollars: 39.93, plPct: 7.83 });
  });
});

describe('accountTag and lotLine', () => {
  it('tags accounts R / I / R+I', () => {
    expect(accountTag(['roth_ira'])).toBe('R');
    expect(accountTag(['individual_taxable'])).toBe('I');
    expect(accountTag(['individual_taxable', 'roth_ira', 'roth_ira'])).toBe('R+I');
  });

  it('details 2 lots, summarizes 3+, and is null for one lot', () => {
    expect(lotLine([{ quantity: 10, avgCost: 50 }])).toBeNull();
    expect(
      lotLine([
        { quantity: 12, avgCost: 74.71 },
        { quantity: 9, avgCost: 81.5 },
      ]),
    ).toBe('12 @ 74.71 · 9 @ 81.50');
    expect(
      lotLine([
        { quantity: 100, avgCost: 10 },
        { quantity: 50.5, avgCost: 11 },
        { quantity: 20, avgCost: 12 },
      ]),
    ).toBe('3 lots · 170.5 sh');
  });
});

describe('byAttention', () => {
  const k = (display: string, over: Partial<AttentionSortKey>): AttentionSortKey => ({
    tag: 'REVIEW',
    escalated: false,
    alertedToday: true,
    compact: false,
    dayPct: 0,
    display,
    ...over,
  });
  it('orders by severity, escalation, alerted today, full before compact, bigger move', () => {
    const xs = [
      k('REMX', { tag: 'REMINDER' }),
      k('CMPX', { compact: true, dayPct: -9 }),
      k('OLDX', { alertedToday: false }),
      k('ESCX', { escalated: true }),
      k('BIGX', { dayPct: -4 }),
      k('SMLX', { dayPct: 1 }),
      k('WRNX', { tag: 'WARNING' }),
      k('ACTX', { tag: 'ACTION' }),
    ];
    expect(xs.sort(byAttention).map((x) => x.display)).toEqual([
      'ACTX',
      'WRNX',
      'ESCX',
      'BIGX',
      'SMLX',
      'CMPX',
      'OLDX',
      'REMX',
    ]);
  });
});

describe('nextLevel and 52-week-low / cost levels', () => {
  const base = (
    close: number,
    rules: LevelInstrumentInput['rules'],
    over = {},
  ): LevelInstrumentInput => ({
    display: 'ACMX',
    instrumentSymbol: 'ACMX',
    evaluatedSymbol: 'ACMX',
    close,
    rules,
    ...over,
  });
  const lowRule = { status: 'PLACEHOLDER' as const, ruleType: 'new_52w_low', params: {} };

  it('picks the nearest uncrossed level at any distance', () => {
    const inst = base(100, [
      { status: 'DRAFT', ruleType: 'stop_close_below', params: { level: 80 } },
      {
        status: 'CONFIRMED',
        ruleType: 'take_profit_at_or_above',
        params: { level: 130, basis: 'close' },
      },
    ]);
    expect(nextLevel(inst, '2026-11-13')).toMatchObject({
      kind: 'stop',
      level: 80,
      distancePct: 20,
    });
  });

  it('includes cost (close_below_cost) and the prior 52-week low', () => {
    expect(
      nextLevel(
        base(101, [{ status: 'PLACEHOLDER', ruleType: 'close_below_cost', params: { cost: 100 } }]),
        '2026-11-13',
      ),
    ).toMatchObject({ kind: 'below_cost', label: 'cost', level: 100 });
    expect(nextLevel(base(4.72, [lowRule], { low52w: 4.43 }), '2026-11-13')).toMatchObject({
      kind: 'low_52w',
      distancePct: 6.14,
    });
    // A new low today (close below the prior low) is crossed, not a next level.
    expect(nextLevel(base(4.2, [lowRule], { low52w: 4.5 }), '2026-11-13')).toBeNull();
  });

  it('levels to watch: 52-week lows within 8%, everything else within 5%', () => {
    const insts = [
      base(4.72, [lowRule], { display: 'LOWX', low52w: 4.43 }), // 6.1% → in (8%)
      base(3.53, [lowRule], { display: 'FARX', low52w: 3.2 }), // 9.3% → out
      base(37.81, [{ status: 'DRAFT', ruleType: 'stop_close_below', params: { level: 35.5 } }], {
        display: 'STPX',
      }), // 6.1% → out (5%)
    ];
    expect(
      levelsToWatch(insts, { asOfDate: '2026-11-13', withinPctByKind: { low_52w: 8 } }).map(
        (l) => l.display,
      ),
    ).toEqual(['LOWX']);
  });
});

describe('filingTitle', () => {
  it.each<[string, string[], string, string | null, boolean]>([
    ['8-K', ['2.02', '9.01'], '8-K · results', 'Item 2.02', true],
    ['8-K', ['5.02'], '8-K · management change', 'Item 5.02', false],
    [
      '8-K',
      ['1.01', '7.01', '9.01'],
      '8-K · material agreement, Reg FD disclosure',
      'Items 1.01, 7.01',
      false,
    ],
    ['8-K', ['8.01'], '8-K · other events', 'Item 8.01', false],
    ['8-K', ['9.01'], '8-K · financial statements and exhibits', 'Item 9.01', false],
    ['10-Q', [], '10-Q · quarterly report', null, false],
    ['10-K/A', [], '10-K (amended) · annual report', null, false],
    ['S-3ASR', [], 'S-3ASR · possible share issuance', null, false],
    ['424B5', [], '424B5 · possible share issuance', null, false],
    ['4', [], 'Form 4 · insider filing', null, false],
  ])('%s %j → %s', (form, items, title, itemsNote, earnings) => {
    expect(filingTitle(form, items)).toMatchObject({ title, itemsNote, earnings });
  });
});

describe('attentionRange', () => {
  const base = {
    stops: [] as number[],
    takeProfits: [] as number[],
    avgCost: null as number | null,
  };
  it('drawdown: deepest tier ↔ 52-week high', () => {
    expect(
      attentionRange({
        ...base,
        ruleType: 'etf_drawdown_from_52w_high',
        observed: { high: 120, tiers: [10, 15, 20] },
        close: 99,
      }),
    ).toEqual({
      left: { label: '20%', value: 96 },
      right: { label: 'high', value: 120 },
      markerPct: 13,
    });
  });
  it('stop: stop ↔ nearest take-profit above, else cost; a breached stop pins the marker at 0', () => {
    const stop = { ...base, ruleType: 'stop_close_below', observed: { level: 45 } };
    expect(attentionRange({ ...stop, close: 50, takeProfits: [70, 60] })).toEqual({
      left: { label: 'stop', value: 45 },
      right: { label: 'take-profit', value: 60 },
      markerPct: 33,
    });
    expect(attentionRange({ ...stop, close: 44, avgCost: 50 })!.markerPct).toBe(0);
    expect(attentionRange({ ...stop, close: 50 })).toBeNull();
  });
  it('take-profit: stop (or cost) ↔ take-profit', () => {
    expect(
      attentionRange({
        ...base,
        ruleType: 'take_profit_at_or_above',
        observed: { level: 60 },
        close: 61,
        stops: [45],
      }),
    ).toMatchObject({ left: { label: 'stop', value: 45 }, markerPct: 100 });
  });
  it('new low: low ↔ cost', () => {
    expect(
      attentionRange({
        ...base,
        ruleType: 'new_52w_low',
        observed: {},
        close: 4.2,
        avgCost: 8,
      }),
    ).toEqual({
      left: { label: 'low', value: 4.2 },
      right: { label: 'cost', value: 8 },
      markerPct: 0,
    });
  });
});
