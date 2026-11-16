import { describe, expect, it } from 'vitest';
import { premarketQuote } from './premarket';

const openAt = new Date('2026-11-16T14:30:00Z'); // 9:30 AM ET
const bar = (t: string, c: number, v = 100) => ({ t, o: c, h: c, l: c, c, v });

describe('premarketQuote', () => {
  it('uses the last bar before the open and computes the change vs the last close', () => {
    const q = premarketQuote(
      'ACMX',
      [
        bar('2026-11-16T09:01:00Z', 101),
        bar('2026-11-16T13:28:00Z', 98.5, 300),
        bar('2026-11-16T14:31:00Z', 120),
      ],
      100,
      openAt,
      'sip',
    );
    expect(q).toMatchObject({ price: 98.5, changePct: -1.5, volume: 400, feed: 'sip' });
    expect(q.at!.toISOString()).toBe('2026-11-16T13:28:00.000Z');
  });

  it('reports no pre-market trades when there are no bars before the open', () => {
    expect(premarketQuote('THIN', [], 50, openAt, 'sip')).toMatchObject({
      price: null,
      changePct: null,
      volume: 0,
      feed: null,
      lastClose: 50,
    });
  });

  it('has a price but no % change when the last close is unknown (e.g. a new listing)', () => {
    expect(
      premarketQuote('NEWX', [bar('2026-11-16T13:00:00Z', 10)], null, openAt, 'iex'),
    ).toMatchObject({
      price: 10,
      changePct: null,
      feed: 'iex',
    });
  });
});
