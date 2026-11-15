/** Runner behaviour against Postgres, inside a rolled-back transaction with synthetic data. */
import {
  createDb,
  exitRules,
  instruments,
  testDatabaseUrl,
  marketCalendar,
  pricesDaily,
  ruleEvaluations,
  symbolDataStatus,
  type Db,
} from '@aia/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { checkRules, latestCompletedSession } from './check';

const url = testDatabaseUrl();

class Rollback extends Error {}

describe.skipIf(!url)('checkRules (Postgres)', () => {
  const { db, sql: client } = createDb(url ?? '', { max: 1 });
  afterAll(() => client.end());

  async function inTx(fn: (tx: Db) => Promise<void>) {
    await expect(
      db.transaction(async (tx) => {
        // Serialize DB tests across packages (vitest runs projects in parallel).
        await tx.execute(sql`SELECT pg_advisory_xact_lock(4242)`);
        await tx.execute(
          sql`TRUNCATE exit_rules, instruments, prices_daily, market_calendar, symbol_data_status RESTART IDENTITY CASCADE`,
        );
        await fn(tx as unknown as Db);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  // Thanksgiving week: Nov 26 holiday, Nov 27 early close at 18:00Z.
  const days: [string, string][] = [
    ['2026-11-23', '2026-11-23T21:00:00Z'],
    ['2026-11-24', '2026-11-24T21:00:00Z'],
    ['2026-11-25', '2026-11-25T21:00:00Z'],
    ['2026-11-27', '2026-11-27T18:00:00Z'],
  ];

  async function seed(tx: Db) {
    await tx.insert(marketCalendar).values(
      days.map(([date, close]) => ({
        date,
        openAt: new Date(`${date}T14:30:00Z`),
        closeAt: new Date(close),
        earlyClose: date === '2026-11-27',
      })),
    );
    const [bk, otc] = await tx
      .insert(instruments)
      .values([
        { symbol: 'BKX', instrumentType: 'stock' },
        { symbol: 'OTCX', instrumentType: 'otc_stock' },
      ])
      .returning({ id: instruments.id });
    const closes = { '2026-11-23': 130, '2026-11-24': 140, '2026-11-25': 150, '2026-11-27': 119 };
    await tx.insert(pricesDaily).values(
      Object.entries(closes).map(([date, c]) => ({
        symbol: 'BKX',
        date,
        open: String(c),
        high: String(c),
        low: String(c),
        close: String(c),
        volume: 1,
        source: 'test',
      })),
    );
    await tx.insert(symbolDataStatus).values({
      symbol: 'OTCX',
      dataset: 'daily_bars',
      status: 'no_data_source',
    });
    await tx.insert(exitRules).values([
      {
        instrumentId: bk!.id,
        externalKey: 'k:tp2',
        purpose: 'take_profit',
        status: 'CONFIRMED',
        ruleType: 'take_profit_at_or_above',
        params: { level: 135, basis: 'close' },
      },
      {
        instrumentId: bk!.id,
        externalKey: 'k:trail',
        purpose: 'risk_stop',
        status: 'CONFIRMED',
        ruleType: 'trailing_close_pct_from_high',
        params: { pct: 20, start_date: null, start_after_rule: 'k:tp2' },
      },
      {
        instrumentId: bk!.id,
        externalKey: 'k:judgment',
        purpose: 'thesis_break',
        status: 'CONFIRMED',
        thesisBreakTriggers: 'FTC outcome',
      },
      {
        instrumentId: otc!.id,
        externalKey: 'k:otcstop',
        purpose: 'risk_stop',
        status: 'CONFIRMED',
        ruleType: 'stop_close_below',
        params: { level: 1.2 },
      },
      {
        instrumentId: otc!.id,
        externalKey: 'k:remind',
        purpose: 'reminder',
        status: 'CONFIRMED',
        ruleType: 'date_reminder',
        params: { on: '2026-11-24' },
      },
    ]);
  }

  const outcomeOf = async (tx: Db, key: string, date: string) => {
    const [rule] = await tx.select().from(exitRules).where(eq(exitRules.externalKey, key));
    const rows = await tx
      .select()
      .from(ruleEvaluations)
      .where(eq(ruleEvaluations.exitRuleId, rule!.id));
    const r = rows.find((x) => x.asOfDate === date);
    return r ? `${r.outcome}${r.reason ? `:${r.reason}` : ''}` : 'none';
  };

  it('picks the latest completed session, respecting the early close', async () => {
    await inTx(async (tx) => {
      await seed(tx);
      // 18:10Z on the early-close day: the session closed at 18:00 but the bar isn't settled.
      expect(await latestCompletedSession(tx, new Date('2026-11-27T18:10:00Z'))).toBe('2026-11-25');
      expect(await latestCompletedSession(tx, new Date('2026-11-27T18:16:00Z'))).toBe('2026-11-27');
      // Thanksgiving itself: still the 25th.
      expect(await latestCompletedSession(tx, new Date('2026-11-26T22:00:00Z'))).toBe('2026-11-25');
    });
  });

  it('starts a trailing stop when its trigger fires, runs once-only rules once, skips judgment', async () => {
    await inTx(async (tx) => {
      await seed(tx);
      // Day 1: below TP2, trail not started, reminder not due.
      await checkRules(tx, { asOfDate: '2026-11-23' });
      expect(await outcomeOf(tx, 'k:tp2', '2026-11-23')).toBe('not_fired');
      expect(await outcomeOf(tx, 'k:trail', '2026-11-23')).toBe('not_checked:not_started');

      // Day 2: TP2 fires (140 ≥ 135) → the trail starts the same day; the reminder fires.
      await checkRules(tx, { asOfDate: '2026-11-24' });
      expect(await outcomeOf(tx, 'k:tp2', '2026-11-24')).toBe('fired');
      expect(await outcomeOf(tx, 'k:trail', '2026-11-24')).toBe('not_fired');
      expect(await outcomeOf(tx, 'k:remind', '2026-11-24')).toBe('fired');

      // Day 3 (Nov 25) and the early-close day: 150 high, then 119 = 20.7% below → trailing stop.
      await checkRules(tx, { asOfDate: '2026-11-25' });
      expect(await outcomeOf(tx, 'k:remind', '2026-11-25')).toBe('not_fired'); // once only
      const res = await checkRules(tx, { asOfDate: '2026-11-27' });
      expect(await outcomeOf(tx, 'k:trail', '2026-11-27')).toBe('fired');
      const trail = res.results.find((r) => r.externalKey === 'k:trail')!;
      expect(trail.outcome.observed).toMatchObject({ highestClose: 150, since: '2026-11-24' });

      // OTC: price rule not checked, judgment never evaluated.
      expect(await outcomeOf(tx, 'k:otcstop', '2026-11-27')).toBe('not_checked:no_data_source');
      expect(await outcomeOf(tx, 'k:judgment', '2026-11-27')).toBe('none');
    });
  });

  it('re-running a day overwrites instead of duplicating', async () => {
    await inTx(async (tx) => {
      await seed(tx);
      await checkRules(tx, { asOfDate: '2026-11-24' });
      await checkRules(tx, { asOfDate: '2026-11-24' });
      expect(await tx.$count(ruleEvaluations)).toBe(4); // 4 typed rules, 1 day
    });
  });
});
