import { describe, expect, it } from 'vitest';
import {
  buildScorecard,
  dedupeFacts,
  mergeConcepts,
  qualityCheck,
  ttm,
  type CompanyFacts,
  type QualityConfig,
  type XbrlFact,
} from './fundamentals';

const A = (year: number, val: number, filed = `${year + 1}-02-15`): XbrlFact => ({
  start: `${year}-01-01`,
  end: `${year}-12-31`,
  val,
  form: '10-K',
  filed,
});
const YTD9 = (year: number, val: number): XbrlFact => ({
  start: `${year}-01-01`,
  end: `${year}-09-30`,
  val,
  form: '10-Q',
  filed: `${year}-10-30`,
});
const Q = (start: string, end: string, val: number): XbrlFact => ({
  start,
  end,
  val,
  form: '10-Q',
  filed: end,
});
const I = (end: string, val: number): XbrlFact => ({ end, val, form: '10-Q', filed: end });

describe('dedupe and merge', () => {
  it('keeps periodic-report facts, latest filing per period', () => {
    const facts = [
      A(2024, 100, '2025-02-15'),
      A(2024, 101, '2026-02-15'), // restated in the next 10-K
      { ...A(2024, 999), form: 'DEF 14A', filed: '2026-04-01' }, // proxy: ignored
    ];
    expect(dedupeFacts(facts).map((f) => f.val)).toEqual([101]);
  });

  it('merges concepts with the preferred concept winning the same period', () => {
    const merged = mergeConcepts([[A(2025, 10)], [A(2025, 99), A(2024, 8)]]);
    expect(merged.map((f) => [f.end, f.val])).toEqual([
      ['2024-12-31', 8],
      ['2025-12-31', 10],
    ]);
  });
});

describe('ttm', () => {
  const revenue = [A(2024, 121), A(2025, 133), YTD9(2024, 88), YTD9(2025, 97), YTD9(2026, 106)];

  it('last annual + this year-to-date − last year’s year-to-date', () => {
    expect(ttm(revenue)).toEqual({ value: 133 + 106 - 97, end: '2026-09-30', method: 'ytd' });
  });

  it('as of an earlier date (the prior-year TTM used for growth)', () => {
    expect(ttm(revenue, '2025-10-15')).toEqual({
      value: 121 + 97 - 88,
      end: '2025-09-30',
      method: 'ytd',
    });
  });

  it('is the annual figure at a fiscal year end', () => {
    expect(ttm(revenue, '2025-12-31')).toMatchObject({ value: 133, method: 'annual' });
  });

  it('falls back to four discrete quarters', () => {
    const qs = [
      Q('2025-10-01', '2025-12-31', 4),
      Q('2026-01-01', '2026-03-31', 5),
      Q('2026-04-01', '2026-06-30', 6),
      Q('2026-07-01', '2026-09-30', 7),
    ];
    expect(ttm(qs)).toEqual({ value: 22, end: '2026-09-30', method: 'quarters' });
    expect(ttm(qs.slice(1))).toBeNull();
  });
});

const usd = (series: CompanyFacts['series']): CompanyFacts => ({
  taxonomy: 'us-gaap',
  currency: 'USD',
  series,
});

/** A profitable made-up company: revenue growing ~10%, solid margins, net cash, buybacks. */
function goodCo(): CompanyFacts {
  return usd({
    revenue: [
      A(2022, 100),
      A(2023, 110),
      A(2024, 121),
      A(2025, 133),
      YTD9(2024, 88),
      YTD9(2025, 97),
      YTD9(2026, 106),
    ],
    grossProfit: [A(2025, 80), YTD9(2025, 58), YTD9(2026, 64)],
    operatingIncome: [A(2025, 40), YTD9(2025, 29), YTD9(2026, 32)],
    netIncome: [
      A(2022, 20),
      A(2023, 22),
      A(2024, 25),
      A(2025, 30),
      YTD9(2024, 18),
      YTD9(2025, 22),
      YTD9(2026, 24),
    ],
    ocf: [A(2025, 45), YTD9(2025, 33), YTD9(2026, 36)],
    capex: [A(2025, 10), YTD9(2025, 7), YTD9(2026, 8)],
    cash: [I('2026-09-30', 50)],
    shortTermInvestments: [I('2026-09-30', 20)],
    longTermDebt: [I('2026-09-30', 30)],
    dilutedShares: [Q('2025-07-01', '2025-09-30', 10.5), Q('2026-07-01', '2026-09-30', 10)],
  });
}

