import { MAX_HTML_BYTES } from '@aia/emails';
import { describe, expect, it } from 'vitest';
import { calendarRow } from '../market/calendar';
import type { CalSession } from '../schedule/market';
import type { MorningData } from './gather';
import { morningEmailProps, morningPreviewText, morningSubject, renderMorning } from './render';
import { morningDueDate, morningWindow } from './window';

const s = (date: string, close = '16:00'): CalSession => {
  const r = calendarRow({ date, open: '09:30', close });
  return { date, openAt: r.openAt, closeAt: r.closeAt, earlyClose: r.earlyClose };
};
// Mon 11/23 – Mon 11/30 2026: Thanksgiving Thu 11/26 closed, Fri 11/27 early close.
// Also a made-up week where Monday 12/7 is treated as a holiday (no session).
const SESSIONS = [
  s('2026-11-20'),
  s('2026-11-23'),
  s('2026-11-24'),
  s('2026-11-25'),
  s('2026-11-27', '13:00'),
  s('2026-11-30'),
  s('2026-12-01'),
  s('2026-12-04'),
  s('2026-12-08'),
];
const at545 = (date: string) => new Date(`${date}T13:45:00Z`); // 5:45 AM PST

describe('morningWindow', () => {
  it('Monday: weekend recap, window from Friday 1:00 PM PT', () => {
    const w = morningWindow(SESSIONS, at545('2026-11-23'));
    expect(w).toMatchObject({ today: '2026-11-23', recap: true, closed: false });
    expect(w.prev!.date).toBe('2026-11-20');
    expect(w.start.toISOString()).toBe('2026-11-20T21:00:00.000Z');
  });

  it('Tuesday–Friday: window from the previous trading day close, no recap', () => {
    const w = morningWindow(SESSIONS, at545('2026-11-24'));
    expect(w).toMatchObject({ recap: false, closed: false });
    expect(w.start.toISOString()).toBe('2026-11-23T21:00:00.000Z');
  });

  it('after a holiday: the window covers it (Fri after Thanksgiving starts at Wed close)', () => {
    const w = morningWindow(SESSIONS, at545('2026-11-27'));
    expect(w.prev!.date).toBe('2026-11-25');
    expect(w.start.toISOString()).toBe('2026-11-25T21:00:00.000Z');
    expect(w.session!.earlyClose).toBe(true);
    expect(w.recap).toBe(false);
  });

  it('the Monday after an early-close Friday starts at that early close', () => {
    const w = morningWindow(SESSIONS, at545('2026-11-30'));
    expect(w.start.toISOString()).toBe('2026-11-27T18:00:00.000Z'); // 10:00 AM PT
    expect(w.recap).toBe(true);
  });

  it('Monday holiday: closed version Monday, recap moves to Tuesday', () => {
    const mon = morningWindow(SESSIONS, at545('2026-12-07'));
    expect(mon).toMatchObject({ closed: true, recap: false });
    expect(mon.next!.date).toBe('2026-12-08');
    const tue = morningWindow(SESSIONS, at545('2026-12-08'));
    expect(tue).toMatchObject({ closed: false, recap: true });
    expect(tue.prev!.date).toBe('2026-12-04');
  });

  it('holiday (Thanksgiving): closed version with the next session', () => {
    const w = morningWindow(SESSIONS, at545('2026-11-26'));
    expect(w).toMatchObject({ closed: true, recap: false });
    expect(w.next!.date).toBe('2026-11-27');
  });
});

describe('morningDueDate (5:45 AM PT, weekdays, once a day)', () => {
  it.each<[string, string, string | null, string | null]>([
    ['5:44 AM PT → not yet', '2026-11-24T13:44:00Z', '2026-11-23', null],
    ['5:45 AM PT → due', '2026-11-24T13:45:00Z', '2026-11-23', '2026-11-24'],
    ['already sent today', '2026-11-24T15:00:00Z', '2026-11-24', null],
    ['Saturday → never', '2026-11-28T14:00:00Z', '2026-11-27', null],
    [
      'Thanksgiving (weekday holiday) → due (closed version)',
      '2026-11-26T13:50:00Z',
      '2026-11-25',
      '2026-11-26',
    ],
    ['catch-up after a restart at 9 AM', '2026-11-24T17:00:00Z', '2026-11-23', '2026-11-24'],
    ['summer (PDT): 5:45 AM PT is 12:45Z', '2026-07-01T12:45:00Z', '2026-06-30', '2026-07-01'],
  ])('%s', (_name, now, last, expected) => {
    const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    expect(morningDueDate(new Date(now), last, today)).toBe(expected);
  });
});

const NO_HEADLINES = {
  shown: [],
  more: 0,
  filtered: { count: 0, example: null },
  watchlist: { counts: [], top: null },
};

