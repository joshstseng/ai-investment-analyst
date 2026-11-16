import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedAssessment } from '../health/assess';
import { byDayMoveDesc, digestDue, renderDigest, type DigestData } from './digest';
import { composeHealthAlert, feedTransitions } from './health-alerts';
import {
  createGmailMailer,
  createMailer,
  createResendMailer,
  isTransientSmtpError,
  redact,
  SEND_RETRY_DELAYS_MS,
} from './mailer';
import { composeRuleAlert, type RuleAlertInput } from './rule-alerts';

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

  it('formats HEALTH subjects', () => {
    const now = new Date('2026-11-25T19:00:00Z');
    expect(
      composeHealthAlert(
        { feed: 'alpaca_quotes', kind: 'failure', from: 'ok', to: 'down', detail: 'x' },
        now,
      ).subject,
    ).toBe('[AIA] HEALTH Quotes (Alpaca): down');
    expect(
      composeHealthAlert(
        { feed: 'sec_edgar', kind: 'recovery', from: 'down', to: 'ok', detail: 'x' },
        now,
      ).subject,
    ).toBe('[AIA] HEALTH SEC EDGAR filings: recovered');
  });
});

describe('rule alert email', () => {
  const base: RuleAlertInput = {
    tag: 'ACTION',
    display: 'BKX',
    instrumentSymbol: 'BKX',
    evaluatedSymbol: 'BKX',
    ruleType: 'stop_close_below',
    status: 'CONFIRMED',
    purpose: 'risk_stop',
    outcome: {
      kind: 'fired',
      severity: 'critical',
      level: 'stop',
      message: 'BKX closed at $96.00, below the $96.28 stop',
      observed: {},
      track: { kind: 'state', rank: 2, direction: 'down', price: 96 },
    },
    reason: 'first',
    alertNote: 'Exit all.',
    judgment: null,
    lots: [{ account: 'roth_ira', quantity: '5', avgCost: '61.03', needsConfirmation: true }],
    asOfDate: '2026-11-25',
    now: new Date('2026-11-25T21:20:00Z'),
  };

  it('prefixes [AIA] and the severity, and includes plan, position and as-of', () => {
    const m = composeRuleAlert(base);
    expect(m.subject).toBe('[AIA] ACTION BKX: closed below stop');
    expect(m.text).toContain('Plan: Exit all.');
    expect(m.text).toContain('Your position: Roth IRA 5 @ $61.03 (fill not yet confirmed)');
    expect(m.text).toContain('As of the 2026-11-25 close.');
    expect(m.html).toContain('<strong>BKX closed at $96.00');
  });

  it('marks escalations and labels option alerts with the underlying', () => {
    const m = composeRuleAlert({
      ...base,
      tag: 'REVIEW',
      display: 'OPTX Jun-16-2028 $45 call',
      instrumentSymbol: 'OPTX280616C00045000',
      evaluatedSymbol: 'OPTX',
      status: 'PLACEHOLDER',
      reason: 'escalation_move',
      detail: '$54.00 → $52.80',
    });
    expect(m.subject).toBe(
      '[AIA] REVIEW OPTX Jun-16-2028 $45 call: closed below stop (further move)',
    );
    expect(m.text).toContain('moved a further 2%+ since the last alert ($54.00 → $52.80)');
    expect(m.text).toContain('evaluated on the underlying OPTX');
  });

  it('uses the alert note as the reminder subject', () => {
    const m = composeRuleAlert({
      ...base,
      tag: 'REMINDER',
      display: 'OTCX',
      ruleType: 'date_reminder',
      outcome: { ...base.outcome, level: 'reminder', track: { kind: 'event' } },
      reason: 'event',
      alertNote: 'Decide whether to sell before year end.',
    });
    expect(m.subject).toBe('[AIA] REMINDER OTCX: Decide whether to sell before year end.');
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

  const data = (weekly: boolean): DigestData => ({
    date: '2026-11-27',
    generatedAt: new Date('2026-11-27T22:15:00Z'),
    since: new Date('2026-11-25T22:15:00Z'),
    until: new Date('2026-11-27T22:15:00Z'),
    weekly,
    positions: [
      {
        display: 'ACMX',
        symbol: 'ACMX',
        evaluatedSymbol: 'ACMX',
        isOption: false,
        noData: false,
        close: 209.64,
        dayPct: -0.9,
        lots: [
          {
            account: 'roth_ira',
            quantity: 10,
            avgCost: 174.71,
            pctVsCost: 20.0,
            unconfirmed: false,
          },
          {
            account: 'individual_taxable',
            quantity: 7,
            avgCost: 212.52,
            pctVsCost: -1.4,
            unconfirmed: false,
          },
        ],
        stop: null,
        takeProfit: null,
      },
      {
        display: 'OTCX',
        symbol: 'OTCX',
        evaluatedSymbol: 'OTCX',
        isOption: false,
        noData: true,
        close: null,
        dayPct: null,
        lots: [
          {
            account: 'individual_taxable',
            quantity: 50,
            avgCost: 3.02,
            pctVsCost: null,
            unconfirmed: false,
          },
        ],
        stop: null,
        takeProfit: null,
      },
    ],
    active: [
      {
        display: 'ETFX',
        level: 'drawdown_10',
        status: 'PLACEHOLDER',
        firstFiredOn: '2026-11-13',
        message: 'ETFX 12.0% below',
      },
    ],
    alertsToday: [],
    notChecked: [{ reason: 'no data source', items: ['OTCX stop_close_below'] }],
    filings: [],
    headlines: [
      {
        ticker: 'ACMX',
        items: [{ headline: 'Acme Medical news', url: 'https://x', publishedAt: new Date() }],
        more: 3,
      },
    ],
    feedIssues: [],
    rulesToWrite: [{ display: 'AAAX', purposes: ['risk stop', 'take profit'] }],
    needsInput: ['BKX (Roth IRA): confirm the fill'],
  });

  it('renders every daily section, with lots vs cost and not-checked reasons', () => {
    const m = renderDigest(data(false));
    expect(m.subject).toBe('[AIA] DIGEST Fri, Nov 27: 1 active condition');
    expect(m.text).toContain(
      'ACMX: $209.64 -0.9% | Roth IRA 10 @ $174.71 (+20.0%) · Individual 7 @ $212.52 (-1.4%)',
    );
    expect(m.text).toContain('OTCX: not checked: no data source');
    expect(m.text).toContain('- no data source: OTCX stop_close_below');
    expect(m.text).toContain('(+3 more)');
    expect(m.text).not.toContain('RULES TO WRITE');
  });

  it('adds rules to write and missing input on the last session of the week', () => {
    const m = renderDigest(data(true));
    expect(m.text).toContain('WEEKLY: RULES TO WRITE');
    expect(m.text).toContain('- AAAX: risk stop, take profit');
    expect(m.text).toContain('- BKX (Roth IRA): confirm the fill');
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
