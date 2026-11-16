import { describe, expect, it } from 'vitest';
import { corporateActionEvents } from './corporate-actions';
import { ffFeedSchema, toEconEvents } from './econ-calendar';

describe('corporateActionEvents', () => {
  it('dates dividends on the ex-date, with rate, pay date and special flag', () => {
    const events = corporateActionEvents({
      dividends: [
        {
          id: 'd1',
          symbol: 'ACMX',
          ex_date: '2026-12-07',
          record_date: '2026-12-07',
          payable_date: '2026-12-14',
          rate: 0.22,
          special: false,
        },
        {
          id: 'd2',
          symbol: 'ETFX',
          ex_date: '2026-12-21',
          payable_date: null,
          rate: 1.888834,
          special: true,
        },
        { id: 'd3', symbol: 'NOEX', ex_date: null, rate: 0.5 },
      ],
      forwardSplits: [],
      reverseSplits: [],
    });
    expect(events.map((e) => [e.ticker, e.date, e.title, e.amount, e.sourceRef, e.notes])).toEqual([
      [
        'ACMX',
        '2026-12-07',
        'Dividend $0.22/share (ex-date, pays 12/14)',
        '0.22',
        'd1',
        'Record date 2026-12-07',
      ],
      ['ETFX', '2026-12-21', 'Special dividend $1.888834/share (ex-date)', '1.888834', 'd2', null],
    ]);
    expect(events[0]).toMatchObject({
      eventType: 'dividend',
      source: 'alpaca',
      confirmed: true,
      timeOfDay: 'before_open',
    });
  });

  it('describes forward and reverse splits with their ratio', () => {
    const events = corporateActionEvents({
      dividends: [],
      forwardSplits: [
        { id: 's1', symbol: 'ACMX', ex_date: '2027-01-04', new_rate: 4, old_rate: 1 },
      ],
      reverseSplits: [
        { id: 's2', symbol: 'PENX', ex_date: '2026-12-01', new_rate: 1, old_rate: 10 },
      ],
    });
    expect(events.map((e) => [e.ticker, e.eventType, e.title, e.amount])).toEqual([
      ['ACMX', 'split', 'Stock split 4-for-1 (ex-date)', '4'],
      ['PENX', 'split', 'Reverse split 1-for-10 (ex-date)', '0.1'],
    ]);
  });
});

describe('toEconEvents (ForexFactory)', () => {
  const feed = ffFeedSchema.parse([
    {
      title: 'CPI m/m',
      country: 'USD',
      date: '2026-11-18T08:30:00-05:00',
      impact: 'High',
      forecast: '0.3%',
      previous: '0.4%',
    },
    {
      title: 'Retail Sales m/m',
      country: 'USD',
      date: '2026-11-17T08:30:00-05:00',
      impact: 'Medium',
      forecast: '',
      previous: '0.6%',
    },
    {
      title: 'FOMC Member Speaks',
      country: 'USD',
      date: '2026-11-16T05:00:00-05:00',
      impact: 'Low',
      forecast: '',
      previous: '',
    },
    {
      title: 'German ZEW',
      country: 'EUR',
      date: '2026-11-17T05:00:00-05:00',
      impact: 'High',
      forecast: '',
      previous: '',
    },
    {
      title: 'Bank Holiday',
      country: 'USD',
      date: '2026-11-26T00:00:00-05:00',
      impact: 'High',
      forecast: '',
      previous: '',
    },
    {
      title: 'GDP q/q',
      country: 'USD',
      date: '2026-11-25T08:30:00-05:00',
      impact: 'High',
      forecast: '2.1%',
      previous: '1.8%',
      actual: '2.4%',
    },
  ]);

  it('keeps USD High/Medium only, converts ET to UTC, blanks to null', () => {
    const rows = toEconEvents(feed);
    expect(
      rows.map((r) => [r.title, r.impact, r.at.toISOString(), r.forecast, r.previous, r.allDay]),
    ).toEqual([
      ['CPI m/m', 'High', '2026-11-18T13:30:00.000Z', '0.3%', '0.4%', false],
      ['Retail Sales m/m', 'Medium', '2026-11-17T13:30:00.000Z', null, '0.6%', false],
      ['Bank Holiday', 'High', '2026-11-26T05:00:00.000Z', null, null, true],
      ['GDP q/q', 'High', '2026-11-25T13:30:00.000Z', '2.1%', '1.8%', false],
    ]);
  });

  it('never invents an actual value: only stores it when the feed provides one', () => {
    const rows = toEconEvents(feed);
    expect(rows.find((r) => r.title === 'CPI m/m')!.actual).toBeNull();
    expect(rows.find((r) => r.title === 'GDP q/q')!.actual).toBe('2.4%');
  });

  it('rejects a feed that is not the expected JSON (e.g. a "request denied" page)', () => {
    expect(() => ffFeedSchema.parse({ error: 'denied' })).toThrow();
  });
});
