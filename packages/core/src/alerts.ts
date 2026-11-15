/**
 * Alert policy (pure). Rules are stateless; this decides which fires become alerts:
 * - first fire → alert
 * - escalation → alert: higher rank (warning → breach, a new drawdown tier) or the price moved
 *   a further ESCALATION_MOVE_PCT in the bad direction since the last alert
 * - condition clears (rule evaluated, not fired) → reset; the next fire is a first fire again
 * - not checked (missing data) → state unchanged: a data gap is not a recovery
 * - event rules (day moves, date reminders) → alert every time they fire
 */
import type { Outcome } from './engine';
import type { RuleStatus, RuleType } from './rules';

export const ESCALATION_MOVE_PCT = 2;

export interface AlertState {
  active: boolean;
  rank: number;
  /** Price at the last alert (the reference for "a further 2% move"). */
  price: number;
  level: string;
  firstFiredOn: string;
  lastAlertedOn: string | null;
}

export type AlertReason = 'first' | 'escalation_level' | 'escalation_move' | 'event';

export interface AlertDecision {
  send: boolean;
  reason: AlertReason | 'still_active' | 'cleared' | 'no_change';
  /** Human detail for escalations, e.g. "warning → stop" or "$145.00 → $141.50". */
  detail?: string;
  /** State to store (null = no state row). */
  next: AlertState | null;
}

const fmt = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

export function decideAlert(
  prev: AlertState | null,
  outcome: Outcome,
  asOfDate: string,
): AlertDecision {
  if (outcome.kind === 'not_checked') return { send: false, reason: 'no_change', next: prev };
  if (outcome.kind === 'not_fired') {
    return prev?.active
      ? { send: false, reason: 'cleared', next: { ...prev, active: false } }
      : { send: false, reason: 'no_change', next: prev };
  }
  const t = outcome.track;
  if (t.kind === 'event') return { send: true, reason: 'event', next: prev };

  if (!prev || !prev.active) {
    return {
      send: true,
      reason: 'first',
      next: {
        active: true,
        rank: t.rank,
        price: t.price,
        level: outcome.level,
        firstFiredOn: asOfDate,
        lastAlertedOn: asOfDate,
      },
    };
  }
  if (t.rank > prev.rank) {
    return {
      send: true,
      reason: 'escalation_level',
      detail: `${prev.level} → ${outcome.level}`,
      next: {
        ...prev,
        rank: t.rank,
        price: t.price,
        level: outcome.level,
        lastAlertedOn: asOfDate,
      },
    };
  }
  const factor = ESCALATION_MOVE_PCT / 100;
  const eps = 1e-9 * Math.max(1, prev.price);
  const movedFurther =
    t.direction === 'down'
      ? t.price <= prev.price * (1 - factor) + eps
      : t.price >= prev.price * (1 + factor) - eps;
  if (movedFurther) {
    return {
      send: true,
      reason: 'escalation_move',
      detail: `${fmt(prev.price)} → ${fmt(t.price)}`,
      next: {
        ...prev,
        rank: t.rank,
        price: t.price,
        level: outcome.level,
        lastAlertedOn: asOfDate,
      },
    };
  }
  // Still active. If the rank dropped (breach → back to warning), remember the lower rank so a
  // renewed breach escalates again; keep the last alerted price as the move reference.
  return {
    send: false,
    reason: 'still_active',
    next: { ...prev, rank: t.rank, level: outcome.level },
  };
}

/** DIGEST is used only by the daily digest; REVIEW only for DRAFT/PLACEHOLDER rule alerts. */
export type SubjectTag = 'ACTION' | 'WARNING' | 'REVIEW' | 'REMINDER' | 'HEALTH' | 'DIGEST';

/**
 * Subject severity: reminders are REMINDER; DRAFT/PLACEHOLDER rules are REVIEW; CONFIRMED rules
 * are ACTION for exit-level events and planned trades, WARNING for warning levels.
 */
export function ruleAlertTag(
  status: RuleStatus,
  ruleType: RuleType,
  outcome: Extract<Outcome, { kind: 'fired' }>,
): SubjectTag {
  if (ruleType === 'date_reminder') return 'REMINDER';
  if (status !== 'CONFIRMED') return 'REVIEW';
  if (outcome.severity === 'critical') return 'ACTION';
  if (outcome.level === 'take_profit' || outcome.level === 'time_stop') return 'ACTION';
  return 'WARNING';
}
