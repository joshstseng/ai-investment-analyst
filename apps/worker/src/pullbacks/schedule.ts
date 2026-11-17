/**
 * When the three pullback checks are due (pure): New York times from config on trading days.
 * - Open: from `checks.open` (09:40 ET) until 11:00 ET; later than that an "open" check is moot.
 * - Midday: from `checks.midday` (12:30 ET) until the session's close.
 * - EOD: once today's close check has run (20 min after the close, 60 after an early close), so
 *   the official SIP closes are in.
 * Each check runs once per date.
 */
import { nyDate, zonedTimeToUtc, type PullbackCheck } from '@aia/core';
import type { CalSession } from '../schedule/market';

const OPEN_CUTOFF = '11:00';

function nyTime(date: string, hhmm: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  return zonedTimeToUtc({ year: y, month: m, day: d, hour: hh, minute: mm }, 'America/New_York');
}

export function duePullbackChecks(p: {
  sessions: readonly CalSession[];
  now: Date;
  checks: { open: string; midday: string };
  /** Checks already run, as `${date}:${check}`. */
  done: ReadonlySet<string>;
  /** Latest session whose close check succeeded. */
  closeCheckedDate: string | null;
}): { check: PullbackCheck; date: string }[] {
  const today = nyDate(p.now);
  const session = p.sessions.find((s) => s.date === today);
  if (!session) return [];
  const due: { check: PullbackCheck; date: string }[] = [];
  const not = (check: PullbackCheck) => !p.done.has(`${today}:${check}`);
  if (
    not('open') &&
    p.now >= nyTime(today, p.checks.open) &&
    p.now < nyTime(today, OPEN_CUTOFF) &&
    p.now < session.closeAt
  ) {
    due.push({ check: 'open', date: today });
  }
  if (not('midday') && p.now >= nyTime(today, p.checks.midday) && p.now < session.closeAt) {
    due.push({ check: 'midday', date: today });
  }
  if (not('eod') && p.closeCheckedDate === today) due.push({ check: 'eod', date: today });
  return due;
}
