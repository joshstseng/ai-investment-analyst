/**
 * Economic calendar from the ForexFactory weekly JSON (unofficial). Fetched once a day; we
 * keep USD events of High or Medium impact. Times arrive with an ET offset and are stored in
 * UTC (shown in PT). If the fetch fails, the morning email says "unavailable"; there is no
 * HEALTH alert for this optional source.
 */
import { laDate } from '@aia/core';
import { econEvents, jobRuns, type Db } from '@aia/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requestJson } from '../lib/http';
import type { JobResult } from '../lib/jobs';

export const ECON_JOB = 'econ_calendar';
export const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
export const SOURCE = 'forexfactory';
export const KEEP_IMPACTS = ['High', 'Medium'] as const;

const ffEvent = z.object({
  title: z.string(),
  country: z.string(),
  date: z.string(),
  impact: z.string(),
  forecast: z.string().optional().nullable(),
  previous: z.string().optional().nullable(),
  actual: z.string().optional().nullable(),
});
export const ffFeedSchema = z.array(ffEvent);
export type FfEvent = z.infer<typeof ffEvent>;

export interface EconEventRow {
  source: string;
  title: string;
  country: string;
  impact: string;
  at: Date;
  allDay: boolean;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
}

const blankToNull = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

/**
 * USD High/Medium events (pure). An event at exactly midnight ET is treated as all-day
 * (the feed uses that for "All Day"/"Tentative" items). `actual` only if the feed has it.
 */
export function toEconEvents(feed: readonly FfEvent[]): EconEventRow[] {
  return feed
    .filter((e) => e.country === 'USD' && (KEEP_IMPACTS as readonly string[]).includes(e.impact))
    .flatMap((e) => {
      const at = new Date(e.date);
      if (Number.isNaN(at.getTime())) return [];
      return [
        {
          source: SOURCE,
          title: e.title.trim(),
          country: e.country,
          impact: e.impact,
          at,
          allDay: /T00:00:00/.test(e.date),
          forecast: blankToNull(e.forecast),
          previous: blankToNull(e.previous),
          actual: blankToNull(e.actual),
        },
      ];
    });
}

/** Whether today's (Pacific) fetch already succeeded. */
async function fetchedToday(db: Db, now: Date) {
  const rows = await db
    .select({ startedAt: jobRuns.startedAt })
    .from(jobRuns)
    .where(
      and(
        eq(jobRuns.job, ECON_JOB),
        eq(jobRuns.status, 'success'),
        gte(jobRuns.startedAt, new Date(now.getTime() - 36 * 3_600_000)),
      ),
    );
  return rows.some((r) => laDate(r.startedAt) === laDate(now));
}

export async function econCalendarJob(
  db: Db,
  p: { now?: Date; force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<JobResult> {
  const now = p.now ?? new Date();
  if (!p.force && (await fetchedToday(db, now))) {
    return { status: 'skipped', meta: { reason: 'already fetched today' } };
  }
  const feed = await requestJson(FF_URL, {
    schema: ffFeedSchema,
    retries: 1,
    timeoutMs: 20_000,
    fetchImpl: p.fetchImpl,
    headers: { Accept: 'application/json' },
  });
  const rows = toEconEvents(feed);
  if (rows.length) {
    await db
      .insert(econEvents)
      .values(rows.map((r) => ({ ...r, fetchedAt: now })))
      .onConflictDoUpdate({
        target: [econEvents.source, econEvents.title, econEvents.at],
        set: {
          impact: sql`excluded.impact`,
          allDay: sql`excluded.all_day`,
          forecast: sql`excluded.forecast`,
          previous: sql`excluded.previous`,
          actual: sql`excluded.actual`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });
  }
  return {
    items: rows.length,
    meta: {
      feedEvents: feed.length,
      kept: rows.length,
      high: rows.filter((r) => r.impact === 'High').map((r) => `${r.title} ${r.at.toISOString()}`),
    },
  };
}
