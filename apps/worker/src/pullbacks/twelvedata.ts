/**
 * Twelve Data quotes: the fallback price source for symbols Alpaca doesn't return. Free plan:
 * 8 credits/minute and 800/day, 1 credit per symbol. Usage is counted per New York day in
 * `api_usage` so the budget survives restarts.
 */
import { nyDate } from '@aia/core';
import { apiUsage, type Db } from '@aia/db';
import { eq, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requestJson } from '../lib/http';
import { log } from '../lib/log';

export const TWELVEDATA = 'twelvedata';

const quoteSchema = z
  .object({
    symbol: z.string().optional(),
    datetime: z.string().optional(),
    timestamp: z.number().optional(),
    close: z.string().optional(),
    previous_close: z.string().optional(),
    status: z.string().optional(),
    code: z.number().optional(),
    message: z.string().optional(),
  })
  .passthrough();
type Quote = z.infer<typeof quoteSchema>;

export interface TdQuote {
  symbol: string;
  price: number;
  previousClose: number | null;
  at: Date;
}

/**
 * Splits symbols into per-minute batches within today's remaining credits and the per-run cap
 * (pure). Symbols that don't fit are returned as `skipped`.
 */
export function planBatches(
  symbols: readonly string[],
  p: { remainingToday: number; maxPerRun: number; perMinute: number },
): { batches: string[][]; skipped: string[] } {
  const allowed = Math.max(0, Math.min(p.remainingToday, p.maxPerRun));
  const take = symbols.slice(0, allowed);
  const batches: string[][] = [];
  for (let i = 0; i < take.length; i += p.perMinute) batches.push(take.slice(i, i + p.perMinute));
  return { batches, skipped: symbols.slice(allowed) };
}

/** Credits used today (New York date). */
export async function creditsUsed(db: Db, provider: string, now = new Date()) {
  const [row] = await db
    .select({ credits: apiUsage.credits })
    .from(apiUsage)
    .where(and(eq(apiUsage.provider, provider), eq(apiUsage.day, nyDate(now))));
  return row?.credits ?? 0;
}

export async function addUsage(db: Db, provider: string, credits: number, now = new Date()) {
  await db
    .insert(apiUsage)
    .values({ provider, day: nyDate(now), requests: 1, credits })
    .onConflictDoUpdate({
      target: [apiUsage.provider, apiUsage.day],
      set: {
        requests: sql`${apiUsage.requests} + 1`,
        credits: sql`${apiUsage.credits} + ${credits}`,
        updatedAt: new Date(),
      },
    });
}

function toQuote(symbol: string, q: Quote): TdQuote | null {
  if (q.status === 'error' || !q.close) return null;
  const price = Number(q.close);
  if (!Number.isFinite(price) || price <= 0) return null;
  const at = q.timestamp ? new Date(q.timestamp * 1000) : q.datetime ? new Date(q.datetime) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  const prev = q.previous_close ? Number(q.previous_close) : null;
  return { symbol, price, previousClose: prev && Number.isFinite(prev) ? prev : null, at };
}

export class TwelveDataClient {
  constructor(
    private readonly apiKey: string,
    private readonly opts: {
      fetchImpl?: typeof fetch;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  /**
   * Latest quotes, respecting the per-minute and daily budgets (one credit per symbol).
   * Counts each request in api_usage. Errors for one batch are logged and skipped.
   */
  async quotes(
    db: Db,
    symbols: readonly string[],
    budget: { perMinute: number; dailyBudget: number; maxPerRun: number },
    now = () => new Date(),
  ) {
    const used = await creditsUsed(db, TWELVEDATA, now());
    const plan = planBatches(symbols, {
      remainingToday: budget.dailyBudget - used,
      maxPerRun: budget.maxPerRun,
      perMinute: budget.perMinute,
    });
    const out = new Map<string, TdQuote>();
    const errors: string[] = [];
    let rateLimited = 0;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (const [i, batch] of plan.batches.entries()) {
      if (i > 0) await sleep(61_000); // stay under the per-minute credit limit
      const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(batch.join(','))}&apikey=${this.apiKey}`;
      try {
        const res = await requestJson(url, {
          schema: z.union([z.record(z.string(), quoteSchema), quoteSchema]),
          timeoutMs: 20_000,
          retries: 1,
          fetchImpl: this.opts.fetchImpl,
          onRetry: () => (rateLimited += 1),
        });
        await addUsage(db, TWELVEDATA, batch.length, now());
        // One symbol: the quote itself; several: keyed by symbol.
        const bySymbol: Record<string, Quote> =
          batch.length === 1 ? { [batch[0]!]: res as Quote } : (res as Record<string, Quote>);
        for (const s of batch) {
          const q = bySymbol[s];
          const quote = q ? toQuote(s, q) : null;
          if (quote) out.set(s, quote);
          else if (q?.code === 429) rateLimited += 1;
          else errors.push(`${s}: ${q?.message ?? 'no quote'}`);
        }
      } catch (error) {
        // Never log the URL: it carries the API key.
        errors.push(`batch ${batch[0]}…: ${String(error).replace(this.apiKey, '***')}`);
      }
    }
    if (errors.length) log.warn('twelve data errors', { errors: errors.slice(0, 10) });
    return { quotes: out, skipped: plan.skipped, errors, rateLimited, creditsUsedBefore: used };
  }
}
