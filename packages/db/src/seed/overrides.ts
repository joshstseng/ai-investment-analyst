/**
 * seed-overrides.json (gitignored, next to the seed files): decisions the user made outside the
 * exported files. This is where free-text rules become typed rules, explicitly and reviewably.
 */
import { isIsoDate, RULE_PURPOSES, RULE_STATUSES, RULE_TYPES, ruleParamsSchemas } from '@aia/core';
import { z } from 'zod';

const isoDate = z.string().refine(isIsoDate, 'expected YYYY-MM-DD');
const decimal = z.string().regex(/^\d+(\.\d+)?$/, 'expected a decimal string like "61.03"');
/** A ticker as written in holdings.md, e.g. "ACMX" or "OPTX Jun-16-2028 $45 call". */
const tickerRef = z.string().min(1);

const ruleOverride = z
  .object({
    /**
     * "positions:<SYMBOL>:<purpose>" upgrades the rule imported from that positions.csv cell
     * (its verbatim text is kept). "manual:..." adds a new rule.
     */
    key: z.string().regex(/^(positions|manual):\S+$/),
    ticker: tickerRef,
    purpose: z.enum(RULE_PURPOSES),
    status: z.enum(RULE_STATUSES),
    rule_type: z.enum(RULE_TYPES).nullable(),
    params: z.record(z.string(), z.unknown()).default({}),
    thesis_break_triggers: z.string().min(1).optional(),
    /** Included in every alert from this rule. */
    alert_note: z.string().min(1).optional(),
    notes: z.string().optional(),
    confirmed_at: isoDate.optional(),
    needs_input: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.rule_type) {
      const res = ruleParamsSchemas[r.rule_type].safeParse(r.params);
      if (!res.success) {
        ctx.addIssue({
          code: 'custom',
          path: ['params'],
          message: `${r.key}: ${res.error.issues.map((i) => i.message).join('; ')}`,
        });
      }
    } else if (Object.keys(r.params).length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['params'],
        message: `${r.key}: params need a rule_type`,
      });
    }
  });

export const seedOverridesSchema = z
  .object({
    _readme: z.string().optional(),
    /** positions.csv ticker → holdings.md ticker, e.g. "OPTX" → "OPTX Jun-16-2028 $45 call". */
    aliases: z.record(z.string(), tickerRef).default({}),
    holdings: z
      .array(
        z
          .object({
            account: z.enum(['roth_ira', 'individual_taxable']),
            ticker: tickerRef,
            needs_confirmation: z.boolean(),
            confirmation_note: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    theses: z
      .array(
        z
          .object({
            ticker: tickerRef,
            entry_price: decimal.optional(),
            entry_date: isoDate.optional(),
            why_i_own_it: z.string().min(1).optional(),
          })
          .strict(),
      )
      .default([]),
    rules: z.array(ruleOverride).default([]),
  })
  .strict();

export type SeedOverrides = z.infer<typeof seedOverridesSchema>;
export type RuleOverride = SeedOverrides['rules'][number];

export const EMPTY_OVERRIDES: SeedOverrides = seedOverridesSchema.parse({});
