/**
 * Rules engine: pure functions, no I/O. Code decides whether a rule fired; nothing else does.
 *
 * Conventions
 * - Rules are evaluated on a closing basis for `asOfDate`, a completed trading session.
 * - Options are evaluated on their underlying's bars (`evaluatedSymbol`), and messages say so.
 * - "At or below / at or above" comparisons use a tiny relative tolerance so a close of exactly
 *   the level counts as at the level despite floating point.
 * - Missing data is never guessed: the rule is "not checked" with a reason instead.
 *
 * Severity: critical = exit-level event (stop broken, trailing stop hit, 20% ETF drawdown);
 * warn = everything else that fires (emailed). Nothing fires below warn in Step 1.
 */
import { addDays } from './time';
import { parseRuleParams, type RuleType } from './rules';

export interface DailyBar {
  /** Trading date, YYYY-MM-DD (America/New_York). */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type Severity = 'warn' | 'critical';

export type NotCheckedReason =
  | 'judgment_only'
  | 'no_data_source'
  | 'missing_bar'
  | 'not_trading_day'
  | 'insufficient_history'
  | 'not_started'
  | 'expired';

export type Observed = Record<string, unknown>;

/**
 * How the alert policy tracks a fired rule: "event" rules (day moves, reminders) are separate
 * events every time; "state" rules have an ongoing condition with a rank (warning < breach,
 * drawdown tiers), a direction that is worse, and the price to measure further moves from.
 */
export type Track =
  { kind: 'event' } | { kind: 'state'; rank: number; direction: 'up' | 'down'; price: number };

export type Outcome =
  | {
      kind: 'fired';
      severity: Severity;
      level: string;
      message: string;
      observed: Observed;
      track: Track;
    }
  | { kind: 'not_fired'; message: string; observed: Observed }
  | { kind: 'not_checked'; reason: NotCheckedReason; message: string; observed: Observed };

export interface EvalContext {
  asOfDate: string;
  /** Trading sessions (ascending) covering at least the 52-week window before asOfDate. */
  sessions: readonly string[];
  /** Daily bars for evaluatedSymbol, ascending by date. */
  bars: readonly DailyBar[];
  /** False when the symbol has no data source (e.g. OTC on Alpaca's free plan). */
  dataAvailable: boolean;
  /** This rule fired on an earlier date (for once-only rules). */
  firedBefore: boolean;
  /** For trailing rules with start_after_rule: first date the trigger rule fired, if ever. */
  triggerFiredOn?: string | null;
  instrumentSymbol: string;
  /** Symbol whose prices are checked: the instrument itself, or the option's underlying. */
  evaluatedSymbol: string;
}

export interface RuleToEvaluate {
  ruleType: RuleType | null;
  params: unknown;
}

const WINDOW_DAYS = 365;
const MIN_WINDOW_BARS = 20;
/** Bars missing from the start of the 52-week window beyond this → "since <first date>". */
const PARTIAL_HISTORY_SLACK = 5;

const EPS = 1e-9;
const tol = (x: number) => EPS * Math.max(1, Math.abs(x));
export const atOrBelow = (a: number, b: number) => a <= b + tol(b);
export const atOrAbove = (a: number, b: number) => a >= b - tol(b);
const below = (a: number, b: number) => a < b - tol(b);

const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const pct = (n: number) => `${n.toFixed(1)}%`;

export function evaluateRule(rule: RuleToEvaluate, ctx: EvalContext): Outcome {
  return withTrack(rule.ruleType, evaluateUntracked(rule, ctx));
}

/** Attaches alert-tracking info to fired outcomes (see Track). */
function withTrack(type: RuleType | null, o: Outcome): Outcome {
  if (o.kind !== 'fired' || type === null) return o;
  if (type === 'day_move_pct' || type === 'date_reminder')
    return { ...o, track: { kind: 'event' } };
  const obs = o.observed as {
    close?: number;
    high?: number;
    basis?: string;
    tiers?: number[];
    tier?: number;
  };
  let rank = 1;
  if (o.level === 'stop') rank = 2;
  if (type === 'etf_drawdown_from_52w_high' && obs.tiers && obs.tier !== undefined) {
    rank = obs.tiers.indexOf(obs.tier) + 1;
  }
  const up = type === 'take_profit_at_or_above';
  const price = up && obs.basis === 'high_or_close' ? (obs.high ?? obs.close!) : obs.close!;
  return { ...o, track: { kind: 'state', rank, direction: up ? 'up' : 'down', price } };
}

function evaluateUntracked(rule: RuleToEvaluate, ctx: EvalContext): Outcome {
  const subject =
    ctx.evaluatedSymbol === ctx.instrumentSymbol
      ? ctx.evaluatedSymbol
      : `${ctx.evaluatedSymbol} (underlying of ${ctx.instrumentSymbol})`;
  const base: Observed = { asOfDate: ctx.asOfDate, evaluatedSymbol: ctx.evaluatedSymbol };
  const notChecked = (
    reason: NotCheckedReason,
    message: string,
    extra: Observed = {},
  ): Outcome => ({
    kind: 'not_checked',
    reason,
    message,
    observed: { ...base, ...extra },
  });
  const notFired = (message: string, extra: Observed = {}): Outcome => ({
    kind: 'not_fired',
    message,
    observed: { ...base, ...extra },
  });
  const fired = (
    severity: Severity,
    level: string,
    message: string,
    extra: Observed = {},
  ): Outcome => ({
    kind: 'fired',
    severity,
    level,
    message,
    observed: { ...base, ...extra },
    track: { kind: 'event' }, // replaced by withTrack()
  });

  if (rule.ruleType === null) {
    return notChecked('judgment_only', 'judgment rule: stored, not evaluated in code');
  }
  const type = rule.ruleType;

  // --- Rules that don't need price data (or are decided before looking at it) ----------------
  if (type === 'date_reminder') {
    const p = parseRuleParams(type, rule.params);
    if (ctx.asOfDate < p.on) return notFired(`reminder due ${p.on}`, { on: p.on });
    if (ctx.firedBefore) return notFired(`reminder for ${p.on} already sent`, { on: p.on });
    return fired('warn', 'reminder', `Reminder for ${ctx.instrumentSymbol} (due ${p.on})`, {
      on: p.on,
    });
  }
  if (type === 'option_value_below') {
    const p = parseRuleParams(type, rule.params);
    return notChecked(
      'no_data_source',
      `not checked: no data source (estimated value of ${ctx.instrumentSymbol} vs ${money(p.level)}; option prices are not collected)`,
      { level: p.level, estimate: true },
    );
  }
  if (type === 'take_profit_at_or_above') {
    const p = parseRuleParams(type, rule.params);
    if (p.valid_until && ctx.asOfDate > p.valid_until) {
      return notChecked('expired', `rule ended ${p.valid_until}`, { validUntil: p.valid_until });
    }
  }
  if (type === 'time_stop') {
    const p = parseRuleParams(type, rule.params);
    if (ctx.asOfDate < p.review_on) return notFired(`time stop review on ${p.review_on}`);
  }
  let trailingStart: string | null = null;
  if (type === 'trailing_close_pct_from_high') {
    const p = parseRuleParams(type, rule.params);
    trailingStart = p.start_date ?? ctx.triggerFiredOn ?? null;
    if (!trailingStart) {
      return notChecked(
        'not_started',
        p.start_after_rule
          ? `trailing stop starts after ${p.start_after_rule} fires`
          : 'trailing stop has no start date',
      );
    }
  }

  // --- Price data checks ------------------------------------------------------------------------
  if (!ctx.dataAvailable) {
    return notChecked('no_data_source', `not checked: no data source for ${subject}`);
  }
  const sessionIdx = ctx.sessions.indexOf(ctx.asOfDate);
  if (sessionIdx < 0) {
    return notChecked('not_trading_day', `${ctx.asOfDate} is not a trading day`);
  }
  const barsByDate = new Map(ctx.bars.map((b) => [b.date, b]));
  const bar = barsByDate.get(ctx.asOfDate);
  if (!bar) {
    return notChecked('missing_bar', `no daily bar for ${subject} on ${ctx.asOfDate}`);
  }
  const close = bar.close;
  const prices = { close, high: bar.high, low: bar.low };

  switch (type) {
    case 'stop_close_below': {
      const p = parseRuleParams(type, rule.params);
      const extra = { ...prices, level: p.level, warnLevel: p.warn_close_at_or_below ?? null };
      if (below(close, p.level)) {
        return fired(
          'critical',
          'stop',
          `${subject} closed at ${money(close)}, below the ${money(p.level)} stop`,
          extra,
        );
      }
      if (p.warn_close_at_or_below !== undefined && atOrBelow(close, p.warn_close_at_or_below)) {
        return fired(
          'warn',
          'warning',
          `${subject} closed at ${money(close)}, at or below the ${money(p.warn_close_at_or_below)} warning level (stop ${money(p.level)})`,
          extra,
        );
      }
      return notFired(`close ${money(close)} above stop ${money(p.level)}`, extra);
    }

    case 'take_profit_at_or_above': {
      const p = parseRuleParams(type, rule.params);
      const extra = {
        ...prices,
        level: p.level,
        basis: p.basis,
        validUntil: p.valid_until ?? null,
      };
      const hit =
        atOrAbove(close, p.level) || (p.basis === 'high_or_close' && atOrAbove(bar.high, p.level));
      if (!hit) return notFired(`below take-profit ${money(p.level)}`, extra);
      const via = atOrAbove(close, p.level)
        ? `closed at ${money(close)}`
        : `traded up to ${money(bar.high)}`;
      const range = p.range_high ? ` (sell range ${money(p.level)}–${money(p.range_high)})` : '';
      return fired(
        'warn',
        'take_profit',
        `${subject} ${via}, at or above the ${money(p.level)} take-profit${range}`,
        extra,
      );
    }

    case 'trailing_close_pct_from_high': {
      const p = parseRuleParams(type, rule.params);
      const since = ctx.bars.filter((b) => b.date >= trailingStart! && b.date <= ctx.asOfDate);
      const highest = Math.max(...since.map((b) => b.close));
      const trigger = highest * (1 - p.pct / 100);
      const drop = ((highest - close) / highest) * 100;
      const extra = {
        close,
        highestClose: highest,
        since: trailingStart,
        pct: p.pct,
        triggerLevel: trigger,
      };
      if (atOrBelow(close, trigger)) {
        return fired(
          'critical',
          'trailing_stop',
          `${subject} closed at ${money(close)}, ${pct(drop)} below its highest close ${money(highest)} since ${trailingStart} (trail ${p.pct}%)`,
          extra,
        );
      }
      return notFired(`${pct(drop)} below highest close since ${trailingStart}`, extra);
    }

    case 'day_move_pct': {
      const p = parseRuleParams(type, rule.params);
      if (sessionIdx === 0)
        return notChecked('insufficient_history', 'no previous session in calendar');
      const prevDate = ctx.sessions[sessionIdx - 1]!;
      const prev = barsByDate.get(prevDate);
      if (!prev) {
        return notChecked(
          'missing_bar',
          `no daily bar for ${subject} on the previous session ${prevDate}`,
        );
      }
      const move = ((close - prev.close) / prev.close) * 100;
      const extra = { close, prevClose: prev.close, prevDate, movePct: move, threshold: p.pct };
      if (atOrAbove(Math.abs(move), p.pct)) {
        const dir = move > 0 ? 'up' : 'down';
        return fired(
          'warn',
          dir === 'up' ? 'move_up' : 'move_down',
          `${subject} closed ${dir} ${pct(Math.abs(move))} on the day (${money(prev.close)} → ${money(close)}; threshold ±${p.pct}%)`,
          extra,
        );
      }
      return notFired(`day move ${pct(move)} within ±${p.pct}%`, extra);
    }

    case 'etf_drawdown_from_52w_high': {
      const p = parseRuleParams(type, rule.params);
      const w = window52w(ctx);
      if (w.bars.length < MIN_WINDOW_BARS) {
        return notChecked(
          'insufficient_history',
          `only ${w.bars.length} bars in the 52-week window`,
        );
      }
      const high = Math.max(...w.bars.map((b) => b.high));
      const dd = ((high - close) / high) * 100;
      const tier = [...p.tiers].reverse().find((t) => atOrAbove(dd, t));
      const extra = {
        close,
        high,
        drawdownPct: dd,
        tiers: p.tiers,
        window: w.label,
        windowStart: w.firstDate,
      };
      if (tier === undefined) return notFired(`${pct(dd)} below ${w.label} high`, extra);
      const top = tier === p.tiers[p.tiers.length - 1];
      return fired(
        top ? 'critical' : 'warn',
        `drawdown_${tier}`,
        `${subject} closed at ${money(close)}, ${pct(dd)} below its ${w.label} high of ${money(high)} (≥ ${tier}% tier)`,
        { ...extra, tier },
      );
    }

    case 'new_52w_low': {
      parseRuleParams(type, rule.params);
      const w = window52w(ctx);
      const prior = w.bars.filter((b) => b.date < ctx.asOfDate);
      if (prior.length < MIN_WINDOW_BARS) {
        return notChecked(
          'insufficient_history',
          `only ${prior.length} prior bars in the 52-week window`,
        );
      }
      const priorLow = Math.min(...prior.map((b) => b.close));
      const extra = { close, priorLowClose: priorLow, window: w.label, windowStart: w.firstDate };
      if (below(close, priorLow)) {
        return fired(
          'warn',
          'new_low',
          `${subject} closed at ${money(close)}, a new ${w.label} closing low (previous low ${money(priorLow)})`,
          extra,
        );
      }
      return notFired(
        `close ${money(close)} not below ${w.label} closing low ${money(priorLow)}`,
        extra,
      );
    }

    case 'close_below_cost': {
      const p = parseRuleParams(type, rule.params);
      const prevDate = sessionIdx > 0 ? ctx.sessions[sessionIdx - 1]! : null;
      const prev = prevDate ? barsByDate.get(prevDate) : undefined;
      const extra = { close, cost: p.cost, lot: p.lot ?? null, prevClose: prev?.close ?? null };
      if (!below(close, p.cost))
        return notFired(`close ${money(close)} at or above cost ${money(p.cost)}`, extra);
      if (p.first_crossing_only && ctx.firedBefore) {
        return notFired('below cost; first crossing already alerted', extra);
      }
      if (!p.first_crossing_only && prev && below(prev.close, p.cost)) {
        return notFired('still below cost (no new crossing)', extra);
      }
      const lot = p.lot ? ` (${p.lot})` : '';
      return fired(
        'warn',
        'below_cost',
        `${subject} closed at ${money(close)}, below cost ${money(p.cost)}${lot}`,
        extra,
      );
    }

    case 'time_stop': {
      const p = parseRuleParams(type, rule.params);
      const extra = { close, reviewOn: p.review_on, belowPrice: p.below_price ?? null };
      if (p.below_price !== undefined && !below(close, p.below_price)) {
        return notFired(
          `time stop: close ${money(close)} not below ${money(p.below_price)}`,
          extra,
        );
      }
      const cond =
        p.below_price !== undefined
          ? ` and the close ${money(close)} is below ${money(p.below_price)}`
          : '';
      return fired(
        'warn',
        'time_stop',
        `Time stop for ${ctx.instrumentSymbol}: review date ${p.review_on} reached${cond}`,
        extra,
      );
    }

    default: {
      const never: never = type;
      throw new Error(`unhandled rule type ${String(never)}`);
    }
  }
}

/** Bars in the 52 weeks up to asOfDate, and how to describe the window if history is short. */
function window52w(ctx: EvalContext) {
  const start = addDays(ctx.asOfDate, -WINDOW_DAYS);
  const bars = ctx.bars.filter((b) => b.date > start && b.date <= ctx.asOfDate);
  const sessions = ctx.sessions.filter((d) => d > start && d <= ctx.asOfDate);
  const firstDate = bars[0]?.date ?? null;
  const missingAtStart = firstDate ? sessions.filter((d) => d < firstDate).length : sessions.length;
  const partial = missingAtStart > PARTIAL_HISTORY_SLACK;
  return { bars, firstDate, label: partial && firstDate ? `since ${firstDate}` : '52-week' };
}
