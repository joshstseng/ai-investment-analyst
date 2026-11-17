import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedAssessment } from '../health/assess';
import { byDayMoveDesc, digestDue } from './digest';
import { feedTransitions } from './health-alerts';
import {
  createGmailMailer,
  createMailer,
  createResendMailer,
  isTransientSmtpError,
  redact,
  SEND_RETRY_DELAYS_MS,
} from './mailer';

const PASSWORD = 'abcdefghijklmnop';

/** Scripted SMTP results, consumed one per sendMail call ('ok' or an error spec). */
const smtp = vi.hoisted(() => ({
  script: [] as ('ok' | { code: string; responseCode?: number; message?: string })[],
  calls: 0,
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async () => {
        smtp.calls++;
        const next = smtp.script.shift() ?? 'ok';
        if (next === 'ok') return { messageId: '<id@test>' };
        const e = new Error(next.message ?? next.code) as Error & {
          code: string;
          responseCode?: number;
        };
        e.code = next.code;
        if (next.responseCode !== undefined) e.responseCode = next.responseCode;
        throw e;
      },
    }),
  },
}));

const ENV = {
  GMAIL_USER: 'me@example.com',
  GMAIL_APP_PASSWORD: PASSWORD,
  ALERT_EMAIL_TO: ['me@example.com'],
};

function mailerWithFakeClock() {
  const waits: number[] = [];
  const mailer = createGmailMailer(ENV, {
    wait: async (ms) => {
      waits.push(ms);
    },
  })!;
  return { mailer, waits };
}

const failure = (p: Promise<unknown>) =>
  p.then(
    () => new Error('expected the send to fail'),
    (e: unknown) => e as Error,
  );

