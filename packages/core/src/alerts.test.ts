import { describe, expect, it } from 'vitest';
import { decideAlert, ruleAlertTag, type AlertState } from './alerts';
import { evaluateRule, type DailyBar, type EvalContext, type Outcome } from './engine';

const D = '2026-11-25';
const fired = (
  level: string,
  price: number,
  rank = 1,
  direction: 'up' | 'down' = 'down',
  severity: 'warn' | 'critical' = 'warn',
): Outcome => ({
  kind: 'fired',
  severity,
  level,
  message: 'm',
  observed: {},
  track: { kind: 'state', rank, direction, price },
});
const notFired: Outcome = { kind: 'not_fired', message: 'm', observed: {} };
const notChecked: Outcome = {
  kind: 'not_checked',
  reason: 'missing_bar',
  message: 'm',
  observed: {},
};
const active = (over: Partial<AlertState> = {}): AlertState => ({
  active: true,
  rank: 1,
  price: 100,
  level: 'warning',
  firstFiredOn: '2026-11-20',
  lastAlertedOn: '2026-11-20',
  ...over,
});

describe('decideAlert', () => {
  it.each<[string, AlertState | null, Outcome, boolean, string]>([
    ['first fire', null, fired('warning', 150), true, 'first'],
    ['fires again after a reset', active({ active: false }), fired('warning', 150), true, 'first'],
    [
      'still active, same level, small move',
      active(),
      fired('warning', 98.5),
      false,
      'still_active',
    ],
    [
      'warning → breach',
      active(),
      fired('stop', 99, 2, 'down', 'critical'),
      true,
      'escalation_level',
    ],
    [
      'new drawdown tier (10% → 15%)',
      active({ level: 'drawdown_10' }),
      fired('drawdown_15', 99, 2),
      true,
      'escalation_level',
    ],
    ['exactly 2% further down', active(), fired('warning', 98), true, 'escalation_move'],
    ['1.99% further down', active(), fired('warning', 98.01), false, 'still_active'],
    [
      'moving back the good way does not alert',
      active(),
      fired('warning', 103),
      false,
      'still_active',
    ],
    [
      'take-profit: 2% further up',
      active({ level: 'take_profit' }),
      fired('take_profit', 102, 1, 'up'),
      true,
      'escalation_move',
    ],
    [
      'take-profit: falling back is not escalation',
      active({ level: 'take_profit' }),
      fired('take_profit', 97, 1, 'up'),
      false,
      'still_active',
    ],
    ['condition clears → reset', active(), notFired, false, 'cleared'],
    ['not fired and not active → nothing', null, notFired, false, 'no_change'],
    ['missing data keeps the state', active(), notChecked, false, 'no_change'],
  ])('%s', (_name, prev, outcome, send, reason) => {
    const d = decideAlert(prev, outcome, D);
    expect([d.send, d.reason]).toEqual([send, reason]);
  });

  it('records the first fire and the price used for later moves', () => {
    expect(decideAlert(null, fired('warning', 150), D).next).toEqual({
      active: true,
      rank: 1,
      price: 150,
      level: 'warning',
      firstFiredOn: D,
      lastAlertedOn: D,
    });
  });

  it('measures further moves from the last alert, not from yesterday', () => {
    // Alerted at 100; drifts 99 → 98.5 → 98.2 (each < 2% from the day before) → no alert.
    let state: AlertState | null = active();
    for (const p of [99, 98.5, 98.2]) {
      const d = decideAlert(state, fired('warning', p), D);
      expect(d.send).toBe(false);
      state = d.next;
    }
    expect(state!.price).toBe(100);
    expect(decideAlert(state, fired('warning', 97.9), D).send).toBe(true);
  });

  it('re-alerts a renewed breach after dropping back to warning', () => {
    const breached = active({ rank: 2, level: 'stop', price: 145 });
    const back = decideAlert(breached, fired('warning', 148), D);
    expect([back.send, back.next!.rank]).toEqual([false, 1]);
    expect(decideAlert(back.next, fired('stop', 146, 2), D).reason).toBe('escalation_level');
  });

  it('alerts on every event (day moves, reminders) and keeps no state', () => {
    const ev: Outcome = {
      kind: 'fired',
      severity: 'warn',
      level: 'move_down',
      message: 'm',
      observed: {},
      track: { kind: 'event' },
    };
    expect(decideAlert(null, ev, D)).toMatchObject({ send: true, reason: 'event', next: null });
    expect(decideAlert(null, ev, '2026-11-27').send).toBe(true);
  });

  it('gets tracking info from the engine (stop rank 2, warning rank 1, TP up on the high)', () => {
    const ctx = (bar: DailyBar): EvalContext => ({
      asOfDate: D,
      sessions: [D],
      bars: [bar],
      dataAvailable: true,
      firedBefore: false,
      instrumentSymbol: 'X',
      evaluatedSymbol: 'X',
    });
    const b = (close: number, high = close) => ({ date: D, open: close, high, low: close, close });
    const stop = {
      ruleType: 'stop_close_below' as const,
      params: { level: 100, warn_close_at_or_below: 105 },
    };
    const tp = {
      ruleType: 'take_profit_at_or_above' as const,
      params: { level: 200, basis: 'high_or_close' },
    };
    const track = (o: Outcome) => (o.kind === 'fired' ? o.track : null);
    expect(track(evaluateRule(stop, ctx(b(99))))).toEqual({
      kind: 'state',
      rank: 2,
      direction: 'down',
      price: 99,
    });
    expect(track(evaluateRule(stop, ctx(b(104))))).toEqual({
      kind: 'state',
      rank: 1,
      direction: 'down',
      price: 104,
    });
    expect(track(evaluateRule(tp, ctx(b(195, 201))))).toEqual({
      kind: 'state',
      rank: 1,
      direction: 'up',
      price: 201,
    });
  });
});

describe('ruleAlertTag', () => {
  const o = (level: string, severity: 'warn' | 'critical' = 'warn') =>
    fired(level, 1, 1, 'down', severity) as Extract<Outcome, { kind: 'fired' }>;
  it.each<[string, Parameters<typeof ruleAlertTag>, string]>([
    ['CONFIRMED stop breach', ['CONFIRMED', 'stop_close_below', o('stop', 'critical')], 'ACTION'],
    ['CONFIRMED warning level', ['CONFIRMED', 'stop_close_below', o('warning')], 'WARNING'],
    ['CONFIRMED take-profit', ['CONFIRMED', 'take_profit_at_or_above', o('take_profit')], 'ACTION'],
    [
      'CONFIRMED trailing stop',
      ['CONFIRMED', 'trailing_close_pct_from_high', o('trailing_stop', 'critical')],
      'ACTION',
    ],
    ['DRAFT stop breach', ['DRAFT', 'stop_close_below', o('stop', 'critical')], 'REVIEW'],
    [
      'PLACEHOLDER drawdown',
      ['PLACEHOLDER', 'etf_drawdown_from_52w_high', o('drawdown_10')],
      'REVIEW',
    ],
    ['date reminder', ['CONFIRMED', 'date_reminder', o('reminder')], 'REMINDER'],
  ])('%s → %s', (_name, args, expected) => {
    expect(ruleAlertTag(...args)).toBe(expected);
  });
});
