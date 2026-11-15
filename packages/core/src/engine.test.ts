import { describe, expect, it } from 'vitest';
import {
  evaluateRule,
  type DailyBar,
  type EvalContext,
  type Outcome,
  type RuleToEvaluate,
} from './engine';
import { addDays } from './time';

// Thanksgiving week 2026: Nov 26 is a holiday, Nov 27 is an early close (1 PM ET).
const THANKSGIVING_WEEK = ['2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27'];

const bar = (date: string, close: number, high = close, low = close): DailyBar => ({
  date,
  open: close,
  high,
  low,
  close,
});

/** Weekday sessions from `from` to `to` inclusive, skipping `holidays`. */
function weekdays(from: string, to: string, holidays: string[] = []): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6 && !holidays.includes(d)) out.push(d);
  }
  return out;
}

function ctx(over: Partial<EvalContext> = {}): EvalContext {
  return {
    asOfDate: '2026-11-25',
    sessions: THANKSGIVING_WEEK,
    bars: [],
    dataAvailable: true,
    firedBefore: false,
    instrumentSymbol: 'ACMX',
    evaluatedSymbol: 'ACMX',
    ...over,
  };
}

/** Compact view of an outcome for table assertions. */
function summary(o: Outcome): string {
  if (o.kind === 'fired') return `fired:${o.severity}:${o.level}`;
  if (o.kind === 'not_checked') return `not_checked:${o.reason}`;
  return 'not_fired';
}

type Case = [name: string, rule: RuleToEvaluate, context: Partial<EvalContext>, expected: string];
const run = (cases: Case[]) =>
  it.each(cases)('%s', (_name, rule, context, expected) => {
    expect(summary(evaluateRule(rule, ctx(context)))).toBe(expected);
  });

describe('stop_close_below (with warning level)', () => {
  const rule = (warn?: number): RuleToEvaluate => ({
    ruleType: 'stop_close_below',
    params: warn === undefined ? { level: 96.28 } : { level: 96.28, warn_close_at_or_below: 100 },
  });
  const on = (close: number) => ({ bars: [bar('2026-11-25', close)] });
  run([
    ['a cent below the stop → critical', rule(100), on(96.27), 'fired:critical:stop'],
    ['exactly at the stop is not below it → warning', rule(100), on(96.28), 'fired:warn:warning'],
    ['exactly at the warning level → warning', rule(100), on(100), 'fired:warn:warning'],
    ['a cent above the warning level → nothing', rule(100), on(100.01), 'not_fired'],
    ['no warning level, exactly at the stop → nothing', rule(), on(96.28), 'not_fired'],
    [
      'missing bar for the session',
      rule(100),
      { bars: [bar('2026-11-24', 90)] },
      'not_checked:missing_bar',
    ],
    [
      'holiday (Thanksgiving)',
      rule(100),
      { asOfDate: '2026-11-26', bars: [bar('2026-11-26', 90)] },
      'not_checked:not_trading_day',
    ],
    [
      'early-close session evaluates normally',
      rule(100),
      { asOfDate: '2026-11-27', bars: [bar('2026-11-27', 96)] },
      'fired:critical:stop',
    ],
    ['no data source (OTC)', rule(100), { dataAvailable: false }, 'not_checked:no_data_source'],
  ]);
});