function data(over: Partial<MorningData> = {}, now = at545('2026-11-24')): MorningData {
  return {
    window: morningWindow(SESSIONS, now),
    generatedAt: now,
    alerts: [],
    econ: { available: true, items: [] },
    filings: [],
    headlines: NO_HEADLINES,
    premarket: { available: false, feed: null, asOf: null, quotes: [], note: null },
    levels: [],
    active: [],
    upcoming: { available: { earnings: true, lastFetched: '2026-11-24' }, items: [] },
    lastWeek: null,
    pastWeekAlerts: null,
    health: { ok: 6, issues: [] },
    ...over,
  };
}

const level = {
  display: 'ETFX',
  instrumentSymbol: 'ETFX',
  evaluatedSymbol: 'ETFX',
  kind: 'drawdown_tier' as const,
  label: '15% drawdown tier',
  level: 85,
  close: 85.09,
  distancePct: 0.11,
  distanceDollars: 0.09,
  direction: 'down' as const,
  status: 'PLACEHOLDER' as const,
};

const earnings = (date: string, ticker: string, over = {}) => ({
  date,
  ticker,
  eventType: 'earnings',
  title: 'Q3 results',
  timeOfDay: 'after_close',
  estimated: false,
  confirmed: true,
  source: 'alphavantage',
  previousDate: null,
  note: null,
  ...over,
});

/** A busy, made-up Tuesday: alerts, filings, econ releases, pre-market, levels, earnings. */
function busyDay(): MorningData {
  return data({
    alerts: [
      {
        subject: '📝 [AIA] REVIEW ETFX: down 15%+ from 52-week high',
        createdAt: new Date('2026-11-23T21:20:00Z'),
        sent: true,
      },
      {
        subject: '⚠️ [AIA] WARNING CNFX: at warning level',
        createdAt: new Date('2026-11-23T21:20:00Z'),
        sent: false,
      },
    ],
    econ: {
      available: true,
      items: [
        {
          at: new Date('2026-11-24T15:00:00Z'),
          allDay: false,
          impact: 'Medium',
          title: 'Home Sales',
          forecast: '4.1M',
          previous: '4.0M',
          actual: null,
        },
        {
          at: new Date('2026-11-24T13:30:00Z'),
          allDay: false,
          impact: 'High',
          title: 'Retail Sales m/m',
          forecast: '0.2%',
          previous: '0.8%',
          actual: null,
        },
        {
          at: new Date('2026-11-24T13:30:00Z'),
          allDay: false,
          impact: 'High',
          title: 'GDP q/q',
          forecast: '2.1%',
          previous: '1.8%',
          actual: '2.4%',
        },
      ],
    },
    filings: [
      {
        ticker: 'ACMX',
        held: true,
        items: [
          {
            form: '8-K',
            items: ['2.02', '9.01'],
            label: '8-K: results of operations',
            dilution: false,
            filedAt: new Date('2026-11-23T21:06:00Z'),
            url: 'https://www.sec.gov/x1',
          },
        ],
        insiderTrades: [
          {
            owner: 'Jane Q Doe',
            role: 'CFO',
            code: 'S',
            lots: 2,
            shares: 5000,
            avgPrice: 51.1,
            value: 255500,
            firstDate: '2026-11-20',
            lastDate: '2026-11-21',
            plan10b51: true,
            url: 'https://www.sec.gov/x2',
          },
        ],
        otherInsiderFilings: 2,
        otherCodes: { A: 2, F: 1 },
      },
      {
        ticker: 'WTCH',
        held: false,
        items: [
          {
            form: 'S-3ASR',
            items: [],
            label: 'S-3ASR',
            dilution: true,
            filedAt: new Date('2026-11-23T22:00:00Z'),
            url: 'https://www.sec.gov/x3',
          },
        ],
        insiderTrades: [],
        otherInsiderFilings: 0,
        otherCodes: {},
      },
    ],
    premarket: {
      available: true,
      feed: 'sip',
      asOf: new Date('2026-11-24T13:29:00Z'),
      quotes: [
        { symbol: 'SPY', lastClose: 600, price: 603, changePct: 0.5 },
        { symbol: 'ETFX', lastClose: 85.09, price: 84.57, changePct: -0.61 },
        { symbol: 'OTCQ', lastClose: null, price: null, changePct: null },
      ] as MorningData['premarket']['quotes'],
      note: null,
    },
    levels: [level],
    active: [
      {
        display: 'ETFX',
        level: 'drawdown_15',
        status: 'PLACEHOLDER',
        firstFiredOn: '2026-11-20',
        daysActive: 3,
        message: 'ETFX closed at $85.09, 15.2% below its 52-week high',
      },
    ],
    upcoming: {
      available: { earnings: true, lastFetched: '2026-11-24' },
      items: [
        earnings('2026-11-24', 'ACMX'),
        earnings('2026-11-26', 'BKX', {
          previousDate: '2026-11-25',
          source: 'seed',
          estimated: true,
          confirmed: false,
        }),
      ],
    },
  });
}

