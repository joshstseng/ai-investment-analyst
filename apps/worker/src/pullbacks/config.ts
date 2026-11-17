/**
 * Pullback screen configuration: config/pullbacks.json at the repo root, validated with zod.
 * Universe CSVs live next to it in config/universe/ (both ship in the Docker image).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const CONFIG_DIR = fileURLToPath(new URL('../../../../config/', import.meta.url));

const pct = z.number().min(0).max(100);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
const ticker = z
  .string()
  .regex(/^[A-Z][A-Z0-9.]{0,9}$/, 'expected an upper-case ticker like MSFT or BRK.B');

export const pullbackConfigSchema = z.object({
  universe: z.object({
    /** Largest N S&P 500 members by market cap (config/universe/sp500.csv rank). */
    sp500Top: z.number().int().min(0).max(505),
    nasdaq100: z.boolean(),
    core: z.array(ticker),
    extra: z.array(ticker).default([]),
    exclude: z.array(ticker).default([]),
  }),
  checks: z.object({ open: hhmm, midday: hhmm }),
  qualify: z.object({
    fromHighPct: pct,
    multiDayDropPct: pct,
    multiDayWindowDays: z.number().int().min(1).max(10),
    oneDayDropPct: pct,
  }),
  /** % below the 52-week high, ascending. */
  tiers: z
    .array(pct)
    .min(1)
    .refine((t) => t.every((v, i) => i === 0 || v > t[i - 1]!), 'tiers must ascend'),
  gapDownPct: pct,
  /** State resets only when an EOD close is less than this far below the 52-week high. */
  resetAboveFromHighPct: pct,
  /** Earlier CIKs whose filing history belongs to a ticker (e.g. after a holding-company reorg). */
  predecessorCiks: z.record(ticker, z.array(z.string().regex(/^\d{10}$/))).default({}),
  quality: z.object({
    profitableYears: z.number().int().min(1).max(10),
    requirePositiveTtmNetIncome: z.boolean(),
    requirePositiveTtmFcf: z.boolean(),
    minRevenueGrowthPct: z.number(),
    minMarketCapUsd: z.number().min(0).nullable(),
  }),
  alerts: z.object({
    maxSeparateEmails: z.number().int().min(1),
    earningsWindowTradingDays: z.number().int().min(0),
  }),
  prices: z.object({
    historyYears: z.number().int().min(1).max(10),
    twelveData: z.object({
      perMinute: z.number().int().min(1),
      dailyBudget: z.number().int().min(0),
      maxPerRun: z.number().int().min(0),
    }),
  }),
});

export type PullbackConfig = z.infer<typeof pullbackConfigSchema>;

let cached: PullbackConfig | null = null;

/** Loads and validates config/pullbacks.json (cached). Keys starting with "$" are comments. */
export function loadPullbackConfig(path = `${CONFIG_DIR}pullbacks.json`): PullbackConfig {
  if (cached && path === `${CONFIG_DIR}pullbacks.json`) return cached;
  const strip = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(strip)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([k]) => !k.startsWith('$'))
              .map(([k, x]) => [k, strip(x)]),
          )
        : v;
  const parsed = pullbackConfigSchema.parse(strip(JSON.parse(readFileSync(path, 'utf8'))));
  if (path === `${CONFIG_DIR}pullbacks.json`) cached = parsed;
  return parsed;
}
