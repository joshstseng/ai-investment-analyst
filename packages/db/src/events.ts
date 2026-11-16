/**
 * Shared event storage used by every source (seed, Alpha Vantage, Alpaca, rules, derived, AI).
 * Upserts are keyed on (source, source_ref); a changed date is recorded, never overwritten
 * silently. Precedence between sources is applied by reconcileStoredEvents.
 */
import {
  dateChangePatch,
  describeDateChange,
  reconcileEvents,
  type DateChange,
  type EventSource,
  type EventTime,
  type EventType,
} from '@aia/core';
import { and, eq, gte, inArray, ne, notInArray } from 'drizzle-orm';
import type { Db } from './client';
import { events } from './schema';

export interface EventInput {
  ticker: string;
  eventType: EventType;
  date: string;
  timeOfDay?: EventTime;
  title: string;
  notes?: string | null;
  fiscalPeriod?: string | null;
  epsEstimate?: string | null;
  amount?: string | null;
  confirmed: boolean;
  estimated: boolean;
  source: EventSource;
  sourceRef: string;
  sourceUrl?: string | null;
  confidence?: string | null;
}

export interface UpsertEventsResult {
  inserted: number;
  updated: number;
  unchanged: number;
  /** e.g. "ACMX moved 11/19 → 11/20" */
  dateChanges: string[];
}

const FIELDS = [
  'ticker',
  'eventType',
  'timeOfDay',
  'title',
  'notes',
  'fiscalPeriod',
  'epsEstimate',
  'amount',
  'confirmed',
  'estimated',
  'sourceUrl',
  'confidence',
] as const;

/** Numeric columns come back as strings with scale ("1.590000"); compare canonically. */
function same(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (
    typeof a === 'string' &&
    typeof b === 'string' &&
    /^-?\d+(\.\d+)?$/.test(a) &&
    /^-?\d+(\.\d+)?$/.test(b)
  ) {
    return Number(a) === Number(b);
  }
  return a === b;
}

export async function upsertEvents(
  db: Db,
  rows: readonly EventInput[],
  now = new Date(),
): Promise<UpsertEventsResult> {
  const result: UpsertEventsResult = { inserted: 0, updated: 0, unchanged: 0, dateChanges: [] };
  if (rows.length === 0) return result;
  const bySource = new Map<EventSource, EventInput[]>();
  for (const r of rows) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);

  for (const [source, list] of bySource) {
    const existing = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.source, source),
          inArray(
            events.sourceRef,
            list.map((r) => r.sourceRef),
          ),
        ),
      );
    const byRef = new Map(existing.map((e) => [e.sourceRef, e]));
    for (const r of list) {
      const prev = byRef.get(r.sourceRef);
      const values = {
        ticker: r.ticker,
        eventType: r.eventType,
        date: r.date,
        timeOfDay: r.timeOfDay ?? 'unknown',
        title: r.title,
        notes: r.notes ?? null,
        fiscalPeriod: r.fiscalPeriod ?? null,
        epsEstimate: r.epsEstimate ?? null,
        amount: r.amount ?? null,
        confirmed: r.confirmed,
        estimated: r.estimated,
        source: r.source,
        sourceRef: r.sourceRef,
        sourceUrl: r.sourceUrl ?? null,
        confidence: r.confidence ?? null,
        fetchedAt: now,
      };
      if (!prev) {
        await db.insert(events).values(values);
        result.inserted++;
        continue;
      }
      const change = dateChangePatch(
        { date: prev.date, history: prev.history as DateChange[] },
        r.date,
        now,
        r.source,
      );
      const fieldsChanged = FIELDS.some((f) => !same(prev[f], values[f]));
      // A cancelled event that the source reports again comes back to life.
      const revived = prev.status === 'cancelled';
      if (!change && !fieldsChanged && !revived) {
        await db.update(events).set({ fetchedAt: now }).where(eq(events.id, prev.id));
        result.unchanged++;
        continue;
      }
      await db
        .update(events)
        .set({
          ...values,
          ...(change ?? {}),
          ...(revived ? { status: 'active' as const, supersededById: null } : {}),
        })
        .where(eq(events.id, prev.id));
      result.updated++;
      if (change)
        result.dateChanges.push(describeDateChange(r.ticker, change.previousDate, change.date));
    }
  }
  return result;
}

/**
 * Marks a source's future events that it no longer reports as cancelled (e.g. a deleted rule).
 * Past events are left alone. Returns the number cancelled.
 */
export async function cancelMissing(
  db: Db,
  source: EventSource,
  keepRefs: readonly string[],
  today: string,
): Promise<number> {
  const conditions = [
    eq(events.source, source),
    gte(events.date, today),
    ne(events.status, 'cancelled'),
  ];
  if (keepRefs.length) conditions.push(notInArray(events.sourceRef, [...keepRefs]));
  const res = await db
    .update(events)
    .set({ status: 'cancelled' })
    .where(and(...conditions))
    .returning({ id: events.id });
  return res.length;
}

/**
 * Applies source precedence (see PRECEDENCE in @aia/core): marks losers superseded and writes a
 * note on each winner. Only rows whose state actually changes are written.
 */
export async function reconcileStoredEvents(db: Db) {
  const rows = await db.select().from(events);
  const decisions = reconcileEvents(rows);
  const loserTarget = new Map(decisions.map((d) => [d.loserId, d.winnerId]));
  const notes = new Map<number, string[]>();
  for (const d of decisions)
    notes.set(d.winnerId, [...(notes.get(d.winnerId) ?? []), d.winnerNote]);

  let changed = 0;
  let newlySuperseded = 0;
  for (const e of rows) {
    if (e.status === 'cancelled') continue;
    const winner = loserTarget.get(e.id);
    const status = winner !== undefined ? 'superseded' : 'active';
    const supersededById = winner ?? null;
    const autoNote = notes.get(e.id)?.join('; ') ?? null;
    if (e.status !== status || e.supersededById !== supersededById || e.autoNote !== autoNote) {
      if (status === 'superseded' && e.status !== 'superseded') newlySuperseded++;
      await db.update(events).set({ status, supersededById, autoNote }).where(eq(events.id, e.id));
      changed++;
    }
  }
  return { superseded: decisions.length, newlySuperseded, changed };
}
