import { addDays, nyDate, zonedTimeToUtc } from '@aia/core';
import { marketCalendar, type Db } from '@aia/db';
import { and, gte, lte, sql } from 'drizzle-orm';
import type { AlpacaClient } from '../alpaca/client';
import type { AlpacaCalendarDay } from '../alpaca/schemas';
import type { JobResult } from '../lib/jobs';

const NY = 'America/New_York';
const REGULAR_CLOSE = '16:00';

function at(date: string, hhmm: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = (
    hhmm.includes(':') ? hhmm.split(':') : [hhmm.slice(0, 2), hhmm.slice(2)]
  ).map(Number) as [number, number];
  return zonedTimeToUtc({ year: y, month: m, day: d, hour, minute }, NY);
}

export function calendarRow(day: AlpacaCalendarDay) {
  return {
    date: day.date,
    openAt: at(day.date, day.open),
    closeAt: at(day.date, day.close),
    sessionOpenAt: day.session_open ? at(day.date, day.session_open) : null,
    sessionCloseAt: day.session_close ? at(day.date, day.session_close) : null,
    earlyClose: day.close !== REGULAR_CLOSE,
  };
}

/** Stores trading days from ~13 months back to ~13 months ahead. */
export async function syncCalendar(
  db: Db,
  client: AlpacaClient,
  now = new Date(),
): Promise<JobResult> {
  const today = nyDate(now);
  const days = await client.calendar(addDays(today, -400), addDays(today, 400));
  if (days.length === 0) throw new Error('Alpaca calendar returned no trading days');
  const rows = days.map(calendarRow);
  await db
    .insert(marketCalendar)
    .values(rows)
    .onConflictDoUpdate({
      target: marketCalendar.date,
      set: {
        openAt: sql`excluded.open_at`,
        closeAt: sql`excluded.close_at`,
        sessionOpenAt: sql`excluded.session_open_at`,
        sessionCloseAt: sql`excluded.session_close_at`,
        earlyClose: sql`excluded.early_close`,
      },
      setWhere: sql`(${marketCalendar.openAt}, ${marketCalendar.closeAt}, ${marketCalendar.earlyClose}) IS DISTINCT FROM (excluded.open_at, excluded.close_at, excluded.early_close)`,
    });
  const early = rows.filter((r) => r.earlyClose && r.date >= today).slice(0, 3);
  return {
    items: rows.length,
    meta: {
      from: rows[0]!.date,
      to: rows.at(-1)!.date,
      upcomingEarlyCloses: early.map((r) => r.date),
    },
  };
}

export interface Session {
  date: string;
  closeAt: Date;
  earlyClose: boolean;
}

export async function loadSessions(db: Db, from: string, to: string) {
  const rows = await db
    .select({
      date: marketCalendar.date,
      closeAt: marketCalendar.closeAt,
      earlyClose: marketCalendar.earlyClose,
    })
    .from(marketCalendar)
    .where(and(gte(marketCalendar.date, from), lte(marketCalendar.date, to)));
  return new Map<string, Session>(rows.map((r) => [r.date, r]));
}
