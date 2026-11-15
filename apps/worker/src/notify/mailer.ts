/**
 * Email transports:
 * - Resend over HTTPS (used when RESEND_API_KEY is set; required on Railway, whose Hobby plan
 *   blocks outbound SMTP ports)
 * - Gmail over SMTPS (smtp.gmail.com:465) with an app password via nodemailer (local fallback)
 * Credentials are never logged: every error text that leaves this module is redacted.
 */
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { HttpError, requestJson } from '../lib/http';
import type { Env } from '../env';

export interface EmailMessage {
  subject: string;
  text: string;
  html?: string;
  /** Same key on every retry of one alert, so a provider that supports it never sends twice. */
  idempotencyKey?: string;
}

export interface Mailer {
  /** 'resend' or 'gmail', for logs. */
  readonly provider: string;
  readonly from: string;
  readonly to: readonly string[];
  send(msg: EmailMessage): Promise<{ messageId: string }>;
}

/** Replaces every occurrence of the secret (with or without Google's spaces) with ***. */
export function redact(text: string, secret: string | undefined): string {
  if (!secret) return text;
  let out = text.split(secret).join('***');
  // Google displays app passwords in groups of four ("abcd efgh ijkl mnop").
  const spaced = secret.match(/.{1,4}/g)?.join(' ');
  if (spaced && spaced !== secret) out = out.split(spaced).join('***');
  return out;
}

export class MailerNotConfigured extends Error {
  override name = 'MailerNotConfigured';
}

/** Delays before the 2nd and 3rd attempt of one send (temporary failures only). */
export const SEND_RETRY_DELAYS_MS = [5_000, 20_000] as const;

const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNECTION',
  'ESOCKET',
  'EDNS',
  'ECONNRESET',
  'EPIPE',
]);

/**
 * Temporary failures worth retrying: network/connection problems and SMTP 4xx replies
 * (e.g. 421 "try again later"). Auth failures (EAUTH / 535) and other 5xx are permanent.
 */
export function isTransientSmtpError(e: { code?: string; responseCode?: number }): boolean {
  if (e.code === 'EAUTH') return false;
  if (e.responseCode !== undefined) return e.responseCode >= 400 && e.responseCode < 500;
  return e.code !== undefined && TRANSIENT_CODES.has(e.code);
}

export function createGmailMailer(
  env: Pick<Env, 'GMAIL_USER' | 'GMAIL_APP_PASSWORD' | 'ALERT_EMAIL_TO'>,
  opts: {
    wait?: (ms: number) => Promise<void>;
    onRetry?: (info: { attempt: number; delayMs: number; error: string }) => void;
  } = {},
): Mailer | null {
  const user = env.GMAIL_USER;
  const pass = env.GMAIL_APP_PASSWORD;
  const to = env.ALERT_EMAIL_TO;
  if (!user || !pass || to.length === 0) return null;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // No connection pool: every attempt opens a fresh connection, so a retry never reuses a
  // connection that just timed out.
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
    logger: false,
    debug: false,
  });

  /** Error text with the password removed; the original object is never rethrown. */
  const describe = (error: unknown) => {
    const e = error as { message?: string; code?: string; responseCode?: number };
    return redact(
      `email send failed${e.code ? ` (${e.code}${e.responseCode ? ` ${e.responseCode}` : ''})` : ''}: ${e.message ?? String(error)}`,
      pass,
    );
  };

  return {
    provider: 'gmail',
    from: user,
    to,
    async send(msg) {
      for (let attempt = 0; ; attempt++) {
        try {
          const info = await transport.sendMail({
            from: `AI Investment Analyst <${user}>`,
            to: to.join(', '),
            subject: msg.subject,
            text: msg.text,
            html: msg.html,
          });
          return { messageId: info.messageId };
        } catch (error) {
          const e = error as { code?: string; responseCode?: number };
          const delayMs = SEND_RETRY_DELAYS_MS[attempt];
          if (delayMs !== undefined && isTransientSmtpError(e)) {
            opts.onRetry?.({ attempt: attempt + 1, delayMs, error: describe(error) });
            await wait(delayMs);
            continue;
          }
          // Don't attach the original as `cause`: it may carry the credentials.
          // eslint-disable-next-line preserve-caught-error
          throw new Error(
            attempt > 0 ? `${describe(error)} (after ${attempt + 1} attempts)` : describe(error),
          );
        }
      }
    },
  };
}

const resendResponse = z.object({ id: z.string() });

/** Resend over HTTPS. Retries (inside requestJson) cover timeouts, 429 and 5xx; 4xx fail fast. */
export function createResendMailer(
  env: Pick<Env, 'RESEND_API_KEY' | 'RESEND_FROM' | 'ALERT_EMAIL_TO'>,
  opts: {
    fetchImpl?: typeof fetch;
    wait?: (ms: number) => Promise<void>;
    onRetry?: (info: { attempt: number; delayMs: number; error: string }) => void;
  } = {},
): Mailer | null {
  const key = env.RESEND_API_KEY;
  const to = env.ALERT_EMAIL_TO;
  if (!key || to.length === 0) return null;
  return {
    provider: 'resend',
    from: env.RESEND_FROM,
    to,
    async send(msg) {
      try {
        const res = await requestJson('https://api.resend.com/emails', {
          method: 'POST',
          schema: resendResponse,
          headers: {
            Authorization: `Bearer ${key}`,
            ...(msg.idempotencyKey ? { 'Idempotency-Key': msg.idempotencyKey.slice(0, 256) } : {}),
          },
          body: {
            from: env.RESEND_FROM,
            to: [...to],
            subject: msg.subject,
            text: msg.text,
            html: msg.html,
          },
          timeoutMs: 30_000,
          retries: SEND_RETRY_DELAYS_MS.length,
          baseDelayMs: SEND_RETRY_DELAYS_MS[0],
          maxDelayMs: SEND_RETRY_DELAYS_MS[1],
          fetchImpl: opts.fetchImpl,
          wait: opts.wait,
          onRetry: ({ attempt, delayMs, error }) =>
            opts.onRetry?.({ attempt: attempt + 1, delayMs, error: redact(String(error), key) }),
        });
        return { messageId: res.id };
      } catch (error) {
        const status = error instanceof HttpError ? ` (HTTP ${error.status})` : '';
        // eslint-disable-next-line preserve-caught-error
        throw new Error(redact(`email send failed via Resend${status}: ${String(error)}`, key));
      }
    },
  };
}

/** Resend when RESEND_API_KEY is set, otherwise Gmail SMTP; null if neither is configured. */
export function createMailer(
  env: Pick<
    Env,
    'RESEND_API_KEY' | 'RESEND_FROM' | 'GMAIL_USER' | 'GMAIL_APP_PASSWORD' | 'ALERT_EMAIL_TO'
  >,
  opts: { onRetry?: (info: { attempt: number; delayMs: number; error: string }) => void } = {},
): Mailer | null {
  return createResendMailer(env, opts) ?? createGmailMailer(env, opts);
}
