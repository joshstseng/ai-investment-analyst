/**
 * Pullback screen, decision side (pure): qualification, tiers, the alert state machine and the
 * mechanical exit levels. Price metrics come from ./pullbacks.
 */
import { nyDate } from './time';
import type { PriceMetrics } from './pullbacks';

export type PullbackCheck = 'open' | 'midday' | 'eod';

export interface PullbackRules {
  qualify: { fromHighPct: number; multiDayDropPct: number; oneDayDropPct: number };
  /** % below the 52-week high, ascending (e.g. 20, 25, 30, 35). */
  tiers: readonly number[];
  gapDownPct: number;
  resetAboveFromHighPct: number;
}

export interface PullbackState {
  /** Deepest tier reached at the latest check (null above the first tier). */
  currentTier: number | null;
  /** Deepest tier already alerted (a tier is never alerted twice in an episode). */
  lastAlertedTier: number | null;
  /** ISO timestamp of the last alert. */
  lastAlertedAt: string | null;
  lastAlertedCheck: PullbackCheck | null;
  /** Date the current qualifying episode started (null = not in an episode). */
  qualifiedSince: string | null;
  /** Date of the last one-day-drop alert (at most one per ticker per day). */
  alertedOneDayDropDate: string | null;
}

export const EMPTY_PULLBACK_STATE: PullbackState = {
  currentTier: null,
  lastAlertedTier: null,
  lastAlertedAt: null,
  lastAlertedCheck: null,
  qualifiedSince: null,
  alertedOneDayDropDate: null,
};

export type QualifyReason = 'from_high' | 'multi_day' | 'one_day';

export interface PullbackQualification {
  qualifies: boolean;
  reasons: QualifyReason[];
  /** Deepest tier reached by the % below the 52-week high, or null. */
  tier: number | null;
  /** Open check only: price ≥ gapDownPct below the previous close (labels the alert). */
  gapDown: boolean;
}

/** Which thresholds the price meets, and the deepest tier reached. */
export function qualify(
  m: PriceMetrics,
  rules: PullbackRules,
  check: PullbackCheck,
): PullbackQualification {
  const reasons: QualifyReason[] = [];
  if (m.belowHighPct >= rules.qualify.fromHighPct) reasons.push('from_high');
  if (m.worstDropPct <= -rules.qualify.multiDayDropPct) reasons.push('multi_day');
  if (m.d1Pct <= -rules.qualify.oneDayDropPct) reasons.push('one_day');
  const tier = [...rules.tiers].reverse().find((t) => m.belowHighPct >= t) ?? null;
  return {
    qualifies: reasons.length > 0,
    reasons,
    tier,
    gapDown: check === 'open' && m.d1Pct <= -rules.gapDownPct,
  };
}

export type PullbackAlertKind = 'first' | 'deeper_tier' | 'one_day_drop';

export interface PullbackDecision {
  q: PullbackQualification;
  next: PullbackState;
  /** Alert to send now (one per ticker per run), or null. */
  alert: { kinds: PullbackAlertKind[]; tier: number | null; gapDown: boolean } | null;
  /** EOD: a tier alerted at today's Open/Midday that the close is back above (state kept). */
  reversed: { tier: number; check: PullbackCheck } | null;
  /** EOD: the episode ended (close less than resetAboveFromHighPct below the high). */
  reset: boolean;
}

/**
 * The alert policy:
 * - alert when a ticker first qualifies, reaches a deeper tier than any alerted, or has a new
 *   one-day drop ≥ oneDayDropPct (at most once per ticker per day across all checks; skipped when
 *   `suppressOneDayDrop`, e.g. a rule already alerted the ticker today);
 * - never repeat a tier;
 * - an intraday tier alert reversed by the close is reported, and state is kept;
 * - reset only at EOD, when the close is less than resetAboveFromHighPct below the high and the
 *   ticker no longer qualifies.
 */
