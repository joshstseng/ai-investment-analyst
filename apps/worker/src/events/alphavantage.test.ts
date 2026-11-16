import { describe, expect, it } from 'vitest';
import {
  AlphaVantageError,
  callBudget,
  consecutiveFailedDays,
  parseEarningsCsv,
  toEarningsEvents,
} from './alphavantage';

const CSV = `symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay
ACMX,ACME CORP,2026-11-19,2026-10-31,1.59,USD,post-market
BKX,BKX INC,2026-12-10,2026-10-31,,USD,pre-market
ZZZZ,NOT FOLLOWED,2026-11-20,2026-09-30,0.10,USD,
OTCX,OTC CO,2026-12-02,2026-09-30,N/A,USD,
`;

describe('parseEarningsCsv', () => {
  it('parses rows and blank or non-numeric estimates', () => {
    const rows = parseEarningsCsv(CSV);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      symbol: 'ACMX',
      name: 'ACME CORP',
      reportDate: '2026-11-19',
      fiscalDateEnding: '2026-10-31',
      estimate: '1.59',
      timeOfTheDay: 'post-market',
    });
    expect(rows[1]!.estimate).toBeNull();
    expect(rows[3]!.estimate).toBeNull();
  });

  it.each([
    [
      'rate limit',
      '{"Information": "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day."}',
      /rate limit is 25/,
    ],
    ['note', '{"Note": "API call frequency exceeded"}', /frequency exceeded/],
    ['bad key', '{"Error Message": "Invalid API call"}', /Invalid API call/],
    ['wrong format', 'foo,bar\n1,2\n', /unexpected CSV header/],
  ])('treats a %s reply as a failure, never an empty calendar', (_name, body, message) => {
    expect(() => parseEarningsCsv(body)).toThrow(AlphaVantageError);
    expect(() => parseEarningsCsv(body)).toThrow(message);
  });
});

describe('toEarningsEvents', () => {
  it('keeps followed tickers only, maps time of day, one event per fiscal period', () => {
    const events = toEarningsEvents(parseEarningsCsv(CSV), new Set(['ACMX', 'BKX', 'OTCX']));
    expect(events.map((e) => [e.ticker, e.date, e.timeOfDay, e.epsEstimate, e.sourceRef])).toEqual([
      ['ACMX', '2026-11-19', 'after_close', '1.59', 'ACMX:2026-10-31'],
      ['BKX', '2026-12-10', 'before_open', null, 'BKX:2026-10-31'],
      ['OTCX', '2026-12-02', 'unknown', null, 'OTCX:2026-09-30'],
    ]);
    expect(events[0]).toMatchObject({
      source: 'alphavantage',
      confirmed: true,
      estimated: false,
      eventType: 'earnings',
    });
  });
});

describe('call budget (≤ 2 calls per Pacific day)', () => {
  const today = '2026-11-17';
  it.each<[string, { day: string; success: boolean }[], boolean]>([
    ['first call of the day', [], true],
    [
      "yesterday's calls don't count",
      [
        { day: '2026-11-16', success: false },
        { day: '2026-11-16', success: false },
      ],
      true,
    ],
    ['retry after a failure', [{ day: today, success: false }], true],
    ['no second call after a success', [{ day: today, success: true }], false],
    [
      'never a third call',
      [
        { day: today, success: false },
        { day: today, success: false },
      ],
      false,
    ],
  ])('%s → allowed=%s', (_name, runs, allowed) => {
    expect(callBudget(runs, today).allowed).toBe(allowed);
  });
});

describe('consecutiveFailedDays', () => {
  it.each<[string, { day: string; success: boolean }[], number]>([
    ['no runs', [], 0],
    ['succeeded today', [{ day: '2026-11-17', success: true }], 0],
    [
      'failed today only (retry pending)',
      [
        { day: '2026-11-17', success: false },
        { day: '2026-11-16', success: true },
      ],
      1,
    ],
    [
      'failed today after a success on the 2nd attempt yesterday',
      [
        { day: '2026-11-17', success: false },
        { day: '2026-11-17', success: false },
        { day: '2026-11-16', success: true },
        { day: '2026-11-16', success: false },
      ],
      1,
    ],
    [
      'failed two days running',
      [
        { day: '2026-11-17', success: false },
        { day: '2026-11-16', success: false },
        { day: '2026-11-13', success: true },
      ],
      2,
    ],
    [
      'weekend gap does not reset the count (Fri + Mon failed)',
      [
        { day: '2026-11-16', success: false },
        { day: '2026-11-13', success: false },
      ],
      2,
    ],
  ])('%s → %s', (_name, runs, expected) => {
    expect(consecutiveFailedDays(runs)).toBe(expected);
  });
});
