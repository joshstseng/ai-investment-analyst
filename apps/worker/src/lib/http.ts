/**
 * Every external HTTP call goes through requestJson: a timeout, retry with exponential backoff
 * and jitter (honouring Retry-After), a shared rate limiter, and zod validation of the body.
 */
import type { z } from 'zod';

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${redact(url)}: ${body.slice(0, 200)}`);
  }
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

/** Strips query strings from URLs in messages (they can be long; never contain secrets here). */
function redact(url: string) {
  return url.split('?')[0];
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff with "equal jitter": half fixed, half random. */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(exp / 2 + (random() * exp) / 2);
}

/**
 * Token bucket: `perMinute` sustained, bursts up to `burst`. take() waits until a token is free.
 */
export class RateLimiter {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly perMinute: number,
    private readonly burst = Math.min(10, perMinute),
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  take(): Promise<void> {
    // Serialize callers so tokens are handed out in order.
    const next = this.queue.then(() => this.acquire());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async acquire() {
    for (;;) {
      const t = this.now();
      this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) * this.perMinute) / 60_000);
      this.last = t;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.wait(Math.ceil(((1 - this.tokens) * 60_000) / this.perMinute));
    }
  }
}

export interface RequestOptions<S extends z.ZodType> {
  schema: S;
  /** Defaults to GET. */
  method?: 'GET' | 'POST';
  /** JSON-serializable request body (sent with Content-Type: application/json). */
  body?: unknown;
  headers?: Record<string, string>;
  limiter?: RateLimiter;
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  fetchImpl?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export async function requestJson<S extends z.ZodType>(
  url: string,
  opts: RequestOptions<S>,
): Promise<z.infer<S>> {
  const {
    schema,
    headers,
    limiter,
    timeoutMs = 15_000,
    retries = 4,
    baseDelayMs = 1_000,
    maxDelayMs = 30_000,
    fetchImpl = fetch,
    wait = sleep,
  } = opts;

  for (let attempt = 0; ; attempt++) {
    await limiter?.take();
    let retryAfterMs: number | undefined;
    try {
      const res = await fetchImpl(url, {
        method: opts.method ?? 'GET',
        headers:
          opts.body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        const ra = Number(res.headers.get('retry-after'));
        if (Number.isFinite(ra) && ra > 0) retryAfterMs = ra * 1000;
        throw new HttpError(res.status, url, text);
      }
      return schema.parse(JSON.parse(text)) as z.infer<S>;
    } catch (error) {
      const retryable =
        error instanceof HttpError
          ? error.retryable
          : // Network failures and timeouts (TypeError / AbortError / TimeoutError) are retryable;
            // JSON or schema errors are not.
            error instanceof TypeError ||
            (error instanceof DOMException &&
              (error.name === 'TimeoutError' || error.name === 'AbortError'));
      if (!retryable || attempt >= retries) throw error;
      const delayMs = Math.max(retryAfterMs ?? 0, backoffDelay(attempt, baseDelayMs, maxDelayMs));
      opts.onRetry?.({ attempt, delayMs, error });
      await wait(delayMs);
    }
  }
}
