import { describe, expect, it } from 'vitest';
import { liveFromSnapshot } from './prices';
import { planBatches } from './twelvedata';

describe('liveFromSnapshot', () => {
  const today = '2026-11-17';
  it('uses the latest trade only if it happened today (New York date)', () => {
    expect(
      liveFromSnapshot('ACMX', { latestTrade: { t: '2026-11-17T14:41:02Z', p: 101.5 } }, today),
    ).toEqual({
      symbol: 'ACMX',
      price: 101.5,
      at: new Date('2026-11-17T14:41:02Z'),
      source: 'alpaca:iex',
    });
    // Yesterday's last trade (no IEX print yet today) is not a live price.
    expect(
      liveFromSnapshot('ACMX', { latestTrade: { t: '2026-11-16T20:59:59Z', p: 99 } }, today),
    ).toBeNull();
    // 00:30 UTC on the 18th is still the 17th in New York.
    expect(
      liveFromSnapshot('ACMX', { latestTrade: { t: '2026-11-18T00:30:00Z', p: 99 } }, today),
    ).not.toBeNull();
    expect(liveFromSnapshot('ACMX', undefined, today)).toBeNull();
    expect(liveFromSnapshot('ACMX', { latestTrade: null }, today)).toBeNull();
  });
});

describe('Twelve Data batch planning', () => {
  const s = (n: number) => Array.from({ length: n }, (_, i) => `S${i}`);
  it('batches by the per-minute limit within the per-run cap', () => {
    const p = planBatches(s(20), { remainingToday: 800, maxPerRun: 18, perMinute: 8 });
    expect(p.batches.map((b) => b.length)).toEqual([8, 8, 2]);
    expect(p.skipped).toEqual(['S18', 'S19']);
  });
  it('never exceeds what is left of the daily budget', () => {
    expect(planBatches(s(10), { remainingToday: 3, maxPerRun: 80, perMinute: 8 })).toEqual({
      batches: [['S0', 'S1', 'S2']],
      skipped: ['S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'],
    });
    expect(planBatches(s(2), { remainingToday: -5, maxPerRun: 80, perMinute: 8 }).batches).toEqual(
      [],
    );
  });
});
