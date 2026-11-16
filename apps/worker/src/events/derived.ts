/**
 * Events derived from our own data, synced automatically (no manual entry):
 * - reminders from date_reminder rules (source=rule)
 * - option expiries from held option contracts (source=derived)
 * - estimated IPO lockup expiries (first trading day + 180 days) for holdings that listed in
 *   the last 12 months (source=derived)
 * Then source precedence is applied (a seeded event of the same type within ±3 days wins).
 */
import { addDays, lockupExpiry, nyDate, optionLabel } from '@aia/core';
import {
  cancelMissing,
  exitRules,
  holdings,
  instruments,
  pricesDaily,
  reconcileStoredEvents,
  upsertEvents,
  type Db,
  type EventInput,
} from '@aia/db';
import { eq, inArray, min, ne } from 'drizzle-orm';
import type { JobResult } from '../lib/jobs';

/** A first bar this many days after the history begins means the stock listed during it. */
const LISTED_AFTER_HISTORY_START_DAYS = 7;

export interface ListingInput {
  symbol: string;
  firstBar: string;
}

/**
 * Lockup estimates (pure): for each held symbol whose first daily bar is well after the start
 * of our bar history and within the last 12 months, first trading day + 180 days.
 */
export function lockupEvents(
  listings: readonly ListingInput[],
  historyStart: string,
  today: string,
): EventInput[] {
  const cutoff = addDays(historyStart, LISTED_AFTER_HISTORY_START_DAYS);
  return listings
    .filter((l) => l.firstBar > cutoff && l.firstBar >= addDays(today, -365))
    .map((l) => ({
      ticker: l.symbol,
      eventType: 'lockup_expiry' as const,
      date: lockupExpiry(l.firstBar),
      title: 'IPO lockup expiry (estimated)',
      notes: `Estimated: first trading day ${l.firstBar} + 180 days`,
      confirmed: false,
      estimated: true,
      source: 'derived' as const,
      sourceRef: `lockup:${l.symbol}`,
    }));
}

export async function syncDerivedEvents(db: Db, now = new Date()): Promise<JobResult> {
  const today = nyDate(now);

  // Reminders from date_reminder rules.
  const reminderRules = await db
    .select({
      id: exitRules.id,
      key: exitRules.externalKey,
      params: exitRules.params,
      alertNote: exitRules.alertNote,
      symbol: instruments.symbol,
      underlying: instruments.underlyingSymbol,
    })
    .from(exitRules)
    .innerJoin(instruments, eq(exitRules.instrumentId, instruments.id))
    .where(eq(exitRules.ruleType, 'date_reminder'));
  const reminders: EventInput[] = reminderRules.flatMap((r) => {
    const on = (r.params as { on?: unknown }).on;
    if (typeof on !== 'string') return [];
    return [
      {
        ticker: r.underlying ?? r.symbol,
        eventType: 'reminder' as const,
        date: on,
        title: r.alertNote ?? 'Reminder',
        notes: r.underlying ? `Option ${r.symbol}` : null,
        confirmed: true,
        estimated: false,
        source: 'rule' as const,
        sourceRef: r.key ?? `rule:${r.id}`,
      },
    ];
  });

  // Held instruments (for option expiries and lockups).
  const held = await db
    .selectDistinct({
      symbol: instruments.symbol,
      type: instruments.instrumentType,
      underlying: instruments.underlyingSymbol,
      right: instruments.optionRight,
      strike: instruments.strike,
      expiry: instruments.expiry,
    })
    .from(holdings)
    .innerJoin(instruments, eq(holdings.instrumentId, instruments.id))
    .where(ne(holdings.status, 'closed'));

  const expiries: EventInput[] = held
    .filter((h) => h.type === 'option' && h.expiry && h.underlying && h.right && h.strike)
    .map((h) => ({
      ticker: h.underlying!,
      eventType: 'option_expiry' as const,
      date: h.expiry!,
      title: `${optionLabel({ underlying: h.underlying!, right: h.right!, strike: String(Number(h.strike)), expiry: h.expiry! })} expires`,
      confirmed: true,
      estimated: false,
      source: 'derived' as const,
      sourceRef: `option_expiry:${h.symbol}`,
    }));

  const equities = held.filter((h) => h.type !== 'option').map((h) => h.symbol);
  const firstBars = equities.length
    ? await db
        .select({ symbol: pricesDaily.symbol, first: min(pricesDaily.date) })
        .from(pricesDaily)
        .where(inArray(pricesDaily.symbol, equities))
        .groupBy(pricesDaily.symbol)
    : [];
  const [start] = await db.select({ first: min(pricesDaily.date) }).from(pricesDaily);
  const lockups = start?.first
    ? lockupEvents(
        firstBars.filter((f) => f.first).map((f) => ({ symbol: f.symbol, firstBar: f.first! })),
        start.first,
        today,
      )
    : [];

  const ruleRes = await upsertEvents(db, reminders, now);
  const derived = [...expiries, ...lockups];
  const derivedRes = await upsertEvents(db, derived, now);
  const cancelled =
    (await cancelMissing(
      db,
      'rule',
      reminders.map((r) => r.sourceRef),
      today,
    )) +
    (await cancelMissing(
      db,
      'derived',
      derived.map((d) => d.sourceRef),
      today,
    ));
  const reconcile = await reconcileStoredEvents(db);

  return {
    items: reminders.length + derived.length,
    meta: {
      reminders: reminders.length,
      optionExpiries: expiries.length,
      lockups: lockups.map((l) => `${l.ticker} ${l.date}`),
      inserted: ruleRes.inserted + derivedRes.inserted,
      updated: ruleRes.updated + derivedRes.updated,
      dateChanges: [...ruleRes.dateChanges, ...derivedRes.dateChanges],
      cancelled,
      superseded: reconcile.newlySuperseded,
    },
  };
}