describe('password safety', () => {
  beforeEach(() => {
    smtp.script = [];
    smtp.calls = 0;
  });

  it('redacts the app password with and without spaces', () => {
    expect(redact(`a ${PASSWORD} b abcd efgh ijkl mnop c`, PASSWORD)).toBe('a *** b *** c');
  });

  it('never surfaces the password from a send error', async () => {
    smtp.script = [
      {
        code: 'EAUTH',
        responseCode: 535,
        message: `Invalid login pass ${PASSWORD} (abcd efgh ijkl mnop)`,
      },
    ];
    const err = await failure(mailerWithFakeClock().mailer.send({ subject: 's', text: 't' }));
    expect(err.message).toContain('EAUTH 535');
    expect(err.message).not.toContain(PASSWORD);
    expect(err.message).not.toContain('abcd efgh');
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('is disabled (null) unless user, password and recipients are all set', () => {
    expect(createGmailMailer({ ...ENV, ALERT_EMAIL_TO: [] })).toBeNull();
    expect(createGmailMailer({ ...ENV, GMAIL_USER: undefined })).toBeNull();
  });
});

describe('send retries (temporary failures only)', () => {
  beforeEach(() => {
    smtp.script = [];
    smtp.calls = 0;
  });

  it('retries a connection timeout and succeeds on the 3rd attempt (5 s, then 20 s)', async () => {
    smtp.script = [
      { code: 'ETIMEDOUT', message: 'Connection timeout' },
      { code: 'ETIMEDOUT' },
      'ok',
    ];
    const { mailer, waits } = mailerWithFakeClock();
    await expect(mailer.send({ subject: 's', text: 't' })).resolves.toEqual({
      messageId: '<id@test>',
    });
    expect(smtp.calls).toBe(3);
    expect(waits).toEqual([...SEND_RETRY_DELAYS_MS]);
  });

  it('gives up after 3 attempts and says so (the outbox retries later)', async () => {
    smtp.script = [{ code: 'ETIMEDOUT' }, { code: 'ECONNECTION' }, { code: 'ESOCKET' }];
    const err = await failure(mailerWithFakeClock().mailer.send({ subject: 's', text: 't' }));
    expect(smtp.calls).toBe(3);
    expect(err.message).toContain('(after 3 attempts)');
  });

  it('retries Gmail "try again later" (421) but not a wrong password (535)', async () => {
    smtp.script = [{ code: 'EENVELOPE', responseCode: 421 }, 'ok'];
    await mailerWithFakeClock().mailer.send({ subject: 's', text: 't' });
    expect(smtp.calls).toBe(2);

    smtp.calls = 0;
    smtp.script = [{ code: 'EAUTH', responseCode: 535 }];
    await failure(mailerWithFakeClock().mailer.send({ subject: 's', text: 't' }));
    expect(smtp.calls).toBe(1);
  });

  it.each<[string, { code?: string; responseCode?: number }, boolean]>([
    ['connection timeout', { code: 'ETIMEDOUT' }, true],
    ['connection refused/failed', { code: 'ECONNECTION' }, true],
    ['DNS failure', { code: 'EDNS' }, true],
    ['421 service not available', { code: 'EENVELOPE', responseCode: 421 }, true],
    ['451 local error', { code: 'EMESSAGE', responseCode: 451 }, true],
    ['535 bad credentials', { code: 'EAUTH', responseCode: 535 }, false],
    ['550 recipient rejected', { code: 'EENVELOPE', responseCode: 550 }, false],
    ['auth error without a code', { code: 'EAUTH' }, false],
  ])('%s → retry %s', (_name, e, expected) => {
    expect(isTransientSmtpError(e)).toBe(expected);
  });
});

describe('feed-health emails: only failures and recoveries', () => {
  const a = (feed: string, status: FeedAssessment['status']): FeedAssessment => ({
    feed,
    status,
    detail: 'd',
    okNow: status === 'ok',
  });
  it.each<[string, string | undefined, FeedAssessment['status'], string | null]>([
    ['ok → down', 'ok', 'down', 'failure'],
    ['first ever check, down', undefined, 'down', 'failure'],
    ['ok → degraded', 'ok', 'degraded', 'failure'],
    ['degraded → down (still failing)', 'degraded', 'down', null],
    ['down → down', 'down', 'down', null],
    ['down → ok', 'down', 'ok', 'recovery'],
    ['ok → ok', 'ok', 'ok', null],
    ['disabled stays quiet', 'ok', 'disabled', null],
  ])('%s', (_name, prev, next, expected) => {
    const map = new Map(prev ? [['f', prev as FeedAssessment['status']]] : []);
    const t = feedTransitions(map, [a('f', next)]);
    expect(t[0]?.kind ?? null).toBe(expected);
  });
});

describe('daily digest', () => {
  const sessions = ['2026-11-24', '2026-11-25', '2026-11-27', '2026-11-30'];
  it.each<[string, string, string | null, string | null]>([
    ['Wed 2:14 PM PT → not yet', '2026-11-25T22:14:00Z', '2026-11-24', null],
    ['Wed 2:15 PM PT → due', '2026-11-25T22:15:00Z', '2026-11-24', '2026-11-25'],
    ['already sent today', '2026-11-25T23:00:00Z', '2026-11-25', null],
    ['Thanksgiving → no digest', '2026-11-26T22:30:00Z', '2026-11-25', null],
    ['early-close Friday still at 2:15 PM PT', '2026-11-27T22:15:00Z', '2026-11-25', '2026-11-27'],
  ])('%s', (_name, now, last, expected) => {
    expect(digestDue(sessions, new Date(now), last)).toBe(expected);
  });
});

describe('Resend (HTTPS) mailer', () => {
  const KEY = 're_test_secret_key_123';
  const env = {
    RESEND_API_KEY: KEY,
    RESEND_FROM: 'AI Investment Analyst <onboarding@resend.dev>',
    ALERT_EMAIL_TO: ['me@example.com'],
  };
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const noWait = async () => {};

  it('posts the email with auth and an idempotency key, and returns the id', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => reply(200, { id: 'em_123' }));
    const mailer = createResendMailer(env, { fetchImpl, wait: noWait })!;
    await expect(
      mailer.send({
        subject: '[AIA] TEST',
        text: 't',
        html: '<p>t</p>',
        idempotencyKey: 'aia-rule:1:2026-11-13',
      }),
    ).resolves.toEqual({ messageId: 'em_123' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init!.method).toBe('POST');
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['Idempotency-Key']).toBe('aia-rule:1:2026-11-13');
    expect(JSON.parse(init!.body as string)).toEqual({
      from: env.RESEND_FROM,
      to: ['me@example.com'],
      subject: '[AIA] TEST',
      text: 't',
      html: '<p>t</p>',
    });
  });

  it('retries rate limits and server errors, then succeeds', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply(429, { message: 'Too many requests' }))
      .mockResolvedValueOnce(reply(503, { message: 'unavailable' }))
      .mockResolvedValueOnce(reply(200, { id: 'em_2' }));
    const mailer = createResendMailer(env, { fetchImpl, wait: noWait })!;
    await expect(mailer.send({ subject: 's', text: 't' })).resolves.toEqual({ messageId: 'em_2' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails fast on a rejected request (e.g. sending to an unverified address) without leaking the key', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      reply(403, {
        statusCode: 403,
        name: 'validation_error',
        message: `You can only send testing emails to your own email address. key=${KEY}`,
      }),
    );
    const mailer = createResendMailer(env, { fetchImpl, wait: noWait })!;
    const err = await failure(mailer.send({ subject: 's', text: 't' }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(err.message).toContain('HTTP 403');
    expect(err.message).toContain('only send testing emails to your own email address');
    expect(err.message).not.toContain(KEY);
  });

  it('is chosen over Gmail when RESEND_API_KEY is set', () => {
    expect(createMailer({ ...ENV, ...env })!.provider).toBe('resend');
    expect(
      createMailer({ ...ENV, RESEND_API_KEY: undefined, RESEND_FROM: env.RESEND_FROM })!.provider,
    ).toBe('gmail');
    expect(
      createMailer({
        ...ENV,
        GMAIL_USER: undefined,
        RESEND_API_KEY: undefined,
        RESEND_FROM: env.RESEND_FROM,
      }),
    ).toBeNull();
  });
});

describe('digest positions order', () => {
  it('sorts by day % descending, no-data positions last, ties alphabetical', () => {
    const rows = [
      { display: 'ACMX', dayPct: -3.2 },
      { display: 'NODT', dayPct: null },
      { display: 'BKX', dayPct: 4.1 },
      { display: 'ETFX', dayPct: 0.5 },
      { display: 'AAAX', dayPct: null },
      { display: 'CCCX', dayPct: 0.5 },
    ];
    expect(rows.sort(byDayMoveDesc).map((r) => r.display)).toEqual([
      'BKX',
      'CCCX',
      'ETFX',
      'ACMX',
      'AAAX',
      'NODT',
    ]);
  });
});
