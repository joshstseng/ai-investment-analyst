/**
 * Independent check that the database matches holdings.md exactly: every lot's ticker,
 * account, quantity and average cost, and nothing extra. Compares against the parsed file,
 * not the plan, so a bug in planning or applying would show up here.
 */
import { canonical, decimalEquals } from '@aia/core';
import { eq, ne } from 'drizzle-orm';
import type { Tx } from '../client';
import { accounts, holdings, instruments } from '../schema';
import type { ParsedHoldingsMd } from './holdings-md';
import { resolveSymbol } from './plan';

export interface VerifyResult {
  ok: boolean;
  checked: number;
  problems: string[];
}

export async function verifyAgainstHoldingsMd(tx: Tx, md: ParsedHoldingsMd): Promise<VerifyResult> {
  const rows = await tx
    .select({
      accountType: accounts.accountType,
      cash: accounts.cashBalance,
      total: accounts.totalValue,
      symbol: instruments.symbol,
      lotNo: holdings.lotNo,
      quantity: holdings.quantity,
      avgCost: holdings.avgCost,
    })
    .from(holdings)
    .innerJoin(accounts, eq(holdings.accountId, accounts.id))
    .innerJoin(instruments, eq(holdings.instrumentId, instruments.id))
    .where(ne(holdings.status, 'closed'));

  const problems: string[] = [];
  const key = (a: string, s: string, l: number) => `${a} ${s} lot ${l}`;
  const actual = new Map(rows.map((r) => [key(r.accountType, r.symbol, r.lotNo), r]));
  let checked = 0;

  for (const account of md.accounts) {
    const dbAccount = (await tx.select().from(accounts)).find(
      (a) => a.accountType === account.accountType,
    );
    if (!dbAccount) {
      problems.push(`${account.accountType}: account missing`);
      continue;
    }
    for (const [label, expected, got] of [
      ['cash', account.cashBalance, dbAccount.cashBalance],
      ['total', account.totalValue, dbAccount.totalValue],
    ] as const) {
      if (expected !== null && (got === null || !decimalEquals(expected, got))) {
        problems.push(`${account.accountType} ${label}: expected ${expected}, got ${got}`);
      }
    }

    for (const row of account.rows) {
      const { symbol } = resolveSymbol(row.ticker);
      row.lots.forEach((lot, i) => {
        checked++;
        const k = key(account.accountType, symbol, i + 1);
        const got = actual.get(k);
        if (!got) {
          problems.push(`${k}: missing (${row.ticker})`);
          return;
        }
        actual.delete(k);
        if (got.quantity === null || !decimalEquals(got.quantity, lot.quantity)) {
          problems.push(`${k}: quantity ${got.quantity} ≠ ${lot.quantity}`);
        }
        if (got.avgCost === null || !decimalEquals(got.avgCost, lot.avgCost)) {
          problems.push(`${k}: avg cost ${got.avgCost} ≠ ${lot.avgCost}`);
        }
      });
    }
  }
  for (const [k, r] of actual) {
    problems.push(`${k}: in database but not in holdings.md (qty ${canonical(r.quantity ?? '0')})`);
  }
  return { ok: problems.length === 0, checked, problems };
}
