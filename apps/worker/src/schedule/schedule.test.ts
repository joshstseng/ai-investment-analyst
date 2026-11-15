import { Cron } from 'croner';
import { describe, expect, it } from 'vitest';
import { assessFeeds, type HealthSnapshot } from '../health/assess';
import { calendarRow } from '../market/calendar';
import { closeCheckAt, dueCloseCheck, isMarketOpen, type CalSession } from './market';
import { TIMEZONE } from './scheduler';

const s = (date: string, close = '16:00'): CalSession => {
  const r = calendarRow({ date, open: '09:30', close });
  return { date, openAt: r.openAt, closeAt: r.closeAt, earlyClose: r.earlyClose };
};
// Thanksgiving week 2026 (Nov 26 holiday, Nov 27 early close) and the following Monday.
const WEEK = [s('2026-11-24'), s('2026-11-25'), s('2026-11-27', '13:00'), s('2026-11-30')];
const pt = (d: Date) =>
  d.toLocaleString('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    weekday: 'short',
  });

describe('close check timing', () => {
  it('is 1:20 PM PT after a regular close and 11:00 AM PT after an early close', () => {
    expect(pt(closeCheckAt(s('2026-11-25')))).toBe('Wed 1:20 PM');
    expect(pt(closeCheckAt(s('2026-11-27', '13:00')))).toBe('Fri 11:00 AM');
  });

  it('stays 1:20 PM PT in summer (both coasts shift together)', () => {
    expect(pt(closeCheckAt(s('2026-07-01')))).toBe('Wed 1:20 PM');
  });

  it.each([
    [
      'Wed 1:15 PM PT: Wednesday not due yet → nothing new',
      '2026-11-25T21:15:00Z',
      '2026-11-24',
      null,
    ],
    ['Wed 1:20 PM PT → Wednesday due', '2026-11-25T21:20:00Z', '2026-11-24', '2026-11-25'],
    ['already checked Wednesday → nothing', '2026-11-25T23:00:00Z', '2026-11-25', null],
    ['Thanksgiving (holiday) → nothing new', '2026-11-26T21:20:00Z', '2026-11-25', null],
    ['Fri 10:59 AM PT (early close) → not yet', '2026-11-27T18:59:00Z', '2026-11-25', null],
    [
      'Fri 11:00 AM PT (early close) → Friday due',
      '2026-11-27T19:00:00Z',
      '2026-11-25',
      '2026-11-27',
    ],
    [
      'weekend after a missed Friday (worker was down) → catch up Friday',
      '2026-11-28T18:00:00Z',
      '2026-11-25',
      '2026-11-27',
    ],
    ['first ever run → latest completed session', '2026-11-30T12:00:00Z', null, '2026-11-27'],
  ])('%s', (_name, now, last, expected) => {
    expect(dueCloseCheck(WEEK, new Date(now), last)).toBe(expected);
  });
});

describe('isMarketOpen', () => {
  it.each([
    ['Wed 6:29 AM PT', '2026-11-25T14:29:00Z', false],
    ['Wed 6:30 AM PT', '2026-11-25T14:30:00Z', true],
    ['Wed 12:59 PM PT', '2026-11-25T20:59:00Z', true],
    ['Wed 1:00 PM PT (closed)', '2026-11-25T21:00:00Z', false],
    ['Thanksgiving noon', '2026-11-26T20:00:00Z', false],
    ['Fri 9:59 AM PT (early close day, open)', '2026-11-27T17:59:00Z', true],
    ['Fri 10:00 AM PT (early close)', '2026-11-27T18:00:00Z', false],
  ])('%s → %s', (_name, now, expected) => {
    expect(isMarketOpen(WEEK, new Date(now))).toBe(expected);
  });
});

describe('cron patterns (America/Los_Angeles)', () => {
  const next = (pattern: string, from: string, n = 3) =>
    new Cron(pattern, { timezone: TIMEZONE, paused: true }).nextRuns(n, new Date(from)).map(pt);

  it('polls EDGAR every 10 min from 5:00 AM to 8:50 PM PT on weekdays', () => {
    expect(next('*/10 5-20 * * 1-5', '2026-11-20T12:55:00Z')).toEqual([
      'Fri 5:00 AM',
      'Fri 5:10 AM',
      'Fri 5:20 AM',
    ]);
    expect(next('*/10 5-20 * * 1-5', '2026-11-21T04:45:00Z')).toEqual([
      'Fri 8:50 PM',
      'Mon 5:00 AM',
      'Mon 5:10 AM',
    ]);
  });

  it('refreshes bars at 2:00 PM PT on weekdays, including across DST', () => {
    expect(next('0 14 * * 1-5', '2026-11-20T23:00:00Z', 1)).toEqual(['Mon 2:00 PM']);
    expect(next('0 14 * * 1-5', '2026-07-01T00:00:00Z', 1)).toEqual(['Wed 2:00 PM']);
  });

  it('runs feed health hourly at :05', () => {
    expect(next('5 * * * *', '2026-11-20T12:00:00Z', 2)).toEqual(['Fri 4:05 AM', 'Fri 5:05 AM']);
  });
});

