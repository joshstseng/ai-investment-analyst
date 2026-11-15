import { describe, expect, it } from 'vitest';
import type { AlpacaBar } from '../alpaca/schemas';
import { BAR_SETTLE_MS, toBarRows } from './bars';
import { calendarRow, type Session } from './calendar';
import { toQuoteRow } from './quotes';
import { buildUniverse } from './universe';

describe('calendarRow', () => {
  it('converts ET session times to UTC and flags early closes', () => {
    const regular = calendarRow({
      date: '2026-11-25',
      open: '09:30',
      close: '16:00',
      session_open: '0400',
      session_close: '2000',
    });
    expect(regular.openAt.toISOString()).toBe('2026-11-25T14:30:00.000Z');
    expect(regular.closeAt.toISOString()).toBe('2026-11-25T21:00:00.000Z');
    expect(regular.sessionCloseAt!.toISOString()).toBe('2026-11-26T01:00:00.000Z');
    expect(regular.earlyClose).toBe(false);

    const dayAfterThanksgiving = calendarRow({ date: '2026-11-27', open: '09:30', close: '13:00' });
    expect(dayAfterThanksgiving.closeAt.toISOString()).toBe('2026-11-27T18:00:00.000Z');
    expect(dayAfterThanksgiving.earlyClose).toBe(true);
    expect(dayAfterThanksgiving.sessionOpenAt).toBeNull();
  });

  it('handles daylight saving time', () => {
    expect(
      calendarRow({ date: '2026-07-01', open: '09:30', close: '16:00' }).closeAt.toISOString(),
    ).toBe('2026-07-01T20:00:00.000Z');
  });
});

describe('toBarRows', () => {
  const session = (date: string, closeIso: string, earlyClose = false): [string, Session] => [
    date,
    { date, closeAt: new Date(closeIso), earlyClose },
  ];
  const sessions = new Map([
    session('2026-11-25', '2026-11-25T21:00:00Z'),
    session('2026-11-27', '2026-11-27T18:00:00Z', true),
  ]);
  const bar = (t: string, c = 10): AlpacaBar => ({
    t,
    o: 9,
    h: 11,
    l: 8,
    c,
    v: 100,
    vw: 9.5,
    n: 5,
  });

  it('keeps closed sessions and drops a still-open (partial) session', () => {
    // 2026-11-27 is an early close (1 PM ET = 18:00Z). At 18:10Z its bar is not final yet.
    const now = new Date('2026-11-27T18:10:00Z');
    const res = toBarRows(
      'SPY',
      [bar('2026-11-25T05:00:00Z', 754.37), bar('2026-11-27T05:00:00Z')],
      sessions,
      now,
      'alpaca:sip',
    );
    expect(res.rows.map((r) => r.date)).toEqual(['2026-11-25']);
    expect(res.rows[0]).toMatchObject({ close: '754.37', volume: 100, vwap: '9.5', tradeCount: 5 });
    expect(res.incomplete).toBe(1);
  });

  it('accepts an early-close bar once the close plus the settle margin has passed', () => {
    const now = new Date(new Date('2026-11-27T18:00:00Z').getTime() + BAR_SETTLE_MS);
    const res = toBarRows('SPY', [bar('2026-11-27T05:00:00Z')], sessions, now, 'alpaca:sip');
    expect(res.rows.map((r) => r.date)).toEqual(['2026-11-27']);
  });

  it('skips bars on dates that are not trading days (e.g. a holiday)', () => {
    const res = toBarRows(
      'SPY',
      [bar('2026-11-26T05:00:00Z')],
      sessions,
      new Date('2026-12-01T00:00:00Z'),
      'x',
    );
    expect(res.rows).toEqual([]);
    expect(res.unknownDates).toEqual(['2026-11-26']);
  });
});

describe('buildUniverse', () => {
  it('includes underlyings for options, benchmarks for prices, and lists option contracts', () => {
    const u = buildUniverse([
      {
        symbol: 'ACMX',
        instrumentType: 'stock',
        underlyingSymbol: null,
        held: true,
        watched: false,
      },
      { symbol: 'ETFX', instrumentType: 'etf', underlyingSymbol: null, held: true, watched: false },
      {
        symbol: 'OTCX',
        instrumentType: 'otc_stock',
        underlyingSymbol: null,
        held: true,
        watched: false,
      },
      {
        symbol: 'OPTX280616C00045000',
        instrumentType: 'option',
        underlyingSymbol: 'OPTX',
        held: true,
        watched: false,
      },
      {
        symbol: 'WATX',
        instrumentType: 'stock',
        underlyingSymbol: null,
        held: false,
        watched: true,
      },
      {
        symbol: 'OLD',
        instrumentType: 'stock',
        underlyingSymbol: null,
        held: false,
        watched: false,
      },
    ]);
    expect(u.priceSymbols).toEqual(['ACMX', 'ETFX', 'OPTX', 'OTCX', 'QQQ', 'SPY', 'WATX']);
    expect(u.newsSymbols).toEqual(['ACMX', 'ETFX', 'OPTX', 'OTCX', 'WATX']);
    expect(u.optionContracts).toEqual([{ symbol: 'OPTX280616C00045000', underlying: 'OPTX' }]);
  });
});

describe('toQuoteRow', () => {
  it('uses the newer of quote and trade timestamps', () => {
    const row = toQuoteRow(
      'SPY',
      {
        latestQuote: { t: '2026-11-13T21:00:00.03Z', ap: 775.36, as: 40, bp: 729.68, bs: 40 },
        latestTrade: { t: '2026-11-13T21:55:04.28Z', p: 752.09 },
      },
      new Date('2026-11-15T00:00:00Z'),
    );
    expect(row).toMatchObject({ lastPrice: '752.09', bidPrice: '729.68', source: 'alpaca:iex' });
    expect(row.quoteTs!.toISOString()).toBe('2026-11-13T21:55:04.280Z');
  });
});
