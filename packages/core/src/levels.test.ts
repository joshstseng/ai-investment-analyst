import { describe, expect, it } from 'vitest';
import { levelsToWatch, type LevelInstrumentInput, type LevelRuleInput } from './levels';

const asOfDate = '2026-11-13';
const inst = (
  close: number | null,
  rules: LevelRuleInput[],
  over: Partial<LevelInstrumentInput> = {},
): LevelInstrumentInput => ({
  display: 'ACMX',
  instrumentSymbol: 'ACMX',
  evaluatedSymbol: 'ACMX',
  close,
  rules,
  ...over,
});
const stop = (level: number, warn?: number): LevelRuleInput => ({
  status: 'CONFIRMED',
  ruleType: 'stop_close_below',
  params: warn === undefined ? { level } : { level, warn_close_at_or_below: warn },
});
const view = (xs: ReturnType<typeof levelsToWatch>) =>
  xs.map((l) => [l.kind, l.level, l.distancePct, l.distanceDollars]);

describe('levelsToWatch', () => {
  it.each<[string, number, number[][] | (string | number)[][]]>([
    ['exactly 5% above the stop is included', 100, [['stop', 95, 5, 5]]],
    // A close the stop sits 5.01% below: 95 = close × (1 − 0.0501).
    ['5.01% above the stop is excluded', 95 / (1 - 0.0501), []],
    ['already below the stop is not "to watch" (it is an active condition)', 94, []],
    ['exactly at the stop counts as crossed', 95, []],
  ])('%s', (_name, close, expected) => {
    expect(view(levelsToWatch([inst(close, [stop(95)])], { asOfDate }))).toEqual(expected);
  });

  it('lists the stop and the warning level separately, nearest first, in % and $', () => {
    expect(view(levelsToWatch([inst(100, [stop(96, 98)])], { asOfDate }))).toEqual([
      ['warning', 98, 2, 2],
      ['stop', 96, 4, 4],
    ]);
  });

  it('measures take-profits upward and skips expired ones', () => {
    const tp = (level: number, valid_until?: string): LevelRuleInput => ({
      status: 'DRAFT',
      ruleType: 'take_profit_at_or_above',
      params: { level, basis: 'close', ...(valid_until ? { valid_until } : {}) },
    });
    expect(view(levelsToWatch([inst(200, [tp(204)])], { asOfDate }))).toEqual([
      ['take_profit', 204, 2, 4],
    ]);
    expect(levelsToWatch([inst(200, [tp(204, '2026-11-12')])], { asOfDate })).toEqual([]);
    expect(levelsToWatch([inst(200, [tp(204, '2026-11-13')])], { asOfDate })).toHaveLength(1);
  });

  it('shows only the next untriggered ETF drawdown tier', () => {
    const dd: LevelRuleInput = {
      status: 'PLACEHOLDER',
      ruleType: 'etf_drawdown_from_52w_high',
      params: { tiers: [10, 15, 20] },
    };
    // High 100; close 86 has passed the 10% tier (90); the next is 15% (85), 1.16% away.
    const [l] = levelsToWatch([inst(86, [dd], { high52w: 100 })], { asOfDate });
    expect(l).toMatchObject({
      kind: 'drawdown_tier',
      label: '15% drawdown tier',
      level: 85,
      distancePct: 1.16,
      distanceDollars: 1,
    });
    // Nothing within 5%: close 96, next tier 90 is 6.25% away.
    expect(levelsToWatch([inst(96, [dd], { high52w: 100 })], { asOfDate })).toEqual([]);
    // All tiers passed: nothing left to watch.
    expect(levelsToWatch([inst(79, [dd], { high52w: 100 })], { asOfDate })).toEqual([]);
  });

  it('uses a trailing stop only once it has started (has a trigger level)', () => {
    const trail = (triggerLevel: number | null): LevelRuleInput => ({
      status: 'CONFIRMED',
      ruleType: 'trailing_close_pct_from_high',
      params: { pct: 20, start_date: null },
      triggerLevel,
    });
    expect(levelsToWatch([inst(125, [trail(null)])], { asOfDate })).toEqual([]);
    expect(view(levelsToWatch([inst(125, [trail(120)])], { asOfDate }))).toEqual([
      ['trailing_stop', 120, 4, 5],
    ]);
  });

  it('measures options on the underlying and keeps the option name for display', () => {
    const [l] = levelsToWatch(
      [
        inst(46, [stop(45)], {
          display: 'OPTX Jun-16-2028 $45 call',
          instrumentSymbol: 'OPTX280616C00045000',
          evaluatedSymbol: 'OPTX',
        }),
      ],
      { asOfDate },
    );
    expect(l).toMatchObject({
      display: 'OPTX Jun-16-2028 $45 call',
      evaluatedSymbol: 'OPTX',
      distancePct: 2.17,
    });
  });

  it('skips holdings without a close and rule types that have no level', () => {
    expect(
      levelsToWatch(
        [
          inst(null, [stop(95)]),
          inst(100, [{ status: 'PLACEHOLDER', ruleType: 'new_52w_low', params: {} }]),
        ],
        { asOfDate },
      ),
    ).toEqual([]);
  });
});
