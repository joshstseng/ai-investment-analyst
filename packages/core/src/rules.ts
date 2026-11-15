import { z } from 'zod';
import { isIsoDate } from './time';

/** Machine-checkable rule types. Evaluators arrive in milestone 6. */
export const RULE_TYPES = [
  'stop_close_below',
  'take_profit_at_or_above',
  'trailing_close_pct_from_high',
  'day_move_pct',
  'etf_drawdown_from_52w_high',
  'new_52w_low',
  'close_below_cost',
  'option_value_below',
  'time_stop',
  'date_reminder',
] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export const RULE_PURPOSES = [
  'risk_stop',
  'take_profit',
  'valuation_trim',
  'thesis_break',
  'time_stop',
  'reminder',
  'monitor',
] as const;
export type RulePurpose = (typeof RULE_PURPOSES)[number];

export const RULE_STATUSES = ['CONFIRMED', 'DRAFT', 'PLACEHOLDER'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

/**
 * Every status sends alerts; only the label differs. Alerts are held back only when the rule
 * needs data we don't have (a trailing stop that hasn't started, no option prices, ...).
 */
export function ruleAlertLabel(status: RuleStatus): 'action per plan' | 'review' {
  return status === 'CONFIRMED' ? 'action per plan' : 'review';
}

export const DEFAULT_STOCK_DAY_MOVE_PCT = 7;
export const DEFAULT_ETF_DRAWDOWN_TIERS: readonly number[] = [10, 15, 20];

const price = z.number().positive();
const pct = z.number().positive().max(100);
const isoDate = z.string().refine(isIsoDate, 'expected YYYY-MM-DD');

export const ruleParamsSchemas = {
  stop_close_below: z
    .object({ level: price, warn_close_at_or_below: price.optional() })
    .strict()
    .refine((p) => p.warn_close_at_or_below === undefined || p.warn_close_at_or_below >= p.level, {
      message: 'warn level must be at or above the stop level',
    }),
  take_profit_at_or_above: z
    .object({
      level: price,
      /** Which bar value triggers: the close only, or the intraday high or the close. */
      basis: z.enum(['close', 'high_or_close']),
      /** Upper end of a sell range, e.g. "sell at $50–55". Informational. */
      range_high: price.optional(),
      /** Last date the rule applies (inclusive); it stops firing after this. */
      valid_until: isoDate.optional(),
    })
    .strict(),
  trailing_close_pct_from_high: z
    .object({
      pct,
      /** First date the highest close is tracked from. null = not started; alerts held back. */
      start_date: isoDate.nullable(),
      /** external_key of the rule whose firing starts the trail. */
      start_after_rule: z.string().optional(),
    })
    .strict(),
  day_move_pct: z.object({ pct }).strict(),
  etf_drawdown_from_52w_high: z
    .object({ tiers: z.array(pct).min(1) })
    .strict()
    .refine((p) => p.tiers.every((t, i) => i === 0 || t > p.tiers[i - 1]!), {
      message: 'tiers must be strictly ascending',
    }),
  /** The 52-week low is computed from stored daily bars, never hard-coded. */
  new_52w_low: z.object({}).strict(),
  close_below_cost: z
    .object({ cost: price, first_crossing_only: z.boolean(), lot: z.string().optional() })
    .strict(),
  /** Needs option prices; alerts are labelled as estimates and held back without data. */
  option_value_below: z.object({ level: price, estimate: z.literal(true) }).strict(),
  /** Fires on/after review_on (optionally only if the close is below below_price). */
  time_stop: z.object({ review_on: isoDate, below_price: price.optional() }).strict(),
  /** Fires once on `on` (or the next check after it); the alert text is the rule's alert_note. */
  date_reminder: z.object({ on: isoDate }).strict(),
} satisfies Record<RuleType, z.ZodType>;

export type RuleParams<T extends RuleType> = z.infer<(typeof ruleParamsSchemas)[T]>;

export function parseRuleParams<T extends RuleType>(type: T, params: unknown): RuleParams<T> {
  return ruleParamsSchemas[type].parse(params) as RuleParams<T>;
}

/**
 * A "rule to write": a placeholder with neither a machine-checkable type nor judgment text
 * (e.g. positions.csv "DRAFT PENDING" cells). These never fire; they are listed in the weekly
 * digest's "rules to write" section, not daily. Typed PLACEHOLDER rules (the ±7% day move,
 * ETF drawdown tiers, ...) are real, checkable rules and are NOT rules to write.
 */
export function isRuleToWrite(rule: {
  ruleType: string | null;
  thesisBreakTriggers: string | null;
}): boolean {
  return rule.ruleType === null && !rule.thesisBreakTriggers;
}
