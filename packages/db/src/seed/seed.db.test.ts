/**
 * Applies the fixture seed to Postgres twice inside a rolled-back transaction:
 * the second run must insert and update nothing, and verification must pass.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createDb, type Tx } from '../client';
import { loadDatabaseUrl } from '../env';
import { exitRules, holdings } from '../schema';
import { applySeedPlan } from './apply';
import { HOLDINGS_MD, OVERRIDES, POSITIONS_CSV, WATCHLIST_CSV } from './fixtures';
import { parseHoldingsMd } from './holdings-md';
import { seedOverridesSchema } from './overrides';
import { buildSeedPlan } from './plan';
import { parsePositionsCsv } from './positions-csv';
import { verifyAgainstHoldingsMd } from './verify';
import { parseWatchlistCsv } from './watchlist-csv';
import { eq, sql } from 'drizzle-orm';

const url = (() => {
  try {
    return loadDatabaseUrl();
  } catch {
    return undefined;
  }
})();

class Rollback extends Error {}

describe.skipIf(!url)('seed import (Postgres)', () => {
  const { db, sql: client } = createDb(url ?? '', { max: 1 });
  afterAll(() => client.end());

  const md = parseHoldingsMd(HOLDINGS_MD);
  const plan = buildSeedPlan({
    holdingsMd: md,
    positions: parsePositionsCsv(POSITIONS_CSV),
    watchlist: parseWatchlistCsv(WATCHLIST_CSV),
    overrides: seedOverridesSchema.parse(OVERRIDES),
  });

  async function inTx(fn: (tx: Tx) => Promise<void>) {
    await expect(
      db.transaction(async (tx) => {
        // Serialize DB tests across packages (vitest runs projects in parallel).
        await tx.execute(sql`SELECT pg_advisory_xact_lock(4242)`);
        // Isolate from any real seeded data: start each test from empty portfolio tables.
        await tx.execute(
          sql`TRUNCATE holdings, exit_rules, position_theses, watchlist, instruments, accounts RESTART IDENTITY CASCADE`,
        );
        await fn(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  it('is idempotent and matches holdings.md', async () => {
    await inTx(async (tx) => {
      const first = await applySeedPlan(tx, plan);
      expect(first.counts.holdings).toEqual({ inserted: 10, updated: 0, unchanged: 0 });
      expect(first.counts.accounts.inserted).toBe(2);

      const second = await applySeedPlan(tx, plan);
      for (const c of Object.values(second.counts)) {
        expect(c.inserted).toBe(0);
        expect(c.updated).toBe(0);
      }
      expect(second.stale).toEqual([]);
      expect(await tx.$count(holdings)).toBe(10);
      expect(await tx.$count(exitRules)).toBe(plan.rules.length);

      const verify = await verifyAgainstHoldingsMd(tx, md);
      expect(verify.problems).toEqual([]);
      expect(verify.checked).toBe(10);
    });
  });

  it('updates a changed value in place and verification catches drift', async () => {
    await inTx(async (tx) => {
      await applySeedPlan(tx, plan);
      const changed = structuredClone(plan);
      changed.holdings[0]!.quantity = '11';
      const res = await applySeedPlan(tx, changed);
      expect(res.counts.holdings).toEqual({ inserted: 0, updated: 1, unchanged: 9 });

      const verify = await verifyAgainstHoldingsMd(tx, md);
      expect(verify.ok).toBe(false);
      expect(verify.problems).toEqual(['roth_ira AAA lot 1: quantity 11.000000 ≠ 10']);
    });
  });

  it('reports rows that left the seed instead of deleting them', async () => {
    await inTx(async (tx) => {
      await applySeedPlan(tx, plan);
      const smaller = structuredClone(plan);
      smaller.rules = smaller.rules.filter((r) => r.externalKey !== 'manual:FRAC:day_move');
      const res = await applySeedPlan(tx, smaller);
      expect(res.stale).toEqual(['exit rule manual:FRAC:day_move is no longer in the seed']);
      const kept = await tx
        .select()
        .from(exitRules)
        .where(eq(exitRules.externalKey, 'manual:FRAC:day_move'));
      expect(kept).toHaveLength(1);
    });
  });
});
