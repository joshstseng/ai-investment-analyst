import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  ALPACA_KEY_ID: z.string().min(1, 'ALPACA_KEY_ID is not set'),
  ALPACA_SECRET: z.string().min(1, 'ALPACA_SECRET is not set'),
  /** Read-only use (clock, calendar). No order code exists in Step 1. */
  ALPACA_TRADING_URL: z.string().url().default('https://paper-api.alpaca.markets'),
  ALPACA_DATA_URL: z.string().url().default('https://data.alpaca.markets'),
  ALPACA_NEWS_WS_URL: z.string().url().default('wss://stream.data.alpaca.markets/v1beta1/news'),
  /** Daily bars feed. SIP (consolidated, official close) is available on the free plan 15+ min late. */
  ALPACA_BARS_FEED: z.enum(['sip', 'iex']).default('sip'),
  /** Set to false locally once Railway runs: Alpaca's free plan allows one news websocket. */
  NEWS_STREAM_ENABLED: z.stringbool().default(true),
  /** SEC fair access: "AppName contact@example.com". Required for the EDGAR collector. */
  SEC_USER_AGENT: z
    .string()
    .regex(/\S+@\S+\.\S+/, 'must include a contact email')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** Alpha Vantage key for the earnings calendar (free plan: 25 requests/day; we use ≤ 2). */
  ALPHAVANTAGE_API_KEY: z
    .string()
    .min(1)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /**
   * Resend API key. When set, email goes out over Resend's HTTPS API (works on Railway, which
   * blocks outbound SMTP on the Hobby plan); otherwise Gmail SMTP below is used.
   */
  RESEND_API_KEY: z
    .string()
    .min(1)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** Sender for Resend. Without a verified domain, only onboarding@resend.dev works. */
  RESEND_FROM: z.string().min(3).default('AI Investment Analyst <onboarding@resend.dev>'),
  /** Gmail account that sends alerts (smtp.gmail.com), used when RESEND_API_KEY is not set. */
  GMAIL_USER: z
    .email()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** Gmail app password (16 chars; spaces as shown by Google are removed). Never logged. */
  GMAIL_APP_PASSWORD: z
    .string()
    .transform((v) => v.replace(/\s+/g, ''))
    .optional(),
  /** Comma-separated recipients. */
  ALERT_EMAIL_TO: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.email())),
});

export type Env = z.infer<typeof schema>;

/**
 * Strips one pair of matching surrounding quotes. .env files are unquoted by Node, but values
 * pasted into a dashboard (or passed via docker --env-file) keep quotes literally.
 */
export function unquote(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const m = /^(["'])([\s\S]*)\1$/.exec(value.trim());
  return m ? m[2] : value.trim();
}

/** Loads the repo-root .env when present (local dev); Railway provides real env vars. */
export function loadEnv(): Env {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  } catch {
    // no .env file
  }
  const parsed = schema.safeParse(
    Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, unquote(v)])),
  );
  if (!parsed.success) {
    // Report variable names only, never values.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n  ${problems.join('\n  ')}`);
  }
  return parsed.data;
}