describe('take_profit_at_or_above', () => {
  const tp = (basis: 'close' | 'high_or_close', extra: object = {}): RuleToEvaluate => ({
    ruleType: 'take_profit_at_or_above',
    params: { level: 180, basis, ...extra },
  });
  const on = (close: number, high: number) => ({ bars: [bar('2026-11-25', close, high)] });
  run([
    [
      'high exactly at the level (high_or_close)',
      tp('high_or_close'),
      on(175, 180),
      'fired:warn:take_profit',
    ],
    ['close exactly at the level', tp('close'), on(180, 181), 'fired:warn:take_profit'],
    ['intraday high only, basis close → nothing', tp('close'), on(179.99, 185), 'not_fired'],
    ['a cent short on both', tp('high_or_close'), on(179.5, 179.99), 'not_fired'],
    ['missing bar', tp('close'), { bars: [] }, 'not_checked:missing_bar'],
    [
      'early close session',
      tp('close'),
      { asOfDate: '2026-11-27', bars: [bar('2026-11-27', 181)] },
      'fired:warn:take_profit',
    ],
  ]);

  describe('valid_until (OTCX spike rule ends at the half-year results)', () => {
    const spike: RuleToEvaluate = {
      ruleType: 'take_profit_at_or_above',
      params: { level: 14.5, basis: 'high_or_close', valid_until: '2027-03-03' },
    };
    const sessions = ['2027-03-01', '2027-03-02', '2027-03-04'];
    const at = (asOfDate: string, high: number, dataAvailable = true) => ({
      asOfDate,
      sessions,
      dataAvailable,
      bars: [bar(asOfDate, 14.2, high)],
    });
    run([
      [
        'before the end date, spike → fires',
        spike,
        at('2027-03-02', 14.5),
        'fired:warn:take_profit',
      ],
      [
        'after the end date → expired, even on a spike',
        spike,
        at('2027-03-04', 16),
        'not_checked:expired',
      ],
      [
        'expired is reported even without a data source',
        spike,
        at('2027-03-04', 16, false),
        'not_checked:expired',
      ],
      [
        'before the end date, no data source (OTC)',
        spike,
        at('2027-03-02', 16, false),
        'not_checked:no_data_source',
      ],
    ]);
  });
});

describe('trailing_close_pct_from_high (starts after TP2)', () => {
  const trail: RuleToEvaluate = {
    ruleType: 'trailing_close_pct_from_high',
    params: { pct: 20, start_date: null, start_after_rule: 'manual:BKX:take_profit_2' },
  };
  const bars = [
    bar('2026-11-19', 180), // before the start: ignored
    bar('2026-11-20', 135), // TP2 fired today: trail starts
    bar('2026-11-23', 150), // highest close since the start
    bar('2026-11-24', 120.01),
    bar('2026-11-25', 120), // exactly 20% below 150
  ];
  const sessions = ['2026-11-19', ...THANKSGIVING_WEEK];
  run([
    [
      'TP2 has not fired → not started (held back)',
      trail,
      { bars, sessions, triggerFiredOn: null },
      'not_checked:not_started',
    ],
    [
      'exactly 20% below the highest close since TP2',
      trail,
      { bars, sessions, triggerFiredOn: '2026-11-20' },
      'fired:critical:trailing_stop',
    ],
    [
      '19.996% below → nothing',
      trail,
      { bars, sessions, asOfDate: '2026-11-24', triggerFiredOn: '2026-11-20' },
      'not_fired',
    ],
  ]);

  it('uses an explicit start_date when set (includes earlier highs)', () => {
    const o = evaluateRule(
      { ruleType: 'trailing_close_pct_from_high', params: { pct: 20, start_date: '2026-11-19' } },
      ctx({ bars, sessions }),
    );
    expect(summary(o)).toBe('fired:critical:trailing_stop');
    expect(o.observed).toMatchObject({ highestClose: 180, since: '2026-11-19' });
  });

  it('ignores closes before the trigger date', () => {
    const o = evaluateRule(trail, ctx({ bars, sessions, triggerFiredOn: '2026-11-20' }));
    expect(o.observed).toMatchObject({ highestClose: 150, since: '2026-11-20' });
  });
});

describe('day_move_pct', () => {
  const move = (p: number): RuleToEvaluate => ({ ruleType: 'day_move_pct', params: { pct: p } });
  const pair = (prev: number, close: number) => ({
    bars: [bar('2026-11-24', prev), bar('2026-11-25', close)],
  });
  run([
    ['exactly +7%', move(7), pair(100, 107), 'fired:warn:move_up'],
    ['exactly −7%', move(7), pair(100, 93), 'fired:warn:move_down'],
    ['+6.99% → nothing', move(7), pair(100, 106.99), 'not_fired'],
    ['SPCL/JOBX/RCX ±10%: +9.99% → nothing', move(10), pair(100, 109.99), 'not_fired'],
    ['SPCL/JOBX/RCX ±10%: exactly −10%', move(10), pair(100, 90), 'fired:warn:move_down'],
    [
      'previous session bar missing',
      move(7),
      { bars: [bar('2026-11-25', 120)] },
      'not_checked:missing_bar',
    ],
    [
      'after the holiday, compares with the last session (Nov 25), not Nov 26',
      move(7),
      { asOfDate: '2026-11-27', bars: [bar('2026-11-25', 100), bar('2026-11-27', 92.5)] },
      'fired:warn:move_down',
    ],
    [
      'first session in the calendar',
      move(7),
      { asOfDate: '2026-11-20', bars: [bar('2026-11-20', 1)] },
      'not_checked:insufficient_history',
    ],
  ]);
});

