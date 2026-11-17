/** zod schemas for the Alpaca responses we use (shapes confirmed against the live API). */
import { z } from 'zod';

export const clockSchema = z.object({
  timestamp: z.string(),
  is_open: z.boolean(),
  next_open: z.string(),
  next_close: z.string(),
});
export type AlpacaClock = z.infer<typeof clockSchema>;

export const calendarDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  open: z.string().regex(/^\d{2}:\d{2}$/),
  close: z.string().regex(/^\d{2}:\d{2}$/),
  session_open: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  session_close: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
});
export type AlpacaCalendarDay = z.infer<typeof calendarDaySchema>;

export const barSchema = z.object({
  t: z.string(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number(),
  n: z.number().optional(),
  vw: z.number().optional(),
});
export type AlpacaBar = z.infer<typeof barSchema>;

export const barsPageSchema = z.object({
  bars: z.record(z.string(), z.array(barSchema)).nullable(),
  next_page_token: z.string().nullable().optional(),
});

const quoteSchema = z.object({
  t: z.string(),
  ap: z.number(),
  as: z.number(),
  bp: z.number(),
  bs: z.number(),
});
const tradeSchema = z.object({ t: z.string(), p: z.number() });

export const snapshotSchema = z.object({
  latestTrade: tradeSchema.nullable().optional(),
  latestQuote: quoteSchema.nullable().optional(),
  dailyBar: barSchema.nullable().optional(),
  prevDailyBar: barSchema.nullable().optional(),
});
export type AlpacaSnapshot = z.infer<typeof snapshotSchema>;

/** Multi-symbol snapshots come back as a map keyed by symbol; unknown symbols may be null. */
export const snapshotsSchema = z.record(z.string(), snapshotSchema.nullable());

export const newsItemSchema = z.object({
  id: z.number(),
  headline: z.string(),
  summary: z.string().optional().default(''),
  author: z.string().optional().default(''),
  created_at: z.string(),
  updated_at: z.string().optional(),
  url: z.string().nullable().optional(),
  symbols: z.array(z.string()).default([]),
  source: z.string().default('unknown'),
});
export type AlpacaNewsItem = z.infer<typeof newsItemSchema>;

export const newsPageSchema = z.object({
  news: z.array(newsItemSchema),
  next_page_token: z.string().nullable().optional(),
});

/** Websocket control and data messages (each frame is a JSON array of these). */
export const streamMessageSchema = z.discriminatedUnion('T', [
  z.object({ T: z.literal('success'), msg: z.string() }),
  z.object({ T: z.literal('error'), code: z.number(), msg: z.string() }),
  z.object({ T: z.literal('subscription'), news: z.array(z.string()).optional() }),
  newsItemSchema.extend({ T: z.literal('n') }),
]);
export type StreamMessage = z.infer<typeof streamMessageSchema>;

/** Corporate actions (v1). Only the fields we use; unknown fields are ignored. */
const corporateActionBase = {
  id: z.string(),
  symbol: z.string(),
  ex_date: z.string().nullable().optional(),
  record_date: z.string().nullable().optional(),
  payable_date: z.string().nullable().optional(),
  process_date: z.string().nullable().optional(),
};
export const cashDividendSchema = z.object({
  ...corporateActionBase,
  rate: z.number(),
  special: z.boolean().optional(),
  foreign: z.boolean().optional(),
});
export const splitSchema = z.object({
  ...corporateActionBase,
  new_rate: z.number(),
  old_rate: z.number(),
});
/** Spin-offs: `source_symbol` distributed `new_symbol` shares on `ex_date`. */
export const spinOffsPageSchema = z.object({
  corporate_actions: z.object({
    spin_offs: z
      .array(
        z.object({
          source_symbol: z.string(),
          new_symbol: z.string().optional(),
          ex_date: z.string(),
        }),
      )
      .optional(),
  }),
  next_page_token: z.string().nullable().optional(),
});
export type SpinOff = NonNullable<
  z.infer<typeof spinOffsPageSchema>['corporate_actions']['spin_offs']
>[number];

export const corporateActionsPageSchema = z.object({
  corporate_actions: z.object({
    cash_dividends: z.array(cashDividendSchema).optional(),
    forward_splits: z.array(splitSchema).optional(),
    reverse_splits: z.array(splitSchema).optional(),
  }),
  next_page_token: z.string().nullable().optional(),
});
export type CashDividend = z.infer<typeof cashDividendSchema>;
export type Split = z.infer<typeof splitSchema>;
