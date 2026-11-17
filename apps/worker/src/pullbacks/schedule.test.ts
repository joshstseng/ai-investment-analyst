import { describe, expect, it } from 'vitest';
import { calendarRow } from '../market/calendar';
import type { CalSession } from '../schedule/market';
import { duePullbackChecks } from './schedule';

const s = (date: string, close = '16:00'): CalSession => {
  const r = calendarRow({ date, open: '09:30', close });
  return { date, openAt: r.openAt, closeAt: r.closeAt, earlyClose: r.earlyClose };
};
const sessions = [s('2026-11-24'), s('2026-11-25'), s('2026-11-27', '13:00')];
const checks = { open: '09:40', midday: '12:30' };
const due = (iso: string, done: string[] = [], closeCheckedDate: string | null = null) =>
  duePullbackChecks({
    sessions,
    now: new Date(iso),
    checks,
    done: new Set(done),
    closeCheckedDate,
  }).map((d) => d.check);

describe('duePullbackChecks (New York times, once per day)', () => {
  it.each<[string, string, string[], string | null, string[]]>([
    ['9:39 ET: nothing yet', '2026-11-24T14:39:00Z', [], null, []],
    ['9:40 ET: open', '2026-11-24T14:40:00Z', [], null, ['open']],
    ['10:30 ET after a restart: open catches up', '2026-11-24T15:30:00Z', [], null, ['open']],
    ['11:00 ET: open is moot', '2026-11-24T16:00:00Z', [], null, []],
    ['open already ran', '2026-11-24T14:45:00Z', ['2026-11-24:open'], null, []],
    ['12:30 ET: midday', '2026-11-24T17:30:00Z', ['2026-11-24:open'], null, ['midday']],
    [
      'after the close, before the close check: nothing',
      '2026-11-24T21:05:00Z',
      ['2026-11-24:open', '2026-11-24:midday'],
      '2026-11-23',
      [],
    ],
    [
      'close check done: EOD',
      '2026-11-24T21:21:00Z',
      ['2026-11-24:open', '2026-11-24:midday'],
      '2026-11-24',
      ['eod'],
    ],
    ['Thanksgiving: nothing', '2026-11-26T15:00:00Z', [], null, []],
    [
      'early close: midday at 12:30 ET still before the 1:00 PM close',
      '2026-11-27T17:30:00Z',
      ['2026-11-27:open'],
      null,
      ['midday'],
    ],
    ['early close: no midday after 1:00 PM', '2026-11-27T18:05:00Z', ['2026-11-27:open'], null, []],
  ])('%s', (_name, now, done, closeChecked, expected) => {
    expect(due(now, done, closeChecked)).toEqual(expected);
  });
});
