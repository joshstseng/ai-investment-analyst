/**
 * Writes a SeedPlan with upserts keyed on natural keys, so re-running never duplicates rows.
 * Rows whose values are unchanged are not touched (updated_at stays put).
 * Rows in the DB that the plan no longer contains are reported, never deleted.
 */
import { getTableColumns, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { Tx } from '../client';
import { accounts, exitRules, holdings, instruments, positionTheses, watchlist } from '../schema';
import type { SeedPlan } from './plan';

export interface UpsertCount {
  inserted: number;
  updated: number;
  unchanged: number;
}

export interface ApplyReport {
  counts: Record<
    'accounts' | 'instruments' | 'holdings' | 'theses' | 'exitRules' | 'watchlist',
    UpsertCount
  >;
  /** DB rows not present in the seed (left in place; review manually). */
  stale: string[];
}

/** SET col = excluded.col for `keys`, only when at least one value actually differs. */
function updateChanged<T extends Record<string, PgColumn>>(columns: T, keys: (keyof T & string)[]) {
  const excluded = (k: keyof T & string) => sql.raw(`excluded."${columns[k]!.name}"`);
  const set: Record<string, SQL> = {};
  for (const k of keys) set[k] = excluded(k);
  const setWhere = or(...keys.map((k) => sql`${columns[k]} IS DISTINCT FROM ${excluded(k)}`))!;
  return { set, setWhere };
}

function allBut<T extends Record<string, PgColumn>>(columns: T, omit: string[]) {
  return Object.keys(columns).filter(
    (k) => !['id', 'createdAt', 'updatedAt', ...omit].includes(k),
  ) as (keyof T & string)[];
}

const insertedFlag = { inserted: sql<boolean>`(xmax = 0)` };

function count(total: number, returned: { inserted: boolean }[]): UpsertCount {
  const inserted = returned.filter((r) => r.inserted).length;
  return { inserted, updated: returned.length - inserted, unchanged: total - returned.length };
}

export async function applySeedPlan(tx: Tx, plan: SeedPlan): Promise<ApplyReport> {
  const stale: string[] = [];

  // Accounts
  const accCols = getTableColumns(accounts);
  const accRes = await tx
    .insert(accounts)
    .values(plan.accounts)
    .onConflictDoUpdate({
      target: accounts.accountType,
      ...updateChanged(accCols, allBut(accCols, ['accountType'])),
    })
    .returning(insertedFlag);
  const accountIds = new Map(
    (await tx.select({ id: accounts.id, t: accounts.accountType }).from(accounts)).map((r) => [
      r.t,
      r.id,
    ]),
  );

  // Instruments
  const instCols = getTableColumns(instruments);
  const instRes = await tx
    .insert(instruments)
    .values(plan.instruments)
    .onConflictDoUpdate({
      target: instruments.symbol,
      ...updateChanged(instCols, allBut(instCols, ['symbol'])),
    })
    .returning(insertedFlag);
  const instrumentIds = new Map(
    (await tx.select({ id: instruments.id, s: instruments.symbol }).from(instruments)).map((r) => [
      r.s,
      r.id,
    ]),
  );
  const instId = (symbol: string) => {
    const id = instrumentIds.get(symbol);
    if (id === undefined) throw new Error(`instrument ${symbol} missing after upsert`);
    return id;
  };

  // Holdings (one row per lot)
  const holdingRows = plan.holdings.map(({ accountType, symbol, ...h }) => ({
    ...h,
    accountId: accountIds.get(accountType)!,
    instrumentId: instId(symbol),
  }));
  const holdCols = getTableColumns(holdings);
  const holdRes = holdingRows.length
    ? await tx
        .insert(holdings)
        .values(holdingRows)
        .onConflictDoUpdate({
          target: [holdings.accountId, holdings.instrumentId, holdings.lotNo],
          ...updateChanged(holdCols, allBut(holdCols, ['accountId', 'instrumentId', 'lotNo'])),
        })
        .returning(insertedFlag)
    : [];
  const holdingKeys = new Set(
    holdingRows.map((h) => `${h.accountId}:${h.instrumentId}:${h.lotNo}`),
  );
  for (const h of await tx.select().from(holdings)) {
    if (!holdingKeys.has(`${h.accountId}:${h.instrumentId}:${h.lotNo}`) && h.status !== 'closed') {
      stale.push(
        `holding id=${h.id} (account ${h.accountId}, instrument ${h.instrumentId}, lot ${h.lotNo}) is not in holdings.md`,
      );
    }
  }

  // Theses
  const thesisRows = plan.theses.map(({ symbol, ...t }) => ({
    ...t,
    instrumentId: instId(symbol),
  }));
  const thCols = getTableColumns(positionTheses);
  const thRes = thesisRows.length
    ? await tx
        .insert(positionTheses)
        .values(thesisRows)
        .onConflictDoUpdate({
          target: positionTheses.instrumentId,
          ...updateChanged(thCols, allBut(thCols, ['instrumentId'])),
        })
        .returning(insertedFlag)
    : [];

  // Exit rules
  const ruleRows = plan.rules.map(({ symbol, ...r }) => ({ ...r, instrumentId: instId(symbol) }));
  const ruleCols = getTableColumns(exitRules);
  const ruleRes = ruleRows.length
    ? await tx
        .insert(exitRules)
        .values(ruleRows)
        .onConflictDoUpdate({
          target: exitRules.externalKey,
          ...updateChanged(ruleCols, allBut(ruleCols, ['externalKey'])),
        })
        .returning(insertedFlag)
    : [];
  const planKeys = new Set(plan.rules.map((r) => r.externalKey));
  const seededRules = await tx
    .select({ id: exitRules.id, key: exitRules.externalKey })
    .from(exitRules)
    .where(
      or(
        sql`${exitRules.externalKey} LIKE 'positions:%'`,
        sql`${exitRules.externalKey} LIKE 'manual:%'`,
        sql`${exitRules.externalKey} LIKE 'default:%'`,
      ),
    );
  for (const r of seededRules) {
    if (r.key && !planKeys.has(r.key)) stale.push(`exit rule ${r.key} is no longer in the seed`);
  }

  // Watchlist
  const watchRows = plan.watchlist.map(({ symbol, ...w }) => ({
    ...w,
    instrumentId: instId(symbol),
  }));
  const wCols = getTableColumns(watchlist);
  const wRes = watchRows.length
    ? await tx
        .insert(watchlist)
        .values(watchRows)
        .onConflictDoUpdate({
          target: watchlist.instrumentId,
          ...updateChanged(wCols, allBut(wCols, ['instrumentId'])),
        })
        .returning(insertedFlag)
    : [];
  const watchIds = watchRows.map((w) => w.instrumentId);
  const staleWatch = await tx
    .select({ id: watchlist.id, instrumentId: watchlist.instrumentId })
    .from(watchlist)
    .where(watchIds.length ? notInArray(watchlist.instrumentId, watchIds) : undefined);
  for (const w of staleWatch) stale.push(`watchlist id=${w.id} is not in watchlist.csv`);

  return {
    counts: {
      accounts: count(plan.accounts.length, accRes),
      instruments: count(plan.instruments.length, instRes),
      holdings: count(holdingRows.length, holdRes),
      theses: count(thesisRows.length, thRes),
      exitRules: count(ruleRows.length, ruleRes),
      watchlist: count(watchRows.length, wRes),
    },
    stale,
  };
}
