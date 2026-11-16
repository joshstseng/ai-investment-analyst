/** Time-zone helpers. Storage is always UTC; these convert wall-clock times in a named zone. */

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

export interface WallClock {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour?: number;
  minute?: number;
}

/** Converts a wall-clock time in `timeZone` (e.g. America/New_York) to a UTC Date. DST-aware. */
export function zonedTimeToUtc(t: WallClock, timeZone: string): Date {
  const guess = Date.UTC(t.year, t.month - 1, t.day, t.hour ?? 0, t.minute ?? 0);
  const first = guess - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess - zoneOffsetMs(new Date(first), timeZone));
}

/** True if `s` is a real calendar date in YYYY-MM-DD form. */
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const nyDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Calendar date (YYYY-MM-DD) of `instant` in America/New_York, the exchange's trading date. */
export function nyDate(instant: Date): string {
  return nyDateFormat.format(instant);
}

/** Adds whole days to a YYYY-MM-DD date. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const laHourFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  hour: '2-digit',
});

/** Hour of day (0–23) in America/Los_Angeles. */
export function laHour(instant: Date): number {
  return Number(laHourFormat.format(instant));
}

/** EDGAR polling window: 5:00 AM to 9:00 PM Pacific (filings are accepted 6 AM–10 PM ET). */
export function inEdgarWindow(instant: Date): boolean {
  const h = laHour(instant);
  return h >= 5 && h < 21;
}

const laDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Calendar date (YYYY-MM-DD) of `instant` in America/Los_Angeles. */
export function laDate(instant: Date): string {
  return laDateFormat.format(instant);
}

/** Monday (YYYY-MM-DD) of the week containing `isoDate`. */
export function weekStart(isoDate: string): string {
  const dow = (new Date(`${isoDate}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(isoDate, -dow);
}
