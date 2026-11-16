/**
 * Dividends and splits for holdings from Alpaca's corporate-actions API (source=alpaca).
 * Events are dated on the ex-date (what matters for price and eligibility); the record and
 * pay dates go in the title. Each Alpaca action id is a stable source_ref, so re-runs are
 * idempotent and a moved ex-date is recorded as a date change.
 */
import { addDays, canonical, nyDate } from '@aia/core';
import {
  cancelMissing,
  holdings,
  instruments,
  reconcileStoredEvents,
  upsertEvents,
  type Db,
  type EventInput,
} from '@aia/db';
import { eq, ne } from 'drizzle-orm';
import type { AlpacaClient } from '../alpaca/client';
import type { CashDividend, Split } from '../alpaca/schemas';
import type { JobResult } from '../lib/jobs';

/** The query window: recent actions (to catch late announcements) through 4 months ahead. */
export const LOOKBACK_DAYS = 14;
export const LOOKAHEAD_DAYS = 120;

const shortDate = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const rate = (n: number) => canonical(n.toFixed(6));

/** Pure mapping from Alpaca actions to events. Actions without an ex-date are skipped. */
export function corporateActionEvents(a: {
  dividends: readonly CashDividend[];
  forwardSplits: readonly Split[];
  reverseSplits: readonly Split[];
}): EventInput[] {
  const out: EventInput[] = [];
  for (const d of a.dividends) {
    if (!d.ex_date) continue;
    const pay = d.payable_date ? `, pays ${shortDate(d.payable_date)}` : '';
    out.push({
      ticker: d.symbol,
      eventType: 'dividend',
      date: d.ex_date,
      timeOfDay: 'before_open',
      title: `${d.special ? 'Special dividend' : 'Dividend'} $${rate(d.rate)}/share (ex-date${pay})`,
      notes: d.record_date ? `Record date ${d.record_date}` : null,
      amount: rate(d.rate),
      confirmed: true,
      estimated: false,
      source: 'alpaca',
      sourceRef: d.id,
    });
  }
  const split = (s: Split, kind: 'forward' | 'reverse') => {
    if (!s.ex_date) return;
    const ratio = `${canonical(String(s.new_rate))}-for-${canonical(String(s.old_rate))}`;
    out.push({
      ticker: s.symbol,
      eventType: 'split',
      date: s.ex_date,
      timeOfDay: 'before_open',
      title: `${kind === 'reverse' ? 'Reverse split' : 'Stock split'} ${ratio} (ex-date)`,
      amount: rate(s.new_rate / s.old_rate),
      confirmed: true,
      estimated: false,
      source: 'alpaca',
      sourceRef: s.id,
    });
  };
  a.forwardSplits.forEach((s) => split(s, 'forward'));
  a.reverseSplits.forEach((s) => split(s, 'reverse'));
  return out;
}

export async function syncCorporateActions(
  db: Db,
  client: AlpacaClient,
  now = new Date(),
): Promise<JobResult> {
  const today = nyDate(now);
  const held = await db
    .selectDistinct({ symbol: instruments.symbol })
    .from(holdings)
    .innerJoin(instruments, eq(holdings.instrumentId, instruments.id))
    .where(ne(instruments.instrumentType, 'option'));
  const symbols = held.map((h) => h.symbol).sort();
  if (symbols.length === 0) return { status: 'skipped', meta: { reason: 'no holdings' } };

  const actions = await client.corporateActions({
    symbols,
    start: addDays(today, -LOOKBACK_DAYS),
    end: addDays(today, LOOKAHEAD_DAYS),
  });
  const input = corporateActionEvents(actions);
  const res = await upsertEvents(db, input, now);
  // Only future events inside the window we just queried can be "missing".
  const cancelled = await cancelMissing(
    db,
    'alpaca',
    input.map((e) => e.sourceRef),
    today,
  );
  await reconcileStoredEvents(db);
  return {
    items: input.length,
    meta: {
      symbols: symbols.length,
      dividends: actions.dividends.length,
      splits: actions.forwardSplits.length + actions.reverseSplits.length,
      upcoming: input.filter((e) => e.date >= today).map((e) => `${e.ticker} ${e.date} ${e.title}`),
      inserted: res.inserted,
      updated: res.updated,
      dateChanges: res.dateChanges,
      cancelled,
    },
  };
}
