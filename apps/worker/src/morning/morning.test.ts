import { describe, expect, it } from 'vitest';
import { calendarRow } from '../market/calendar';
import type { CalSession } from '../schedule/market';
import type { MorningData } from './gather';
import { morningSubject, renderMorning } from './render';
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

function data(over: Partial<MorningData> = {}, now = at545('2026-11-24')): MorningData {
  return {
    window: morningWindow(SESSIONS, now),
    generatedAt: now,
    alerts: [],
    econ: { available: true, items: [] },
    filings: [],
    headlines: [],
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

describe('renderMorning', () => {
  it('subject counts alerts, filings and levels; recap and closed have their own subjects', () => {
    expect(morningSubject(data())).toBe(
      '[AIA] MORNING Tue, Nov 24: 0 alerts, 0 filings, 0 levels to watch',
    );
    expect(
      morningSubject(
        data({
          alerts: [
            {
              subject: '[AIA] REVIEW ACMX: new closing low',
              createdAt: at545('2026-11-24'),
              sent: true,
            },
          ],
          levels: [
            {
              display: 'ETFX',
              instrumentSymbol: 'ETFX',
              evaluatedSymbol: 'ETFX',
              kind: 'drawdown_tier',
              label: '15% drawdown tier',
              level: 111.06,
              close: 111.18,
              distancePct: 0.11,
              distanceDollars: 0.12,
              direction: 'down',
              status: 'PLACEHOLDER',
            },
          ],
          filings: [
            {
              ticker: 'ACMX',
              held: true,
              items: [
                {
                  form: '8-K',
                  label: '8-K: results of operations',
                  dilution: false,
                  filedAt: at545('2026-11-24'),
                  url: 'https://x',
                },
              ],
              insiderTrades: [],
              otherInsiderFilings: 2,
              otherCodes: { A: 2 },
            },
          ],
        }),
      ),
    ).toBe('[AIA] MORNING Tue, Nov 24: 1 alert, 3 filings, 1 level to watch');
    expect(morningSubject(data({}, at545('2026-11-23')))).toBe(
      '[AIA] MORNING Mon, Nov 23: weekend recap + week ahead',
    );
    expect(morningSubject(data({}, at545('2026-11-26')))).toBe(
      '[AIA] MORNING Thu, Nov 26: market closed',
    );
  });

  it('always shows alerts ("none"), skips other empty sections, ends with feed health', () => {
    const { text } = renderMorning(data());
    expect(text).toContain('OVERNIGHT ALERTS\n- none');
    expect(text).not.toContain('NEW SEC FILINGS');
    expect(text).not.toContain('HEADLINES');
    expect(text).not.toContain('LEVELS TO WATCH');
    expect(text).toContain('FEED HEALTH\n- All 6 feeds OK.');
  });

  it('notes an early close in the header', () => {
    const { text, html } = renderMorning(data({}, at545('2026-11-27')));
    expect(text).toContain('opens 6:30 AM PT. EARLY CLOSE 10:00 AM PT.');
    expect(html).toContain('Early close 10:00 AM PT');
  });

  it('economic calendar: high impact first, "released — see brief" without an actual, actual only if provided', () => {
    const now = at545('2026-11-24');
    const { text } = renderMorning(
      data(
        {
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
        },
        now,
      ),
    );
    const econ = text.split('ECONOMIC CALENDAR TODAY\n')[1]!.split('\n\n')[0]!.split('\n');
    expect(econ).toEqual([
      '- 5:30 AM [High] Retail Sales m/m — forecast 0.2%, previous 0.8% — released 5:30 AM, see brief',
      '- 5:30 AM [High] GDP q/q — actual 2.4% (forecast 2.1%, previous 1.8%)',
      '- 7:00 AM [Medium] Home Sales — forecast 4.1M, previous 4.0M',
    ]);
    expect(renderMorning(data({ econ: { available: false, items: [] } })).text).toContain(
      'ECONOMIC CALENDAR TODAY\n- unavailable',
    );
  });

  it('holiday version: market closed, next open, upcoming events and feed health only', () => {
    const { text } = renderMorning(
      data(
        {
          upcoming: {
            available: { earnings: true, lastFetched: '2026-11-25' },
            items: [
              {
                date: '2026-12-01',
                ticker: 'ACMX',
                eventType: 'earnings',
                title: 'Earnings',
                timeOfDay: 'after_close',
                estimated: false,
                confirmed: true,
                source: 'alphavantage',
                previousDate: '2026-11-30',
                note: null,
              },
            ],
          },
          headlines: [
            {
              ticker: 'ACMX',
              held: true,
              items: [
                {
                  headline: 'h',
                  source: 'Benzinga',
                  url: null,
                  publishedAt: at545('2026-11-26'),
                  also: [],
                },
              ],
              more: 0,
            },
          ],
        },
        at545('2026-11-26'),
      ),
    );
    expect(text).toContain('Market closed today. Next session Fri, Nov 27, opens 6:30 AM PT.');
    expect(text).toContain(
      'Tue, 12/1 ACMX earnings after close (confirmed): Earnings — moved from Mon, 11/30 [Alpha Vantage]',
    );
    expect(text).not.toContain('HEADLINES');
    expect(text).not.toContain('PRE-MARKET');
    expect(text).toContain('FEED HEALTH');
  });

  it('formats levels with % and $ to two decimals and marks non-confirmed rules', () => {
    const { text } = renderMorning(
      data({
        levels: [
          {
            display: 'ETFX',
            instrumentSymbol: 'ETFX',
            evaluatedSymbol: 'ETFX',
            kind: 'drawdown_tier',
            label: '15% drawdown tier',
            level: 111.06,
            close: 111.18,
            distancePct: 0.11,
            distanceDollars: 0.12,
            direction: 'down',
            status: 'PLACEHOLDER',
          },
        ],
      }),
    );
    expect(text).toContain(
      '- ETFX: 15% drawdown tier $111.06 — 0.11% / $0.12 above (close $111.18) [placeholder]',
    );
  });
});
