import { describe, expect, it } from 'vitest';
import { atr, priceMetrics, type PriceBar } from './pullbacks';
import { addDays } from './time';

/** Weekday-ish daily bars from closes, high/low ±1 around each close. */
function bars(closes: number[], start = '2026-01-05'): PriceBar[] {
  return closes.map((c, i) => ({ date: addDays(start, i), high: c + 1, low: c - 1, close: c }));
}

describe('atr (Wilder, 14)', () => {
  it('is null with too few bars and equals the constant true range when ranges are steady', () => {
    expect(atr(bars(Array(14).fill(100)))).toBeNull();
    expect(atr(bars(Array(30).fill(100)))).toBe(2); // every true range is high − low = 2
  });

  it('counts gaps through the previous close', () => {
    const b = bars(Array(15).fill(100));
    b.push({ date: '2026-02-01', high: 91, low: 89, close: 90 }); // gap down: TR = 100 − 89 = 11
    // Wilder: (2 × 13 + 11) / 14
    expect(atr(b)).toBe(2.6429);
  });
});

describe('priceMetrics', () => {
  it('EOD: last bar is today; 52-week high/low, % below high, 1-day and 5-day change', () => {
    const m = priceMetrics(bars([100, 120, 110, 105, 104, 103, 102, 96]))!;
    expect(m).toMatchObject({
      intraday: false,
      price: 96,
      prevClose: 102,
      high52: 121,
      low52: 95,
      d1Pct: -5.88,
      d5Pct: -12.73, // vs 110, the close 5 sessions before today
    });
    expect(m.belowHighPct).toBe(20.66); // 1 − 96/121
  });

  it('worst drop over 1–5 sessions picks the deepest window', () => {
    const m = priceMetrics(bars([100, 110, 108, 105, 101, 99]))!;
    expect(m).toMatchObject({ worstDropPct: -10, worstDropDays: 4 }); // 110 → 99
  });

  it('intraday: today comes from the live price; it can set a new 52-week low', () => {
    const b = bars([100, 102, 101, 103]); // through 2026-01-08
    const m = priceMetrics(b, { live: { price: 94, date: '2026-01-09' } })!;
    expect(m).toMatchObject({
      intraday: true,
      asOfDate: '2026-01-09',
      prevClose: 103,
      low52: 94,
      low52Date: '2026-01-09',
      d1Pct: -8.74,
    });
    // A partial bar for today in the history is ignored in favour of the live price.
    const withPartial = [...b, { date: '2026-01-09', high: 99, low: 97, close: 98 }];
    expect(priceMetrics(withPartial, { live: { price: 94, date: '2026-01-09' } })!.prevClose).toBe(
      103,
    );
  });

  it('only looks back 52 weeks for the high', () => {
    const old = { date: '2025-01-02', high: 500, low: 490, close: 495 };
    const m = priceMetrics([old, ...bars([100, 101, 99], '2026-03-02')])!;
    expect(m.high52).toBe(102);
  });

  it('needs at least two sessions', () => {
    expect(priceMetrics(bars([100]))).toBeNull();
    expect(priceMetrics([], { live: { price: 10, date: '2026-01-05' } })).toBeNull();
  });
});