describe('buildScorecard', () => {
  const sc = buildScorecard(goodCo(), {
    today: '2026-11-17',
    historyYears: 5,
    closeOnOrBefore: () => 50,
  });

  it('TTM growth, CAGR, margins, FCF, net cash, dilution', () => {
    expect(sc).toMatchObject({
      periodEnd: '2026-09-30',
      annualOnly: false,
      revenueTtm: 142, // 133 + 106 − 97
      revenueYoYPct: 9.2, // vs 121 + 97 − 88 = 130
      revenueCagr3yPct: 10, // 100 → 133 over 3 years
      grossMarginPct: 60.6, // 80 + 64 − 58 = 86
      operatingMarginPct: 30.3, // 43 / 142
      netMarginPct: 22.5, // 32 / 142
      netIncomeTtm: 32,
      fcfTtm: 37, // (45 + 36 − 33) − (10 + 8 − 7)
      fcfMarginPct: 26.1,
      netCash: 40, // 50 + 20 − 30
      dilutionYoYPct: -4.8, // 10 vs 10.5 shares: buybacks
    });
    expect(sc.epsTtm).toBeCloseTo(3.2);
  });

  it('valuation medians from period ends with positive earnings', () => {
    expect(sc.valuationPoints).toBeGreaterThanOrEqual(3);
    expect(sc.peMedian).not.toBeNull();
  });

  it('non-USD filers: ratios yes, valuation no', () => {
    const twd = buildScorecard(
      { ...goodCo(), taxonomy: 'ifrs-full', currency: 'TWD' },
      { today: '2026-11-17', historyYears: 5, closeOnOrBefore: () => 50 },
    );
    expect(twd).toMatchObject({ epsTtm: null, peMedian: null, revenueYoYPct: 9.2 });
    expect(twd.notes).toContain('reported in TWD: valuation multiples not computed');
  });
});

describe('qualityCheck', () => {
  const cfg: QualityConfig = {
    profitableYears: 3,
    requirePositiveTtmNetIncome: true,
    requirePositiveTtmFcf: true,
    minRevenueGrowthPct: 0,
    minMarketCapUsd: 10e9,
  };
  const base = buildScorecard(goodCo(), {
    today: '2026-11-17',
    historyYears: 5,
    closeOnOrBefore: () => 50,
  });

  it('passes a proven-profitable grower', () => {
    expect(qualityCheck(base, cfg, 50e9)).toEqual({ pass: true, reasons: [], missing: [] });
  });

  it('fails on a loss year, negative FCF, shrinking revenue, small market cap', () => {
    const r = qualityCheck(
      {
        ...base,
        netIncomeAnnual: [
          { end: '2023-12-31', value: 5 },
          { end: '2024-12-31', value: -2 },
          { end: '2025-12-31', value: 3 },
        ],
        fcfTtm: -1,
        revenueYoYPct: -4.5,
      },
      cfg,
      5e9,
    );
    expect(r.pass).toBe(false);
    expect(r.reasons).toEqual([
      'net loss in fiscal 2024',
      'negative TTM free cash flow',
      'revenue -4.5% y/y',
      'market cap $5.0B < $10B',
    ]);
  });

  it('missing data counts as a fail, with the reason', () => {
    const r = qualityCheck({ ...base, netIncomeAnnual: [], fcfTtm: null }, cfg, null);
    expect(r).toMatchObject({
      pass: false,
      missing: ['3 fiscal years of net income', 'TTM free cash flow'],
    });
  });
});