describe('assessFeeds', () => {
  const now = new Date('2026-11-25T19:00:00Z'); // Wed 11:00 AM PT, market open
  const min = (m: number) => new Date(now.getTime() - m * 60_000);
  const base: HealthSnapshot = {
    now,
    marketOpen: true,
    openedAt: min(270),
    news: {
      enabled: true,
      status: { status: 'ok', since: min(600), lastOkAt: min(1), detail: null },
    },
    quotes: { latestReceivedAt: min(3) },
    bars: { expectedDate: '2026-11-24', missing: [], tracked: 22 },
    edgar: { enabled: true, inWindow: true, lastSuccessAt: min(8), erroring: [] },
    jobErrors: [],
  };
  const status = (snap: Partial<HealthSnapshot>) =>
    Object.fromEntries(assessFeeds({ ...base, ...snap }).map((f) => [f.feed, f.status]));

  it('all healthy', () => {
    expect(Object.values(status({}))).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
  });

  it.each<[string, Partial<HealthSnapshot>, string, string]>([
    [
      'stream disabled on this worker',
      { news: { enabled: false, status: null } },
      'alpaca_news_stream',
      'disabled',
    ],
    [
      'stream never connected',
      { news: { enabled: true, status: null } },
      'alpaca_news_stream',
      'down',
    ],
    [
      'stream reconnecting for 2 min',
      {
        news: {
          enabled: true,
          status: {
            status: 'degraded',
            since: min(2),
            lastOkAt: min(3),
            detail: 'closed with code 1006',
          },
        },
      },
      'alpaca_news_stream',
      'degraded',
    ],
    [
      'stream down for 15 min',
      {
        news: {
          enabled: true,
          status: { status: 'degraded', since: min(15), lastOkAt: min(16), detail: null },
        },
      },
      'alpaca_news_stream',
      'down',
    ],
    [
      'stream connected but silent 10 min',
      {
        news: {
          enabled: true,
          status: { status: 'ok', since: min(600), lastOkAt: min(10), detail: null },
        },
      },
      'alpaca_news_stream',
      'degraded',
    ],
    [
      'quotes 20 min old while open',
      { quotes: { latestReceivedAt: min(20) } },
      'alpaca_quotes',
      'down',
    ],
    [
      'quotes old but market closed',
      { marketOpen: false, quotes: { latestReceivedAt: min(600) } },
      'alpaca_quotes',
      'ok',
    ],
    [
      'quotes missing right after the open',
      { openedAt: min(5), quotes: { latestReceivedAt: null } },
      'alpaca_quotes',
      'ok',
    ],
    [
      'some bars missing',
      { bars: { expectedDate: '2026-11-24', missing: ['ACMX'], tracked: 22 } },
      'alpaca_bars',
      'degraded',
    ],
    [
      'all bars missing',
      { bars: { expectedDate: '2026-11-24', missing: Array(22).fill('X'), tracked: 22 } },
      'alpaca_bars',
      'down',
    ],
    [
      'EDGAR silent 45 min in window',
      { edgar: { enabled: true, inWindow: true, lastSuccessAt: min(45), erroring: [] } },
      'sec_edgar',
      'down',
    ],
    [
      'EDGAR silent overnight (outside window)',
      { edgar: { enabled: true, inWindow: false, lastSuccessAt: min(600), erroring: [] } },
      'sec_edgar',
      'ok',
    ],
    [
      'EDGAR errors for one company',
      { edgar: { enabled: true, inWindow: true, lastSuccessAt: min(8), erroring: ['ACMX'] } },
      'sec_edgar',
      'degraded',
    ],
    [
      'a job failed in the last hour',
      { jobErrors: [{ job: 'quotes', at: min(20), error: 'x' }] },
      'scheduler',
      'degraded',
    ],
  ])('%s', (_name, snap, feed, expected) => {
    expect(status(snap)[feed]).toBe(expected);
  });
});
