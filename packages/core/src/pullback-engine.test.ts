import { describe, expect, it } from 'vitest';
import {
  decidePullback,
  exitLevels,
  qualify,
  type PullbackCheck,
  type PullbackRules,
  type PullbackState,
} from './pullback-engine';
import { priceMetrics, type PriceMetrics } from './pullbacks';

const rules: PullbackRules = {
  qualify: { fromHighPct: 20, multiDayDropPct: 10, oneDayDropPct: 7 },
  tiers: [20, 25, 30, 35],
  gapDownPct: 5,
  resetAboveFromHighPct: 15,
};

/** Metrics with just the fields the engine reads. */
const m = (belowHighPct: number, d1Pct = 0, worstDropPct = d1Pct): PriceMetrics => ({
  asOfDate: '2026-11-17',
  price: 100 * (1 - belowHighPct / 100),
  intraday: false,
  prevClose: 100,
  high52: 100,
  high52Date: '2026-01-02',
  low52: 50,
  low52Date: '2026-03-02',
  belowHighPct,
  d1Pct,
  d5Pct: null,
  worstDropPct,
  worstDropDays: 1,
  atr14: 2,
});

/** Runs a sequence of checks, carrying state; returns each step's decision. */
function run(
  steps: [string, PullbackCheck, PriceMetrics, string?][],
  start: PullbackState | null = null,
) {
  let state = start;
  return steps.map(([date, check, metrics, time]) => {
    const d = decidePullback(state, metrics, {
      check,
      date,
      now: new Date(
        `${date}T${time ?? (check === 'open' ? '14:40' : check === 'midday' ? '17:30' : '21:20')}:00Z`,
      ),
      rules,
    });
    state = d.next;
    return d;
  });
}

describe('qualify', () => {
  it.each<[string, PriceMetrics, string[], number | null]>([
    ['20% below the high', m(20), ['from_high'], 20],
    ['27% below: tier 25', m(27), ['from_high'], 25],
    ['40% below: deepest tier 35', m(40), ['from_high'], 35],
    ['down 10% over a few days', m(12, -3, -10), ['multi_day'], null],
    ['down 7% on the day', m(9, -7), ['one_day'], null],
    ['19.9% below and calm: no', m(19.9, -1, -4), [], null],
  ])('%s', (_name, metrics, reasons, tier) => {
    const q = qualify(metrics, rules, 'eod');
    expect(q.reasons).toEqual(reasons);
    expect(q.tier).toBe(tier);
  });

  it('flags a gap-down only at the open, at ≥ 5% below the previous close', () => {
    expect(qualify(m(22, -5.2), rules, 'open').gapDown).toBe(true);
    expect(qualify(m(22, -4.9), rules, 'open').gapDown).toBe(false);
    expect(qualify(m(22, -5.2), rules, 'midday').gapDown).toBe(false);
  });
});

describe('decidePullback: tiers and no repeats', () => {
  it('first qualifies, then only deeper tiers; the same tier never repeats', () => {
    const d = run([
      ['2026-11-16', 'eod', m(21)], // first (tier 20)
      ['2026-11-17', 'open', m(22)], // still 20: nothing
      ['2026-11-17', 'midday', m(26)], // deeper: 25
      ['2026-11-17', 'eod', m(26.5)], // still 25: nothing
      ['2026-11-18', 'midday', m(24)], // back up to 20: nothing (no repeat)
      ['2026-11-19', 'eod', m(26)], // 25 again: already alerted, nothing
      ['2026-11-20', 'eod', m(36)], // jumps two tiers: one alert for 35
    ]);
    expect(d.map((x) => x.alert?.kinds ?? null)).toEqual([
      ['first'],
      null,
      ['deeper_tier'],
      null,
      null,
      null,
      ['deeper_tier'],
    ]);
    expect(d[6]!.alert!.tier).toBe(35);
    expect(d[6]!.next).toMatchObject({ lastAlertedTier: 35, qualifiedSince: '2026-11-16' });
  });

  it('qualifying on a multi-day drop first, then reaching a tier, is a deeper-tier alert', () => {
    const d = run([
      ['2026-11-16', 'eod', m(12, -2, -11)],
      ['2026-11-17', 'eod', m(21)],
    ]);
    expect(d.map((x) => x.alert?.kinds)).toEqual([['first'], ['deeper_tier']]);
  });
});

describe('decidePullback: one-day drops', () => {
  it('at most one one-day-drop alert per ticker per day across all three checks', () => {
    const d = run(
      [
        ['2026-11-17', 'open', m(23, -8)],
        ['2026-11-17', 'midday', m(24, -9)],
        ['2026-11-17', 'eod', m(24, -9.5)],
        ['2026-11-18', 'open', m(30, -8)], // a new day: allowed again (and a deeper tier)
      ],
      { ...emptyQualified('2026-11-10', 20) },
    );
    expect(d.map((x) => x.alert?.kinds ?? null)).toEqual([
      ['one_day_drop'],
      null,
      null,
      ['deeper_tier', 'one_day_drop'],
    ]);
  });

  it('a first alert caused by a one-day drop also uses up that day’s one-day-drop alert', () => {
    const d = run([
      ['2026-11-17', 'open', m(8, -8)],
      ['2026-11-17', 'eod', m(9, -9)],
    ]);
    expect(d.map((x) => x.alert?.kinds ?? null)).toEqual([['first', 'one_day_drop'], null]);
  });

  it('skips the one-day-drop alert when a rule already alerted the ticker today', () => {
    const d = decidePullback(emptyQualified('2026-11-10', 20), m(23, -8), {
      check: 'eod',
      date: '2026-11-17',
      now: new Date('2026-11-17T21:20:00Z'),
      rules,
      suppressOneDayDrop: true,
    });
    expect(d.alert).toBeNull();
    expect(d.next.alertedOneDayDropDate).toBe('2026-11-17');
  });
});

