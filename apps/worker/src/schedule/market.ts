/** Pure market-time helpers for the scheduler (holiday- and early-close-aware via the calendar). */
import { marketCalendar, type Db } from '@aia/db';
import { and, asc, gte, lte } from 'drizzle-orm';
import { addDays, nyDate } from '@aia/core';

export interface CalSession {
  date: string;
  openAt: Date;
  closeAt: Date;
  earlyClose: boolean;
}

const MIN = 60_000;
/** Close check runs 20 min after a regular close (1:20 PM PT), 60 min after an early close. */
export const CLOSE_CHECK_DELAY_MS = { regular: 20 * MIN, early: 60 * MIN } as const;

export function closeCheckAt(s: CalSession): Date {
  return new Date(
    s.closeAt.getTime() +
      (s.earlyClose ? CLOSE_CHECK_DELAY_MS.early : CLOSE_CHECK_DELAY_MS.regular),
  );
}

/** True during regular trading hours of a calendar session (holidays have no session). */
export function isMarketOpen(sessions: readonly CalSession[], now: Date): boolean {
  return sessions.some((s) => s.openAt <= now && now < s.closeAt);
}

/** The session trading today (NY date), if any. */
export function sessionOn(sessions: readonly CalSession[], date: string): CalSession | null {
  return sessions.find((s) => s.date === date) ?? null;
}

/**
 * The session whose close check should run now: the latest session whose check time has
 * passed, if it is newer than the last session already checked. Null when nothing is due.
 */
export function dueCloseCheck(
  sessions: readonly CalSession[],
  now: Date,
  lastCheckedDate: string | null,
): string | null {
  const ready = sessions.filter((s) => closeCheckAt(s) <= now).at(-1);
  if (!ready) return null;
  if (lastCheckedDate && ready.date <= lastCheckedDate) return null;
  return ready.date;
}

/** Sessions from a week back to a week ahead of `now`. */
export async function loadNearbySessions(db: Db, now = new Date()): Promise<CalSession[]> {
  const today = nyDate(now);
  return db
    .select({
      date: marketCalendar.date,
      openAt: marketCalendar.openAt,
      closeAt: marketCalendar.closeAt,
      earlyClose: marketCalendar.earlyClose,
    })
    .from(marketCalendar)
    .where(
      and(
        gte(marketCalendar.date, addDays(today, -7)),
        lte(marketCalendar.date, addDays(today, 7)),
      ),
    )
    .orderBy(asc(marketCalendar.date));
}
