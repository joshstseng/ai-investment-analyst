/**
 * Read-only Alpaca client: clock, calendar, daily bars, snapshots, news.
 * There is deliberately no order/position code here (see CLAUDE.md).
 */
import type { z } from 'zod';
import type { Env } from '../env';
import { HttpError, RateLimiter, requestJson } from '../lib/http';
import { log } from '../lib/log';
import {
  barsPageSchema,
  calendarDaySchema,
  clockSchema,
  newsPageSchema,
  snapshotsSchema,
  type AlpacaBar,
  type AlpacaNewsItem,
  type AlpacaSnapshot,
} from './schemas';

export type Feed = 'sip' | 'iex';

/** 403 "subscription does not permit ..." — the plan can't access this data. Not retryable. */
export function isSubscriptionError(error: unknown): error is HttpError {
  return error instanceof HttpError && error.status === 403 && /subscription/i.test(error.body);
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface AlpacaClientOptions {
  fetchImpl?: typeof fetch;
  /** Free plan: data API 200 req/min, trading API 1000 req/min. Stay a little under. */
  dataLimiter?: RateLimiter;
  tradingLimiter?: RateLimiter;
}

export class AlpacaClient {
  private readonly headers: Record<string, string>;
  private readonly dataLimiter: RateLimiter;
  private readonly tradingLimiter: RateLimiter;

  constructor(
    private readonly env: Pick<
      Env,
      'ALPACA_KEY_ID' | 'ALPACA_SECRET' | 'ALPACA_TRADING_URL' | 'ALPACA_DATA_URL'
    >,
    private readonly opts: AlpacaClientOptions = {},
  ) {
    this.headers = {
      'APCA-API-KEY-ID': env.ALPACA_KEY_ID,
      'APCA-API-SECRET-KEY': env.ALPACA_SECRET,
      Accept: 'application/json',
    };
    this.dataLimiter = opts.dataLimiter ?? new RateLimiter(180);
    this.tradingLimiter = opts.tradingLimiter ?? new RateLimiter(600);
  }

  private get<S extends z.ZodType>(url: string, schema: S, limiter: RateLimiter) {
    return requestJson(url, {
      schema,
      headers: this.headers,
      limiter,
      fetchImpl: this.opts.fetchImpl,
      onRetry: ({ attempt, delayMs, error }) =>
        log.warn('alpaca retry', {
          url: url.split('?')[0],
          attempt,
          delayMs,
          error: String(error),
        }),
    });
  }

  private dataUrl(path: string, params: Record<string, string | undefined>) {
    const u = new URL(path, this.env.ALPACA_DATA_URL);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  }

  clock() {
    return this.get(`${this.env.ALPACA_TRADING_URL}/v2/clock`, clockSchema, this.tradingLimiter);
  }

  calendar(start: string, end: string) {
    return this.get(
      `${this.env.ALPACA_TRADING_URL}/v2/calendar?start=${start}&end=${end}`,
      calendarDaySchema.array(),
      this.tradingLimiter,
    );
  }

  /** Daily bars (split-adjusted) for many symbols, all pages. Symbols with no data are absent. */
  async dailyBars(p: {
    symbols: readonly string[];
    start: string;
    end: string;
    feed: Feed;
  }): Promise<Map<string, AlpacaBar[]>> {
    const out = new Map<string, AlpacaBar[]>();
    for (const group of chunk(p.symbols, 50)) {
      let pageToken: string | undefined;
      do {
        const page = await this.get(
          this.dataUrl('/v2/stocks/bars', {
            symbols: group.join(','),
            timeframe: '1Day',
            start: p.start,
            end: p.end,
            feed: p.feed,
            adjustment: 'split',
            limit: '10000',
            page_token: pageToken,
          }),
          barsPageSchema,
          this.dataLimiter,
        );
        for (const [symbol, bars] of Object.entries(page.bars ?? {})) {
          out.set(symbol, [...(out.get(symbol) ?? []), ...bars]);
        }
        pageToken = page.next_page_token ?? undefined;
      } while (pageToken);
    }
    return out;
  }

  async snapshots(symbols: readonly string[], feed: Feed = 'iex') {
    const out = new Map<string, AlpacaSnapshot>();
    for (const group of chunk(symbols, 100)) {
      const res = await this.get(
        this.dataUrl('/v2/stocks/snapshots', { symbols: group.join(','), feed }),
        snapshotsSchema,
        this.dataLimiter,
      );
      for (const [symbol, snap] of Object.entries(res)) if (snap) out.set(symbol, snap);
    }
    return out;
  }

  /** News for the given symbols between start and end (RFC 3339), oldest first, all pages. */
  async news(p: { symbols: readonly string[]; start: string; end?: string }) {
    const items: AlpacaNewsItem[] = [];
    for (const group of chunk(p.symbols, 50)) {
      let pageToken: string | undefined;
      do {
        const page = await this.get(
          this.dataUrl('/v1beta1/news', {
            symbols: group.join(','),
            start: p.start,
            end: p.end,
            sort: 'asc',
            limit: '50',
            include_content: 'false',
            page_token: pageToken,
          }),
          newsPageSchema,
          this.dataLimiter,
        );
        items.push(...page.news);
        pageToken = page.next_page_token ?? undefined;
      } while (pageToken);
    }
    return items;
  }
}