describe('decidePullback: reversals and reset', () => {
  it('an intraday tier alert reversed by the close is reported; state is kept', () => {
    const d = run(
      [
        ['2026-11-17', 'midday', m(26)], // deeper: 25
        ['2026-11-17', 'eod', m(23)], // closes back in tier 20
      ],
      emptyQualified('2026-11-10', 20),
    );
    expect(d[1]!.reversed).toEqual({ tier: 25, check: 'midday' });
    expect(d[1]!.reset).toBe(false);
    expect(d[1]!.next.lastAlertedTier).toBe(25);
  });

  it('does not reset until an EOD close is less than 15% below the high', () => {
    const d = run(
      [
        ['2026-11-17', 'midday', m(12)], // intraday above −15%: never resets
        ['2026-11-17', 'eod', m(16)], // close at −16%: not yet
        ['2026-11-18', 'eod', m(14.9)], // close above −15%: reset
        ['2026-11-19', 'eod', m(21)], // qualifies again: a new first alert
      ],
      emptyQualified('2026-11-10', 25),
    );
    expect(d.map((x) => x.reset)).toEqual([false, false, true, false]);
    expect(d[2]!.next.qualifiedSince).toBeNull();
    expect(d[3]!.alert!.kinds).toEqual(['first']);
  });

  it('a close above −15% that still qualifies on a drop does not reset', () => {
    const d = run([['2026-11-18', 'eod', m(14, -2, -10.5)]], emptyQualified('2026-11-10', 20));
    expect(d[0]!.reset).toBe(false);
  });
});

describe('gap-down at the open', () => {
  it('labels the alert; a 5–7% gap alone does not trigger one', () => {
    const [a] = run([['2026-11-17', 'open', m(26, -6)]], emptyQualified('2026-11-10', 20));
    expect(a!.alert).toEqual({ kinds: ['deeper_tier'], tier: 25, gapDown: true });
    const [b] = run([['2026-11-17', 'open', m(22, -6)]], emptyQualified('2026-11-10', 20));
    expect(b!.alert).toBeNull();
    expect(b!.q.gapDown).toBe(true);
  });

  it('measures the open check against the previous close', () => {
    const bars = [
      { date: '2026-11-13', high: 101, low: 99, close: 100 },
      { date: '2026-11-16', high: 101, low: 97, close: 98 },
    ];
    const live = priceMetrics(bars, { live: { price: 92, date: '2026-11-17' } })!;
    expect(live.d1Pct).toBe(-6.12); // 92 vs 98
    expect(qualify(live, rules, 'open').gapDown).toBe(true);
  });
});

describe('exitLevels', () => {
  it('risk stop = max(52-week low, price − 2×ATR14)', () => {
    expect(
      exitLevels({
        price: 100,
        low52: 80,
        atr14: 4,
        epsTtm: null,
        peMedian: null,
        nextEarnings: null,
      }).riskStop,
    ).toEqual({
      value: 92,
      basis: 'price − 2×ATR14 (ATR14 $4.00; higher than the 52-week low $80.00)',
    });
    expect(
      exitLevels({
        price: 100,
        low52: 95,
        atr14: 4,
        epsTtm: null,
        peMedian: null,
        nextEarnings: null,
      }).riskStop.value,
    ).toBe(95);
  });

  it('valuation trim = median P/E × TTM EPS; re-underwrite = next earnings', () => {
    const e = exitLevels({
      price: 100,
      low52: 80,
      atr14: 4,
      epsTtm: 5,
      peMedian: 27,
      nextEarnings: '2027-01-28',
    });
    expect(e.valuationTrim).toEqual({
      value: 135,
      basis: 'P/E back to its own median 27.0 × TTM EPS $5.00',
    });
    expect(e.reUnderwrite).toEqual({ date: '2027-01-28', basis: 'next earnings report' });
    expect(
      exitLevels({ price: 100, low52: 80, atr14: 4, epsTtm: -1, peMedian: 27, nextEarnings: null })
        .valuationTrim,
    ).toBeNull();
  });
});

describe('priceMetrics after a spin-off', () => {
  it('starts the 52-week window at the ex-date', () => {
    const bars = [
      { date: '2026-03-02', high: 400, low: 390, close: 395 }, // before the spin
      { date: '2026-07-01', high: 210, low: 200, close: 205 },
      { date: '2026-11-16', high: 190, low: 185, close: 188 },
    ];
    expect(priceMetrics(bars)!.belowHighPct).toBe(53);
    expect(priceMetrics(bars, { windowStart: '2026-06-29' })!.belowHighPct).toBe(10.48);
  });
});

function emptyQualified(since: string, tier: number): PullbackState {
  return {
    currentTier: tier,
    lastAlertedTier: tier,
    lastAlertedAt: `${since}T21:20:00Z`,
    lastAlertedCheck: 'eod',
    qualifiedSince: since,
    alertedOneDayDropDate: null,
  };
}
