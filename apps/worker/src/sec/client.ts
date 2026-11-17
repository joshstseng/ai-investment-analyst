/**
 * SEC EDGAR client. Fair access: a declared User-Agent with contact info on every request and
 * at most 10 requests/second (we stay at 8).
 */
import { z } from 'zod';
import { RateLimiter, requestJson } from '../lib/http';
import { log } from '../lib/log';

export const companyTickersSchema = z.record(
  z.string(),
  z.object({ cik_str: z.number(), ticker: z.string(), title: z.string() }),
);

export const fundTickersSchema = z.object({
  fields: z.array(z.string()),
  data: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
});

const col = <T extends z.ZodType>(t: T) => z.array(t);
export const submissionsSchema = z.object({
  cik: z.union([z.string(), z.number()]),
  name: z.string().optional(),
  tickers: z.array(z.string()).optional(),
  filings: z.object({
    recent: z.object({
      accessionNumber: col(z.string()),
      filingDate: col(z.string()),
      acceptanceDateTime: col(z.string()),
      form: col(z.string()),
      items: col(z.string()),
      primaryDocument: col(z.string()),
    }),
  }),
});
export type Submissions = z.infer<typeof submissionsSchema>;

/** XBRL company facts: every reported value per taxonomy → concept → unit (only fields we use). */
export const companyFactsSchema = z.object({
  cik: z.union([z.string(), z.number()]),
  entityName: z.string().optional(),
  facts: z.record(
    z.string(),
    z.record(
      z.string(),
      z.object({
        units: z.record(
          z.string(),
          z.array(
            z.object({
              start: z.string().optional(),
              end: z.string(),
              val: z.number(),
              fy: z.number().nullable().optional(),
              fp: z.string().nullable().optional(),
              form: z.string(),
              filed: z.string(),
            }),
          ),
        ),
      }),
    ),
  ),
});
export type CompanyFactsJson = z.infer<typeof companyFactsSchema>;

/** XBRL frames: one concept for every filer in one period (e.g. shares outstanding). */
export const framesSchema = z.object({
  data: z.array(z.object({ cik: z.number(), val: z.number(), end: z.string() }).passthrough()),
});

/**
 * SEC allows 10 requests/second. 8/s sustained with a burst of 1 keeps every 1-second window at
 * 9 or fewer (a larger burst would stack on top of the sustained rate).
 */
export function secRateLimiter(now?: () => number, wait?: (ms: number) => Promise<void>) {
  return new RateLimiter(8 * 60, 1, now, wait);
}

export const padCik = (cik: number | string) => String(cik).padStart(10, '0');

export class SecClient {
  private readonly headers: Record<string, string>;

  constructor(
    userAgent: string,
    private readonly opts: { fetchImpl?: typeof fetch; limiter?: RateLimiter } = {},
    private readonly limiter = opts.limiter ?? secRateLimiter(),
  ) {
    this.headers = { 'User-Agent': userAgent, 'Accept-Encoding': 'gzip, deflate' };
  }

  private get<S extends z.ZodType>(url: string, schema: S) {
    return requestJson(url, {
      schema,
      headers: this.headers,
      limiter: this.limiter,
      timeoutMs: 20_000,
      fetchImpl: this.opts.fetchImpl,
      onRetry: ({ attempt, delayMs, error }) =>
        log.warn('sec retry', { url, attempt, delayMs, error: String(error) }),
    });
  }

  companyTickers() {
    return this.get('https://www.sec.gov/files/company_tickers.json', companyTickersSchema);
  }

  fundTickers() {
    return this.get('https://www.sec.gov/files/company_tickers_mf.json', fundTickersSchema);
  }

  submissions(cik: string) {
    return this.get(`https://data.sec.gov/submissions/CIK${padCik(cik)}.json`, submissionsSchema);
  }

  /** All XBRL facts a company has reported (several MB for large filers). */
  companyFacts(cik: string) {
    return this.get(
      `https://data.sec.gov/api/xbrl/companyfacts/CIK${padCik(cik)}.json`,
      companyFactsSchema,
    );
  }

  /**
   * One XBRL concept for every filer in a period, e.g.
   * frames('us-gaap', 'WeightedAverageNumberOfDilutedSharesOutstanding', 'shares', 'CY2026Q3').
   */
  frames(taxonomy: string, concept: string, unit: string, period: string) {
    return this.get(
      `https://data.sec.gov/api/xbrl/frames/${taxonomy}/${concept}/${unit}/${period}.json`,
      framesSchema,
    );
  }

  /** A raw document (e.g. Form 4 XML) as text, under the same fair-access limits. */
  text(url: string) {
    return requestJson(url, {
      schema: z.string(),
      responseType: 'text',
      headers: this.headers,
      limiter: this.limiter,
      timeoutMs: 20_000,
      retries: 2,
      fetchImpl: this.opts.fetchImpl,
    });
  }
}
