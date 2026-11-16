/**
 * Levels to watch (pure): for each holding, rule levels the last close is approaching but has
 * not crossed, within `withinPct`. Crossed levels are "still-active conditions", not listed here.
 * Options are measured on the underlying's close.
 */
import type { RuleStatus } from './rules';

export type LevelKind = 'stop' | 'warning' | 'take_profit' | 'trailing_stop' | 'drawdown_tier';

export interface LevelRuleInput {
  status: RuleStatus;
  ruleType: string;
  params: Record<string, unknown>;
  /** Trailing stops: the current trigger level (from the latest evaluation); null if not started. */
  triggerLevel?: number | null;
}

export interface LevelInstrumentInput {
  display: string;
  instrumentSymbol: string;
  evaluatedSymbol: string;
  /** Last close of the evaluated symbol. */
  close: number | null;
  /** 52-week intraday high of the evaluated symbol (for ETF drawdown tiers). */
  high52w?: number | null;
  rules: readonly LevelRuleInput[];
}

export interface LevelToWatch {
  display: string;
  instrumentSymbol: string;
  evaluatedSymbol: string;
  kind: LevelKind;
  /** e.g. "stop", "warning level", "take-profit", "15% drawdown tier" */
  label: string;
  level: number;
  close: number;
  /** % of the close still to go before the level is reached (always ≥ 0). */
  distancePct: number;
  /** $ per share still to go. */
  distanceDollars: number;
  direction: 'down' | 'up';
  status: RuleStatus;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function levelsToWatch(
  instruments: readonly LevelInstrumentInput[],
  opts: { withinPct?: number; asOfDate: string },
): LevelToWatch[] {
  const within = opts.withinPct ?? 5;
  const out: LevelToWatch[] = [];
  for (const inst of instruments) {
    const close = inst.close;
    if (close === null || close <= 0) continue;
    const add = (
      kind: LevelKind,
      label: string,
      level: number,
      direction: 'down' | 'up',
      status: RuleStatus,
    ) => {
      const gap = direction === 'down' ? close - level : level - close;
      if (gap <= 0) return; // already at/through the level → active condition, not "to watch"
      const pct = (gap / close) * 100;
      if (pct > within + 1e-9) return;
      out.push({
        display: inst.display,
        instrumentSymbol: inst.instrumentSymbol,
        evaluatedSymbol: inst.evaluatedSymbol,
        kind,
        label,
        level,
        close,
        distancePct: Math.round(pct * 100) / 100,
        distanceDollars: Math.round(gap * 100) / 100,
        direction,
        status,
      });
    };

    for (const r of inst.rules) {
      const p = r.params;
      switch (r.ruleType) {
        case 'stop_close_below': {
          const level = num(p.level);
          const warn = num(p.warn_close_at_or_below);
          if (level !== null) add('stop', 'stop', level, 'down', r.status);
          if (warn !== null) add('warning', 'warning level', warn, 'down', r.status);
          break;
        }
        case 'take_profit_at_or_above': {
          const level = num(p.level);
          const validUntil = typeof p.valid_until === 'string' ? p.valid_until : null;
          if (level !== null && !(validUntil && opts.asOfDate > validUntil)) {
            add('take_profit', 'take-profit', level, 'up', r.status);
          }
          break;
        }
        case 'trailing_close_pct_from_high': {
          if (typeof r.triggerLevel === 'number') {
            add('trailing_stop', 'trailing stop', r.triggerLevel, 'down', r.status);
          }
          break;
        }
        case 'etf_drawdown_from_52w_high': {
          const high = inst.high52w;
          const tiers = Array.isArray(p.tiers)
            ? (p.tiers as unknown[]).map(num).filter((t): t is number => t !== null)
            : [];
          if (!high) break;
          // The next tier not yet reached: the highest tier price still below the close.
          const next = tiers
            .map((t) => ({ t, price: high * (1 - t / 100) }))
            .filter((x) => x.price < close)
            .sort((a, b) => b.price - a.price)[0];
          if (next)
            add(
              'drawdown_tier',
              `${next.t}% drawdown tier`,
              Math.round(next.price * 100) / 100,
              'down',
              r.status,
            );
          break;
        }
        default:
          break;
      }
    }
  }
  return out.sort((a, b) => a.distancePct - b.distancePct);
}
