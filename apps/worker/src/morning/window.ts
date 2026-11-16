/**
 * The morning email's window and mode (pure).
 * - The window runs from the previous trading session's close to now (so after a holiday it
 *   covers the holiday, and early closes are respected).
 * - Recap mode ("weekend recap + week ahead") is used on the first trading day of the week:
 *   normally Monday, or Tuesday when Monday is a holiday.
 * - On a weekday without a session (holiday) the email is the short "market closed" version.
 */
import { nyDate, weekStart } from '@aia/core';
import type { CalSession } from '../schedule/market';

export interface MorningWindow {
  today: string;
  session: CalSession | null;
  prev: CalSession | null;
  next: CalSession | null;
  recap: boolean;
  closed: boolean;
  start: Date;
  end: Date;
}

export function morningWindow(sessions: readonly CalSession[], now: Date): MorningWindow {
  const today = nyDate(now);
  const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date));
  const session = sorted.find((s) => s.date === today) ?? null;
  const prev = sorted.filter((s) => s.date < today).at(-1) ?? null;
  const next = sorted.find((s) => s.date > today) ?? null;
  const recap = !!session && (!prev || weekStart(prev.date) !== weekStart(today));
  return {
    today,
    session,
    prev,
    next,
    recap,
    closed: !session,
    start: prev ? prev.closeAt : new Date(now.getTime() - 86_400_000),
    end: now,
  };
}

const laParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Sent from 5:45 AM PT. */
export const MORNING_AT = { hour: 5, minute: 45 } as const;

/**
 * The (Pacific) date whose morning email should go out now, or null (pure): weekdays only
 * (holidays get the "market closed" version), at/after 5:45 AM PT, once per day.
 */
export function morningDueDate(
  now: Date,
  lastSentDate: string | null,
  laToday: string,
): string | null {
  const parts = Object.fromEntries(laParts.formatToParts(now).map((p) => [p.type, p.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return null;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (minutes < MORNING_AT.hour * 60 + MORNING_AT.minute) return null;
  if (lastSentDate && lastSentDate >= laToday) return null;
  return laToday;
}