describe('52-week window rules', () => {
  const sessions = weekdays('2025-11-17', '2026-11-25', [
    '2025-11-27',
    '2025-12-25',
    '2026-01-01',
    '2026-11-26',
  ]);
  const asOfDate = '2026-11-25';
  const flat = (value: number, last: number, from = sessions) =>
    from.map((d) => bar(d, d === asOfDate ? last : value));

  describe('etf_drawdown_from_52w_high (10/15/20%)', () => {
    const dd: RuleToEvaluate = {
      ruleType: 'etf_drawdown_from_52w_high',
      params: { tiers: [10, 15, 20] },
    };
    run([
      ['9.99% down → nothing', dd, { asOfDate, sessions, bars: flat(100, 90.01) }, 'not_fired'],
      [
        'exactly 10% → tier 10 (warn)',
        dd,
        { asOfDate, sessions, bars: flat(100, 90) },
        'fired:warn:drawdown_10',
      ],
      [
        'exactly 15% → tier 15 (warn)',
        dd,
        { asOfDate, sessions, bars: flat(100, 85) },
        'fired:warn:drawdown_15',
      ],
      [
        'exactly 20% → tier 20 (critical)',
        dd,
        { asOfDate, sessions, bars: flat(100, 80) },
        'fired:critical:drawdown_20',
      ],
      [
        '30% → still the top tier',
        dd,
        { asOfDate, sessions, bars: flat(100, 70) },
        'fired:critical:drawdown_20',
      ],
      [
        'too little history',
        dd,
        { asOfDate, sessions, bars: flat(100, 80, sessions.slice(-10)) },
        'not_checked:insufficient_history',
      ],
      [
        'missing bar today',
        dd,
        { asOfDate, sessions, bars: flat(100, 80).slice(0, -1) },
        'not_checked:missing_bar',
      ],
    ]);

    it('ignores highs older than 52 weeks', () => {
      const bars = [bar('2025-11-10', 500), ...flat(100, 90)];
      const o = evaluateRule(dd, ctx({ asOfDate, sessions, bars }));
      expect(o.observed).toMatchObject({ high: 100, window: '52-week' });
    });
  });

  describe('new_52w_low (computed from bars, not hard-coded)', () => {
    const low: RuleToEvaluate = { ruleType: 'new_52w_low', params: {} };
    const withPriorLow = (last: number) =>
      sessions.map((d, i) => bar(d, d === asOfDate ? last : i === 100 ? 50 : 100));
    run([
      [
        'exactly at the prior closing low → not new',
        low,
        { asOfDate, sessions, bars: withPriorLow(50) },
        'not_fired',
      ],
      [
        'a cent below the prior closing low → new low',
        low,
        { asOfDate, sessions, bars: withPriorLow(49.99) },
        'fired:warn:new_low',
      ],
      [
        'missing bar',
        low,
        { asOfDate, sessions, bars: withPriorLow(40).slice(0, -1) },
        'not_checked:missing_bar',
      ],
      [
        'fewer than 20 prior bars',
        low,
        { asOfDate, sessions, bars: flat(100, 10, sessions.slice(-15)) },
        'not_checked:insufficient_history',
      ],
    ]);

    it('labels a short history "since <first bar>" instead of 52-week (NEWX listed in June)', () => {
      const listed = sessions.filter((d) => d >= '2026-06-15');
      const o = evaluateRule(
        low,
        ctx({
          asOfDate,
          sessions,
          bars: flat(100, 99, listed),
          instrumentSymbol: 'NEWX',
          evaluatedSymbol: 'NEWX',
        }),
      );
      expect(summary(o)).toBe('fired:warn:new_low');
      expect(o.observed).toMatchObject({ window: 'since 2026-06-15' });
      expect(o.message).toContain('new since 2026-06-15 closing low');
    });

    it('treats a full year of bars as 52-week', () => {
      const o = evaluateRule(low, ctx({ asOfDate, sessions, bars: withPriorLow(49) }));
      expect(o.observed).toMatchObject({ window: '52-week' });
    });
  });
});

