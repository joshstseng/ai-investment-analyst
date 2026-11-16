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
