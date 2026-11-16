import { describe, expect, it } from 'vitest';
import {
  dateChangePatch,
  daysBetween,
  describeDateChange,
  lockupExpiry,
  parseTimeOfDay,
  reconcileEvents,
  type ReconcileEvent,
} from './events';

describe('event dates', () => {
  it('counts days and describes a date change', () => {
    expect(daysBetween('2026-11-19', '2026-11-20')).toBe(1);
    expect(daysBetween('2026-12-31', '2027-01-02')).toBe(2);
    expect(daysBetween('2026-11-20', '2026-11-19')).toBe(-1);
    expect(describeDateChange('ACMX', '2026-11-19', '2026-11-20')).toBe('ACMX moved 11/19 → 11/20');
  });

  it('records a date change with the previous date and history; nothing when unchanged', () => {
    const now = new Date('2026-11-16T13:00:00Z');
    expect(
      dateChangePatch({ date: '2026-11-19', history: [] }, '2026-11-19', now, 'alphavantage'),
    ).toBeNull();
    const first = dateChangePatch(
      { date: '2026-11-19', history: [] },
      '2026-11-20',
      now,
      'alphavantage',
    )!;
    expect(first).toMatchObject({
      date: '2026-11-20',
      previousDate: '2026-11-19',
      dateChangedAt: now,
    });
    expect(first.history).toEqual([
      { from: '2026-11-19', to: '2026-11-20', at: now.toISOString(), source: 'alphavantage' },
    ]);
    const second = dateChangePatch(
      { date: '2026-11-20', history: first.history },
      '2026-11-18',
      now,
      'alphavantage',
    )!;
    expect(second.previousDate).toBe('2026-11-20');
    expect(second.history.map((h) => `${h.from}→${h.to}`)).toEqual([
      '2026-11-19→2026-11-20',
      '2026-11-20→2026-11-18',
    ]);
  });

  it.each([
    ['Q3 results (after close; call 1:20 PM PT)', 'after_close'],
    ['Results before the open', 'before_open'],
    ['pre-market', 'before_open'],
    ['post-market', 'after_close'],
    ['FY27 guidance', 'unknown'],
    [null, 'unknown'],
  ])('time of day from %j → %s', (text, expected) => {
    expect(parseTimeOfDay(text)).toBe(expected);
  });

  it('estimates an IPO lockup as first trading day + 180 days', () => {
    expect(lockupExpiry('2026-06-15')).toBe('2026-12-12');
  });
});