describe('close_below_cost', () => {
  const cost = (first: boolean): RuleToEvaluate => ({
    ruleType: 'close_below_cost',
    params: { cost: 212.52, first_crossing_only: first, lot: 'Individual (taxable) lot 1' },
  });
  const pair = (prev: number, close: number) => ({
    bars: [bar('2026-11-24', prev), bar('2026-11-25', close)],
  });
  run([
    ['exactly at cost → not below', cost(true), pair(220, 212.52), 'not_fired'],
    ['a cent below cost → fires', cost(true), pair(220, 212.51), 'fired:warn:below_cost'],
    [
      'already below on first evaluation → fires once',
      cost(true),
      pair(210, 209),
      'fired:warn:below_cost',
    ],
    [
      'first crossing already alerted → not again',
      cost(true),
      { ...pair(220, 200), firedBefore: true },
      'not_fired',
    ],
    ['every crossing mode: still below → nothing', cost(false), pair(210, 209), 'not_fired'],
    [
      'every crossing mode: new crossing → fires',
      cost(false),
      { ...pair(220, 200), firedBefore: true },
      'fired:warn:below_cost',
    ],
    ['missing bar', cost(true), { bars: [] }, 'not_checked:missing_bar'],
  ]);
});

describe('date_reminder (no price data needed)', () => {
  const remind: RuleToEvaluate = { ruleType: 'date_reminder', params: { on: '2026-12-10' } };
  run([
    ['day before → nothing', remind, { asOfDate: '2026-12-09' }, 'not_fired'],
    ['on the date → fires', remind, { asOfDate: '2026-12-10' }, 'fired:warn:reminder'],
    [
      'missed the date (weekend/holiday) → fires on the next check',
      remind,
      { asOfDate: '2026-12-11' },
      'fired:warn:reminder',
    ],
    [
      'already sent → not again',
      remind,
      { asOfDate: '2026-12-11', firedBefore: true },
      'not_fired',
    ],
    [
      'works for OTCX with no data source',
      remind,
      { asOfDate: '2026-12-10', dataAvailable: false },
      'fired:warn:reminder',
    ],
  ]);
});

describe('time_stop', () => {
  const ts: RuleToEvaluate = {
    ruleType: 'time_stop',
    params: { review_on: '2027-03-01', below_price: 61.03 },
  };
  const on = (asOfDate: string, close: number) => ({
    asOfDate,
    sessions: [asOfDate],
    bars: [bar(asOfDate, close)],
  });
  run([
    ['before the review date → nothing', ts, on('2027-02-24', 100), 'not_fired'],
    ['on the date, below entry → fires', ts, on('2027-03-01', 61.02), 'fired:warn:time_stop'],
    ['on the date, exactly at entry → nothing', ts, on('2027-03-01', 61.03), 'not_fired'],
  ]);
});

describe('options and judgment rules', () => {
  it('evaluates option rules on the underlying and says so', () => {
    const o = evaluateRule(
      { ruleType: 'stop_close_below', params: { level: 45 } },
      ctx({
        instrumentSymbol: 'OPTX280616C00045000',
        evaluatedSymbol: 'OPTX',
        bars: [bar('2026-11-25', 44.99)],
      }),
    );
    expect(summary(o)).toBe('fired:critical:stop');
    expect(o.message).toBe(
      'OPTX (underlying of OPTX280616C00045000) closed at $44.99, below the $45.00 stop',
    );
  });

  it('never evaluates an option-value rule (no option prices) and marks it an estimate', () => {
    const o = evaluateRule(
      { ruleType: 'option_value_below', params: { level: 11, estimate: true } },
      ctx(),
    );
    expect(summary(o)).toBe('not_checked:no_data_source');
    expect(o.observed).toMatchObject({ estimate: true });
  });

  it('stores judgment rules but never evaluates them', () => {
    expect(summary(evaluateRule({ ruleType: null, params: {} }, ctx()))).toBe(
      'not_checked:judgment_only',
    );
  });

  it('rejects malformed params instead of guessing', () => {
    expect(() =>
      evaluateRule(
        { ruleType: 'stop_close_below', params: { level: 'low' } },
        ctx({ bars: [bar('2026-11-25', 1)] }),
      ),
    ).toThrow();
  });
});