export function decidePullback(
  prev: PullbackState | null,
  m: PriceMetrics,
  ctx: {
    check: PullbackCheck;
    date: string;
    now: Date;
    rules: PullbackRules;
    suppressOneDayDrop?: boolean;
  },
): PullbackDecision {
  const q = qualify(m, ctx.rules, ctx.check);
  const s: PullbackState = { ...(prev ?? EMPTY_PULLBACK_STATE) };
  const kinds: PullbackAlertKind[] = [];

  let reversed: PullbackDecision['reversed'] = null;
  if (
    ctx.check === 'eod' &&
    s.lastAlertedTier !== null &&
    (s.lastAlertedCheck === 'open' || s.lastAlertedCheck === 'midday') &&
    s.lastAlertedAt !== null &&
    nyDate(new Date(s.lastAlertedAt)) === ctx.date &&
    (q.tier === null || q.tier < s.lastAlertedTier)
  ) {
    reversed = { tier: s.lastAlertedTier, check: s.lastAlertedCheck };
  }

  if (q.qualifies) {
    if (!s.qualifiedSince) {
      kinds.push('first');
      s.qualifiedSince = ctx.date;
      s.lastAlertedTier = q.tier;
    } else if (q.tier !== null && (s.lastAlertedTier === null || q.tier > s.lastAlertedTier)) {
      kinds.push('deeper_tier');
      s.lastAlertedTier = q.tier;
    }
  }
  if (m.d1Pct <= -ctx.rules.qualify.oneDayDropPct && s.alertedOneDayDropDate !== ctx.date) {
    if (!ctx.suppressOneDayDrop) kinds.push('one_day_drop');
    s.alertedOneDayDropDate = ctx.date;
  }
  s.currentTier = q.tier;
  if (kinds.length) {
    s.lastAlertedAt = ctx.now.toISOString();
    s.lastAlertedCheck = ctx.check;
  }
  const alert = kinds.length ? { kinds, tier: q.tier, gapDown: q.gapDown } : null;

  if (
    ctx.check === 'eod' &&
    s.qualifiedSince &&
    !q.qualifies &&
    m.belowHighPct < ctx.rules.resetAboveFromHighPct
  ) {
    return {
      q,
      next: { ...EMPTY_PULLBACK_STATE, alertedOneDayDropDate: s.alertedOneDayDropDate },
      alert,
      reversed,
      reset: true,
    };
  }
  return { q, next: s, alert, reversed, reset: false };
}

// ---- Exit levels --------------------------------------------------------------------------------

export interface ExitLevels {
  riskStop: { value: number; basis: string };
  valuationTrim: { value: number; basis: string } | null;
  reUnderwrite: { date: string; basis: string } | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Mechanical exit levels, each with its basis:
 * - risk stop = max(52-week low, price − 2 × ATR14);
 * - valuation trim = the price where P/E returns to its own median (median P/E × TTM EPS);
 * - re-underwrite point = the next earnings date.
 */
export function exitLevels(p: {
  price: number;
  low52: number;
  atr14: number | null;
  epsTtm: number | null;
  peMedian: number | null;
  nextEarnings: string | null;
}): ExitLevels {
  let riskStop: ExitLevels['riskStop'];
  if (p.atr14 === null) {
    riskStop = { value: r2(p.low52), basis: `52-week low ${usd(p.low52)} (no ATR: short history)` };
  } else {
    const atrStop = p.price - 2 * p.atr14;
    riskStop =
      p.low52 >= atrStop
        ? {
            value: r2(p.low52),
            basis: `52-week low ${usd(p.low52)} (higher than price − 2×ATR14 = ${usd(atrStop)})`,
          }
        : {
            value: r2(atrStop),
            basis: `price − 2×ATR14 (ATR14 ${usd(p.atr14)}; higher than the 52-week low ${usd(p.low52)})`,
          };
  }
  const valuationTrim =
    p.epsTtm !== null && p.epsTtm > 0 && p.peMedian !== null && p.peMedian > 0
      ? {
          value: r2(p.peMedian * p.epsTtm),
          basis: `P/E back to its own median ${p.peMedian.toFixed(1)} × TTM EPS ${usd(p.epsTtm)}`,
        }
      : null;
  const reUnderwrite = p.nextEarnings
    ? { date: p.nextEarnings, basis: 'next earnings report' }
    : null;
  return { riskStop, valuationTrim, reUnderwrite };
}