describe('reconcileEvents (source precedence)', () => {
  let id = 0;
  const ev = (over: Partial<ReconcileEvent>): ReconcileEvent => ({
    id: ++id,
    ticker: 'ACMX',
    eventType: 'earnings',
    date: '2026-12-09',
    source: 'seed',
    confirmed: false,
    estimated: true,
    status: 'active',
    ...over,
  });

  it('keeps a seeded event over a derived one within ±3 days and notes the difference', () => {
    const seed = ev({ eventType: 'lockup_expiry', date: '2026-12-08' });
    const derived = ev({ eventType: 'lockup_expiry', date: '2026-12-09', source: 'derived' });
    expect(reconcileEvents([seed, derived])).toEqual([
      { loserId: derived.id, winnerId: seed.id, winnerNote: 'derived estimate 12/9 (+1 day)' },
    ]);
  });

  it('keeps both when they are more than 3 days apart, or of different types', () => {
    const seed = ev({ eventType: 'lockup_expiry', date: '2026-12-01' });
    expect(
      reconcileEvents([
        seed,
        ev({ eventType: 'lockup_expiry', date: '2026-12-05', source: 'derived' }),
      ]),
    ).toEqual([]);
    expect(
      reconcileEvents([seed, ev({ eventType: 'dividend', date: '2026-12-01', source: 'derived' })]),
    ).toEqual([]);
  });

  it('does not duplicate a rule reminder that is already seeded', () => {
    const seed = ev({
      eventType: 'reminder',
      date: '2026-12-10',
      confirmed: true,
      estimated: false,
    });
    const rule = ev({
      eventType: 'reminder',
      date: '2026-12-10',
      source: 'rule',
      confirmed: true,
      estimated: false,
    });
    expect(reconcileEvents([seed, rule])).toEqual([
      { loserId: rule.id, winnerId: seed.id, winnerNote: 'rule reminder 12/10 (same day)' },
    ]);
  });

  it('replaces an unconfirmed seeded earnings estimate with Alpha Vantage within ±45 days', () => {
    const estimate = ev({ date: '2026-12-09' });
    const av = ev({
      date: '2026-12-10',
      source: 'alphavantage',
      confirmed: true,
      estimated: false,
    });
    expect(reconcileEvents([estimate, av])).toEqual([
      {
        loserId: estimate.id,
        winnerId: av.id,
        winnerNote: 'replaced seeded estimate 12/9 (-1 day)',
      },
    ]);
  });

  it('never replaces a confirmed seeded date (Alpha Vantage folds into it), nor estimates > 45 days away', () => {
    const confirmed = ev({ date: '2026-11-19', confirmed: true, estimated: false });
    const far = ev({ date: '2027-02-26' });
    const av = ev({ date: '2026-11-20', source: 'alphavantage', confirmed: true });
    const avFar = ev({ date: '2026-12-31', source: 'alphavantage', confirmed: true }); // 57 days from far
    expect(reconcileEvents([confirmed, far, av, avFar])).toEqual([
      { loserId: av.id, winnerId: confirmed.id, winnerNote: 'Alpha Vantage: 11/20 (+1 day)' },
    ]);
  });

  it('ignores cancelled events and picks the nearest winner', () => {
    const estimate = ev({ date: '2026-12-09' });
    const cancelled = ev({ date: '2026-12-09', source: 'alphavantage', status: 'cancelled' });
    const near = ev({ date: '2026-12-11', source: 'alphavantage' });
    const farther = ev({ date: '2026-12-30', source: 'alphavantage' });
    expect(reconcileEvents([estimate, cancelled, farther, near])[0]).toMatchObject({
      loserId: estimate.id,
      winnerId: near.id,
    });
  });
});

describe('confirmed seeded earnings vs Alpha Vantage', () => {
  let id = 1000;
  const ev = (over: Partial<ReconcileEvent>): ReconcileEvent => ({
    id: ++id,
    ticker: 'ACMX',
    eventType: 'earnings',
    date: '2026-11-17',
    source: 'seed',
    confirmed: true,
    estimated: false,
    status: 'active',
    ...over,
  });

  it('keeps the confirmed seeded row and folds Alpha Vantage details into its note', () => {
    const seed = ev({});
    const av = ev({ source: 'alphavantage', timeOfDay: 'after_close', epsEstimate: '2.490000' });
    expect(reconcileEvents([seed, av])).toEqual([
      {
        loserId: av.id,
        winnerId: seed.id,
        winnerNote: 'Alpha Vantage: 11/17 after close, EPS est 2.49 (same day)',
      },
    ]);
  });

  it('flags a 1–3 day disagreement in the note, and keeps both if further apart', () => {
    const seed = ev({});
    expect(
      reconcileEvents([seed, ev({ source: 'alphavantage', date: '2026-11-19' })])[0]!.winnerNote,
    ).toBe('Alpha Vantage: 11/19 (+2 days)');
    expect(reconcileEvents([seed, ev({ source: 'alphavantage', date: '2026-11-24' })])).toEqual([]);
  });

  it('still lets Alpha Vantage replace an unconfirmed estimate (seed loses, not the other way)', () => {
    const estimate = ev({ confirmed: false, estimated: true });
    const av = ev({ source: 'alphavantage', date: '2026-11-18' });
    expect(reconcileEvents([estimate, av])).toEqual([
      {
        loserId: estimate.id,
        winnerId: av.id,
        winnerNote: 'replaced seeded estimate 11/17 (-1 day)',
      },
    ]);
  });
});
