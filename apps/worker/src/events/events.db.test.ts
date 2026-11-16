/** Automatic event sync against Postgres, inside rolled-back transactions (made-up data). */
import {
  createDb,
  events,
  exitRules,
  holdings,
  instruments,
  accounts,
  pricesDaily,
  testDatabaseUrl,
  upsertEvents,
  type Db,
} from '@aia/db';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { lockupEvents, syncDerivedEvents } from './derived';

const url = testDatabaseUrl();
class Rollback extends Error {}

describe('lockupEvents (pure)', () => {
  it('estimates a lockup only for symbols that listed during the bar history, within 12 months', () => {
    const out = lockupEvents(
      [
        { symbol: 'NEWX', firstBar: '2026-06-15' }, // listed in June
        { symbol: 'OLDX', firstBar: '2025-11-17' }, // bars from the start of history: not new
        { symbol: 'EDGE', firstBar: '2025-11-21' }, // within 7 days of history start: not new
      ],
      '2025-11-17',
      '2026-11-16',
    );
    expect(out.map((e) => [e.ticker, e.date, e.estimated, e.sourceRef])).toEqual([
      ['NEWX', '2026-12-12', true, 'lockup:NEWX'],
    ]);
  });
});

describe.skipIf(!url)('event sync (Postgres)', () => {
  const { db, sql: client } = createDb(url ?? '', { max: 1 });
  afterAll(() => client.end());

  async function inTx(fn: (tx: Db) => Promise<void>) {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(4242)`);
        await tx.execute(
          sql`TRUNCATE events, exit_rules, holdings, instruments, accounts, prices_daily RESTART IDENTITY CASCADE`,
        );
        await fn(tx as unknown as Db);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  async function seed(tx: Db) {
    const [acct] = await tx
      .insert(accounts)
      .values({ name: 'Test', accountType: 'roth_ira', taxAdvantaged: true })
      .returning({ id: accounts.id });
    const [stock, option] = await tx
      .insert(instruments)
      .values([
        { symbol: 'NEWX', instrumentType: 'stock' },
        {
          symbol: 'OPTX270319C00006000',
          instrumentType: 'option',
          underlyingSymbol: 'OPTX',
          optionRight: 'call',
          strike: '6',
          expiry: '2027-03-19',
          multiplier: 100,
        },
      ])
      .returning({ id: instruments.id });
    await tx.insert(holdings).values([
      { accountId: acct!.id, instrumentId: stock!.id, quantity: '1', avgCost: '1' },
      { accountId: acct!.id, instrumentId: option!.id, quantity: '1', avgCost: '1' },
    ]);
    const bar = (symbol: string, date: string) => ({
      symbol,
      date,
      open: '1',
      high: '1',
      low: '1',
      close: '1',
      volume: 1,
      source: 'test',
    });
    await tx.insert(pricesDaily).values([bar('SPY', '2025-11-17'), bar('NEWX', '2026-06-15')]);
    const [rule] = await tx
      .insert(exitRules)
      .values({
        instrumentId: option!.id,
        purpose: 'reminder',
        status: 'CONFIRMED',
        ruleType: 'date_reminder',
        params: { on: '2026-12-10' },
        alertNote: 'Decide before year end.',
        externalKey: 'manual:OPTX:decision',
      })
      .returning({ id: exitRules.id });
    return { ruleId: rule!.id };
  }

  const now = new Date('2026-11-16T13:00:00Z');
  const rows = (tx: Db) => tx.select().from(events).orderBy(asc(events.date), asc(events.source));

  it('syncs reminders, option expiries and lockups without duplicates on re-run', async () => {
    await inTx(async (tx) => {
      await seed(tx);
      const first = await syncDerivedEvents(tx, now);
      expect(first.meta).toMatchObject({ reminders: 1, optionExpiries: 1, inserted: 3 });
      const second = await syncDerivedEvents(tx, now);
      expect(second.meta).toMatchObject({ inserted: 0, updated: 0 });
      expect(
        (await rows(tx)).map((e) => [e.date, e.ticker, e.eventType, e.source, e.status]),
      ).toEqual([
        ['2026-12-10', 'OPTX', 'reminder', 'rule', 'active'],
        ['2026-12-12', 'NEWX', 'lockup_expiry', 'derived', 'active'],
        ['2027-03-19', 'OPTX', 'option_expiry', 'derived', 'active'],
      ]);
    });
  });

  it('tracks a changed rule date and cancels the event when the rule is deleted', async () => {
    await inTx(async (tx) => {
      const { ruleId } = await seed(tx);
      await syncDerivedEvents(tx, now);
      await tx
        .update(exitRules)
        .set({ params: { on: '2026-12-11' } })
        .where(eq(exitRules.id, ruleId));
      const changed = await syncDerivedEvents(tx, now);
      expect(changed.meta).toMatchObject({ dateChanges: ['OPTX moved 12/10 → 12/11'] });
      const [reminder] = (await rows(tx)).filter((e) => e.source === 'rule');
      expect(reminder).toMatchObject({ date: '2026-12-11', previousDate: '2026-12-10' });
      expect(reminder!.history).toHaveLength(1);

      await tx.delete(exitRules).where(eq(exitRules.id, ruleId));
      const after = await syncDerivedEvents(tx, now);
      expect(after.meta).toMatchObject({ cancelled: 1 });
      expect((await rows(tx)).find((e) => e.source === 'rule')!.status).toBe('cancelled');
    });
  });

  it('lets a seeded event win over a derived one within ±3 days, keeping both rows', async () => {
    await inTx(async (tx) => {
      await seed(tx);
      await upsertEvents(tx, [
        {
          ticker: 'NEWX',
          eventType: 'lockup_expiry',
          date: '2026-12-11',
          title: 'IPO lockup expiry',
          confirmed: false,
          estimated: true,
          source: 'seed',
          sourceRef: 'NEWX:lockup_expiry:2026-12-11',
        },
        {
          ticker: 'OPTX',
          eventType: 'reminder',
          date: '2026-12-10',
          title: 'Seeded decision reminder',
          confirmed: true,
          estimated: false,
          source: 'seed',
          sourceRef: 'OPTX:reminder:2026-12-10',
        },
      ]);
      await syncDerivedEvents(tx, now);
      const all = await rows(tx);
      const active = all
        .filter((e) => e.status === 'active')
        .map((e) => [e.ticker, e.eventType, e.source]);
      expect(active).toEqual([
        ['OPTX', 'reminder', 'seed'],
        ['NEWX', 'lockup_expiry', 'seed'],
        ['OPTX', 'option_expiry', 'derived'],
      ]);
      expect(
        all.find((e) => e.source === 'seed' && e.eventType === 'lockup_expiry')!.autoNote,
      ).toBe('derived estimate 12/12 (+1 day)');
      expect(
        all
          .filter((e) => e.status === 'superseded')
          .map((e) => e.source)
          .sort(),
      ).toEqual(['derived', 'rule']);
    });
  });

  it('stores AI-extracted events only with confidence and a source URL', async () => {
    await inTx(async (tx) => {
      const base = {
        ticker: 'NEWX',
        eventType: 'other' as const,
        date: '2026-12-01',
        title: 'Investor day',
        confirmed: false,
        estimated: true,
        source: 'ai_extracted' as const,
        sourceRef: 'news:1',
      };
      // Without provenance the check constraint rejects it (inside a savepoint).
      await expect(
        tx.transaction((t) => upsertEvents(t as unknown as Db, [base])),
      ).rejects.toThrow();
      const res = await upsertEvents(tx, [
        { ...base, confidence: '0.82', sourceUrl: 'https://example.com/a' },
      ]);
      expect(res.inserted).toBe(1);
    });
  });
});
