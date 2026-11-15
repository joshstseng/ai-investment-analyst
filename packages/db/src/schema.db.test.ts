/**
 * Integration tests for constraints and triggers. Needs local Postgres (`pnpm db:up && pnpm db:migrate`).
 * Every test runs in a transaction that is rolled back, so it never leaves data behind.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client';
import { loadDatabaseUrl } from './env';
import { accounts, exitRules, holdings, instruments } from './schema';

const url = (() => {
  try {
    return loadDatabaseUrl();
  } catch {
    return undefined;
  }
})();

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

class Rollback extends Error {}

describe.skipIf(!url)('schema constraints (Postgres)', () => {
  const { db, sql: client } = createDb(url ?? '', { max: 1 });
  afterAll(() => client.end());

  /** Run `fn` in a transaction and always roll it back. */
  async function inTx(fn: (tx: Tx) => Promise<void>) {
    await expect(
      db.transaction(async (tx) => {
        // Serialize DB tests across packages (vitest runs projects in parallel).
        await tx.execute(sql`SELECT pg_advisory_xact_lock(4242)`);
        await fn(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  /** Expect `fn` to violate `constraint`; uses a savepoint so the outer transaction survives. */
  async function expectViolation(tx: Tx, constraint: string, fn: (tx: Tx) => Promise<unknown>) {
    const err = await tx.transaction(fn).then(
      () => undefined,
      (e: unknown) => e,
    );
    const cause = (err as { cause?: { constraint_name?: string } } | undefined)?.cause;
    expect(cause?.constraint_name ?? String(err)).toBe(constraint);
  }

  async function account(tx: Tx, type: 'roth_ira' | 'individual_taxable') {
    await tx
      .insert(accounts)
      .values({ name: `test-${type}`, accountType: type, taxAdvantaged: type === 'roth_ira' })
      .onConflictDoNothing();
    const [row] = await tx.select().from(accounts).where(eq(accounts.accountType, type));
    return row!.id;
  }

  async function stock(tx: Tx, symbol: string) {
    const [row] = await tx
      .insert(instruments)
      .values({ symbol, instrumentType: 'stock' })
      .returning();
    return row!.id;
  }

  it('stores missing values as NULL only when flagged in needs_input', async () => {
    await inTx(async (tx) => {
      const acct = await account(tx, 'roth_ira');
      const inst = await stock(tx, 'ZZTEST1');
      await expectViolation(tx, 'holdings_avg_cost_null_flagged', (t) =>
        t.insert(holdings).values({ accountId: acct, instrumentId: inst, quantity: '5' }),
      );
      const [row] = await tx
        .insert(holdings)
        .values({ accountId: acct, instrumentId: inst, quantity: '5', needsInput: ['avg_cost'] })
        .returning();
      expect(row!.avgCost).toBeNull();
      expect(row!.needsInput).toEqual(['avg_cost']);
    });
  });

  it('allows one ticker in both accounts and several lots per account, but no duplicate lot', async () => {
    await inTx(async (tx) => {
      const roth = await account(tx, 'roth_ira');
      const indiv = await account(tx, 'individual_taxable');
      const inst = await stock(tx, 'ZZTEST2');
      await tx.insert(holdings).values([
        { accountId: roth, instrumentId: inst, lotNo: 1, quantity: '30', avgCost: '50.10' },
        { accountId: indiv, instrumentId: inst, lotNo: 1, quantity: '4', avgCost: '49.90' },
        { accountId: indiv, instrumentId: inst, lotNo: 2, quantity: '6', avgCost: '50.20' },
      ]);
      await expectViolation(tx, 'holdings_account_instrument_lot', (t) =>
        t
          .insert(holdings)
          .values({ accountId: indiv, instrumentId: inst, lotNo: 2, quantity: '1', avgCost: '1' }),
      );
    });
  });

  it('keeps fractional quantities exact', async () => {
    await inTx(async (tx) => {
      const acct = await account(tx, 'roth_ira');
      const inst = await stock(tx, 'ZZTEST3');
      const [row] = await tx
        .insert(holdings)
        .values({ accountId: acct, instrumentId: inst, quantity: '12.345', avgCost: '7.03' })
        .returning();
      expect(Number(row!.quantity)).toBe(12.345);
      expect(Number(row!.avgCost)).toBe(7.03);
    });
  });

  it('requires underlying/right/strike/expiry for options and forbids them otherwise', async () => {
    await inTx(async (tx) => {
      await expectViolation(tx, 'instruments_option_fields', (t) =>
        t.insert(instruments).values({ symbol: 'ZZOPT1', instrumentType: 'option' }),
      );
      await expectViolation(tx, 'instruments_option_fields', (t) =>
        t.insert(instruments).values({ symbol: 'ZZSTK1', instrumentType: 'stock', strike: '5' }),
      );
      await tx.insert(instruments).values({
        symbol: 'ZZTT270319C00006000',
        instrumentType: 'option',
        underlyingSymbol: 'ZZTT',
        optionRight: 'call',
        strike: '6',
        expiry: '2027-03-19',
        multiplier: 100,
      });
      await tx.insert(instruments).values({ symbol: 'ZZOTCF', instrumentType: 'otc_stock' });
    });
  });

  it('requires a CONFIRMED rule to be machine-checkable or have judgment triggers', async () => {
    await inTx(async (tx) => {
      const inst = await stock(tx, 'ZZTEST4');
      await expectViolation(tx, 'exit_rules_confirmed_is_actionable', (t) =>
        t
          .insert(exitRules)
          .values({ instrumentId: inst, purpose: 'risk_stop', status: 'CONFIRMED' }),
      );
      await tx.insert(exitRules).values([
        { instrumentId: inst, purpose: 'risk_stop', status: 'PLACEHOLDER' },
        {
          instrumentId: inst,
          purpose: 'risk_stop',
          status: 'CONFIRMED',
          ruleType: 'stop_close_below',
          params: { level: '1.20' },
        },
        {
          instrumentId: inst,
          purpose: 'thesis_break',
          status: 'CONFIRMED',
          thesisBreakTriggers: 'equity raise / placing',
        },
      ]);
    });
  });

  it('stores timestamps in UTC and bumps updated_at on update', async () => {
    await inTx(async (tx) => {
      const tzRows = (await tx.execute(
        sql`SELECT current_setting('TimeZone') AS tz`,
      )) as unknown as {
        tz: string;
      }[];
      expect(tzRows[0]!.tz).toBe('UTC');

      const inst = await stock(tx, 'ZZTEST5');
      // Backdate, then update: the trigger must set updated_at to now().
      await tx.execute(
        sql`UPDATE instruments SET created_at = '2000-01-01', name = 'x' WHERE id = ${inst}`,
      );
      await tx.execute(sql`UPDATE instruments SET updated_at = '2000-01-01' WHERE id = ${inst}`);
      const [row] = await tx.select().from(instruments).where(eq(instruments.id, inst));
      expect(row!.createdAt.toISOString()).toBe('2000-01-01T00:00:00.000Z');
      expect(row!.updatedAt.getUTCFullYear()).toBeGreaterThan(2000);
    });
  });
});
