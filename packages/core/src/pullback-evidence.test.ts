import { describe, expect, it } from 'vitest';
import type { Scorecard } from './fundamentals';
import { bullEvidence, tradingDaysSince, valuationNow } from './pullback-evidence';

const sc: Scorecard = {
  currency: 'USD',
  periodEnd: '2026-09-30',
  annualOnly: false,
  revenueTtm: 1e11,
  revenueYoYPct: 18.04,
  revenueCagr3yPct: 14.2,
  grossMarginPct: 68.4,
  operatingMarginPct: 31.2,
  netMarginPct: 25,
  netIncomeTtm: 2.5e10,
  netIncomeAnnual: [
    { end: '2023-12-31', value: 1 },
    { end: '2024-12-31', value: 2 },
    { end: '2025-12-31', value: 3 },
  ],
  ocfTtm: 4e10,
  capexTtm: 9e9,
  fcfTtm: 3.1e10,
  fcfMarginPct: 31,
  cash: 5e10,
  debt: 1e10,
  netCash: 4e10,
  dilutedShares: 1e9,
  dilutionYoYPct: -1.9,
  epsTtm: 25,
  fcfPerShare: 31,
  peMedian: 27.4,
  pfcfMedian: 22,
  valuationPoints: 20,
  notes: [],
};

describe('valuationNow', () => {
  it('price over TTM per-share earnings and FCF; null when negative', () => {
    expect(valuationNow(sc, 475)).toEqual({ pe: 19, pfcf: 15.3 });
    expect(valuationNow({ ...sc, epsTtm: -1, fcfPerShare: null }, 475)).toEqual({
      pe: null,
      pfcf: null,
    });
    expect(valuationNow(null, 10)).toEqual({ pe: null, pfcf: null });
  });
});

describe('bullEvidence', () => {
  it('lists only facts that favour the company, from the numbers', () => {
    expect(bullEvidence(sc, valuationNow(sc, 475))).toEqual([
      'Revenue +18% y/y',
      '3-year revenue CAGR 14.2%',
      'Gross margin 68%',
      'Operating margin 31%',
      'FCF margin 31%',
      'Net cash $40.0B',
      'Diluted share count -1.9% y/y (buybacks)',
      'P/E 19 vs 5-yr median 27',
      'P/FCF 15 vs 5-yr median 22',
      'Profitable in each of the last 3 fiscal years',
    ]);
  });

  it('leaves out what is not favourable (expensive vs median, net debt, dilution, low margins)', () => {
    const weak = {
      ...sc,
      netCash: -5e9,
      dilutionYoYPct: 3,
      grossMarginPct: 30,
      operatingMarginPct: 8,
    };
    const b = bullEvidence(weak, { pe: 40, pfcf: 30 });
    expect(b.some((x) => /P\/E|P\/FCF|Net cash|share count|Gross|Operating/.test(x))).toBe(false);
  });
});

describe('tradingDaysSince (earnings → drop)', () => {
  const sessions = ['2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17', '2026-11-18'];
  it('counts trading days, so a weekend does not count', () => {
    expect(tradingDaysSince('2026-11-13', '2026-11-17', sessions)).toBe(2);
    expect(tradingDaysSince('2026-11-17', '2026-11-17', sessions)).toBe(0);
    // Filed on a Saturday: counts from the next session.
    expect(tradingDaysSince('2026-11-14', '2026-11-17', sessions)).toBe(1);
    expect(tradingDaysSince('2026-11-18', '2026-11-17', sessions)).toBeNull();
    expect(tradingDaysSince(null, '2026-11-17', sessions)).toBeNull();
  });
});