describe('morning email', () => {
  it('subjects: emoji, date, counts; recap and holiday versions', () => {
    expect(morningSubject(busyDay())).toBe(
      '☀️ [AIA] MORNING Tue, Nov 24 · 2 alerts · 5 filings · 1 level',
    );
    expect(morningSubject(data())).toBe(
      '☀️ [AIA] MORNING Tue, Nov 24 · 0 alerts · 0 filings · 0 levels',
    );
    expect(morningSubject(data({}, at545('2026-11-23')))).toBe(
      '🗓️ [AIA] MORNING Mon, Nov 23 · weekend recap + week ahead',
    );
    expect(morningSubject(data({}, at545('2026-11-26')))).toBe(
      '☀️ [AIA] MORNING Thu, Nov 26 · market closed',
    );
  });

  it('inbox preview: alerts, next high-impact release, earnings today, nearest level', () => {
    const d = busyDay();
    d.econ.items.push({
      at: new Date('2026-11-24T15:30:00Z'),
      allDay: false,
      impact: 'High',
      title: 'CPI m/m',
      forecast: null,
      previous: null,
      actual: null,
    });
    expect(morningPreviewText(d)).toBe(
      '2 alerts overnight · CPI m/m 7:30 AM · ACMX earnings after close · ETFX 0.1% above 15% tier',
    );
    expect(morningPreviewText(data())).toBe('Quiet morning: no alerts, filings or levels to watch');
    expect(morningPreviewText(data({}, at545('2026-11-26')))).toBe(
      'Market closed · next session Fri, Nov 27',
    );
  });

  it('header: today in the subtitle, early close called out; KPI tiles', () => {
    const p = morningEmailProps(busyDay());
    expect(p.title).toBe('☀️ Morning Brief');
    expect(p.subtitle).toBe('Tue, Nov 24 · opens 6:30 AM PT · closes 1:00 PM PT');
    expect(morningEmailProps(data({}, at545('2026-11-27'))).subtitle).toBe(
      'Fri, Nov 27 · opens 6:30 AM PT · EARLY CLOSE 10:00 AM PT',
    );
    expect(p.kpis.map((k) => [k.label, k.value, k.sub])).toEqual([
      ['Overnight alerts', '2', 'some not yet emailed'],
      ['Filings', '5', '1 earnings 8-K'],
      ['Levels', '1', 'to watch'],
      ['Earnings', '2', 'ACMX Tue, BKX Thu'],
    ]);
  });

  it('alerts are always shown ("None."), with severity and pending state', () => {
    expect(morningEmailProps(data()).alerts.items).toEqual([]);
    expect(morningEmailProps(busyDay()).alerts.items).toEqual([
      {
        time: 'Mon 1:20 PM',
        severity: 'review',
        text: 'ETFX: down 15%+ from 52-week high',
        pending: false,
      },
      { time: 'Mon 1:20 PM', severity: 'warning', text: 'CNFX: at warning level', pending: true },
    ]);
  });

  it('economic calendar: high impact first; "released, see brief" without an actual; never invents one', () => {
    const p = morningEmailProps(busyDay());
    expect(p.econ!.rows.map((r) => [r.time, r.impact, r.event, r.actual, r.status])).toEqual([
      ['5:30 AM', 'High', 'Retail Sales m/m', null, 'released 5:30 AM, see brief'],
      ['5:30 AM', 'High', 'GDP q/q', '2.4%', null],
      ['7:00 AM', 'Medium', 'Home Sales', null, null],
    ]);
    expect(morningEmailProps(data({ econ: { available: false, items: [] } })).econ).toMatchObject({
      available: false,
    });
    expect(morningEmailProps(data()).econ).toBeNull(); // nothing scheduled → section skipped
  });

  it('filings: plain-English titles, insider trades, other Form 4s, watchlist marked', () => {
    expect(morningEmailProps(busyDay()).filings).toEqual([
      {
        tickers: ['ACMX'],
        title: '8-K · results',
        href: 'https://www.sec.gov/x1',
        strong: true,
        detail: '(Item 2.02) · Mon 1:06 PM',
      },
      {
        tickers: ['ACMX'],
        title: 'Form 4 · open-market sale',
        href: 'https://www.sec.gov/x2',
        strong: true,
        detail: undefined,
        lines: ['Jane Q Doe (CFO) sold 5,000 sh @ $51.10 avg ($255,500) · 10b5-1 plan'],
      },
      {
        tickers: ['ACMX'],
        title: 'Form 4 · 2 insider filings, no open-market buys/sells',
        detail: '(grant/award ×2, shares withheld for tax ×1)',
      },
      {
        tickers: ['WTCH'],
        title: 'S-3ASR · possible share issuance',
        href: 'https://www.sec.gov/x3',
        strong: true,
        detail: 'Mon 2:00 PM · watchlist',
      },
    ]);
  });

  it('pre-market, levels, still-active, upcoming with source pills and date changes', () => {
    const p = morningEmailProps(busyDay());
    expect(p.premarket).toEqual({
      title: 'Pre-market · as of 5:29 AM PT (15-min delayed)',
      note: null,
      rows: [
        { symbol: 'SPY', close: '$600.00', pre: '$603.00 +0.50%', changePct: 0.5 },
        { symbol: 'ETFX', close: '$85.09', pre: '$84.57 −0.61%', changePct: -0.61 },
        { symbol: 'OTCQ', close: '—', pre: 'no data source', changePct: null },
      ],
    });
    expect(p.levels).toEqual(['ETFX $85.09, 0.1% above its $85.00 15% tier']);
    expect(p.active[0]).toMatchObject({
      ticker: 'ETFX',
      status: 'placeholder',
      since: '3 days active, since Nov 20',
    });
    expect(p.upcoming!.items).toEqual([
      {
        date: 'Tue 11/24',
        ticker: 'ACMX',
        what: 'earnings after close (confirmed)',
        title: 'Q3 results',
        moved: null,
        note: null,
        source: 'alphavantage',
        sourceTone: 'gain',
      },
      {
        date: 'Thu 11/26',
        ticker: 'BKX',
        what: 'earnings after close (estimated)',
        title: 'Q3 results',
        moved: 'moved from Wed 11/25',
        note: null,
        source: 'manual',
        sourceTone: 'neutral',
      },
    ]);
    expect(p.footer).toEqual([
      '🩺 All 6 feeds OK',
      'Covers Mon 1:00 PM → Tue 5:45 AM PT · generated Tue 5:45 AM PT',
    ]);
  });

  it('holiday version: closed header, alerts, upcoming and feed health only', () => {
    const p = morningEmailProps({
      ...busyDay(),
      window: morningWindow(SESSIONS, at545('2026-11-26')),
      generatedAt: at545('2026-11-26'),
    });
    expect(p.title).toBe('☀️ Market Closed');
    expect(p.subtitle).toBe(
      'Thu, Nov 26 · market closed · next session Fri, Nov 27, opens 6:30 AM PT',
    );
    expect(p).toMatchObject({
      econ: null,
      filings: [],
      headlines: null,
      premarket: null,
      levels: [],
      active: [],
    });
    expect(p.upcoming!.items).toHaveLength(2);
  });

  it('recap: last week and its alerts', () => {
    const p = morningEmailProps(
      data(
        {
          lastWeek: [
            { symbol: 'SPY', held: false, changePct: 2.6 },
            { symbol: 'ETFX', held: true, changePct: -4.2 },
          ],
          pastWeekAlerts: [
            {
              subject: '📝 [AIA] REVIEW ETFX: down 10%+ from 52-week high',
              createdAt: new Date('2026-11-18T21:20:00Z'),
            },
          ],
        },
        at545('2026-11-23'),
      ),
    );
    expect(p.title).toBe('🗓️ Weekend Recap + Week Ahead');
    expect(p.alerts.title).toBe('Alerts since Friday');
    expect(p.lastWeek).toEqual({
      rows: [
        { symbol: 'SPY', changePct: 2.6 },
        { symbol: 'ETFX', changePct: -4.2 },
      ],
      alerts: ['Wed 1:20 PM — REVIEW ETFX: down 10%+ from 52-week high'],
    });
  });

  it('renders email-safe HTML and text (snapshots)', async () => {
    const m = await renderMorning(busyDay());
    expect(m.html).not.toMatch(/<img|<svg|<script|<link[^>]+stylesheet/i);
    expect(Buffer.byteLength(m.html)).toBeLessThan(MAX_HTML_BYTES);
    expect(m.text).toContain('OVERNIGHT ALERTS\n- Mon 1:20 PM — ETFX: down 15%+ from 52-week high');
    await expect(m.html).toMatchFileSnapshot('./__snapshots__/morning.html');
    await expect(m.text).toMatchFileSnapshot('./__snapshots__/morning.txt');
    await expect(`${JSON.stringify(m.props, null, 2)}\n`).toMatchFileSnapshot(
      '../../../../packages/emails/preview/morning-sample.json',
    );
  });
});
