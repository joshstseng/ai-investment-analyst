/**
 * Dated events (earnings, dividends, splits, lockups, option expiries, guidance, reminders):
 * shared vocabulary and the pure rules for duplicates, precedence and date changes.
 */
import { addDays } from './time';

export const EVENT_TYPES = [
  'earnings',
  'dividend',
  'split',
  'lockup_expiry',
  'option_expiry',
  'guidance',
  'reminder',
  'other',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Where an event came from. `ai_extracted` is reserved for a future step that reads news and
 * filings; such rows must carry `confidence` and `source_url`.
 */
export const EVENT_SOURCES = [
  'seed',
  'alphavantage',
  'alpaca',
  'rule',
  'derived',
  'ai_extracted',
] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const EVENT_TIMES = ['before_open', 'after_close', 'during_market', 'unknown'] as const;
export type EventTime = (typeof EVENT_TIMES)[number];

export const EVENT_STATUSES = ['active', 'superseded', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export interface DateChange {
  from: string;
  to: string;
  /** ISO timestamp the change was detected. */
  at: string;
  source: EventSource;
}

/** Whole days from a to b (YYYY-MM-DD); positive if b is later. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** "11/19" from "2026-11-19". */
export const shortDate = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** "ACMX moved 11/19 → 11/20" */
export function describeDateChange(ticker: string, from: string, to: string): string {
  return `${ticker} moved ${shortDate(from)} → ${shortDate(to)}`;
}

/**
 * If a source reports a different date for an event it already gave us, returns the update:
 * the new date, the previous date and an appended history entry. Null when unchanged.
 */
export function dateChangePatch(
  existing: { date: string; history: readonly DateChange[] },
  incomingDate: string,
  now: Date,
  source: EventSource,
) {
  if (existing.date === incomingDate) return null;
  return {
    date: incomingDate,
    previousDate: existing.date,
    dateChangedAt: now,
    history: [
      ...existing.history,
      { from: existing.date, to: incomingDate, at: now.toISOString(), source },
    ] as DateChange[],
  };
}

/** Time of day from free text such as "(after close; call 1:20 PM PT)". */
export function parseTimeOfDay(text: string | null | undefined): EventTime {
  if (!text) return 'unknown';
  if (/after (the )?close|post-?market|after market/i.test(text)) return 'after_close';
  if (/before (the )?open|pre-?market|before market/i.test(text)) return 'before_open';
  return 'unknown';
}

export interface ReconcileEvent {
  id: number;
  ticker: string;
  eventType: EventType;
  date: string;
  source: EventSource;
  confirmed: boolean;
  estimated: boolean;
  status: EventStatus;
  /** Used in notes when a source's details are folded into the winning event. */
  timeOfDay?: EventTime;
  epsEstimate?: string | null;
}

/**
 * Precedence between sources for the same ticker and event type:
 * - A seeded event wins over a `derived` or `rule` event within ±3 days (e.g. a researched
 *   lockup date beats the IPO+180 estimate; a seeded reminder isn't duplicated by its rule).
 * - Alpha Vantage wins over an unconfirmed seeded earnings estimate within ±45 days (it is the
 *   authority for earnings dates).
 */
export const PRECEDENCE: readonly {
  winner: EventSource;
  loser: EventSource;
  types: readonly EventType[] | 'any';
  windowDays: number;
  /** Only losers that are unconfirmed estimates. */
  loserUnconfirmedOnly: boolean;
  /** Only winners the user confirmed. */
  winnerConfirmedOnly?: boolean;
}[] = [
  { winner: 'seed', loser: 'derived', types: 'any', windowDays: 3, loserUnconfirmedOnly: false },
  { winner: 'seed', loser: 'rule', types: 'any', windowDays: 3, loserUnconfirmedOnly: false },
  {
    winner: 'alphavantage',
    loser: 'seed',
    types: ['earnings'],
    windowDays: 45,
    loserUnconfirmedOnly: true,
  },
  // A confirmed seeded date and Alpha Vantage within ±3 days are the same event: keep the
  // user's row (and notes); Alpha Vantage's date, time and estimate go into its note.
  {
    winner: 'seed',
    loser: 'alphavantage',
    types: ['earnings'],
    windowDays: 3,
    loserUnconfirmedOnly: false,
    winnerConfirmedOnly: true,
  },
];

const TIME_TEXT: Record<EventTime, string> = {
  before_open: 'before open',
  after_close: 'after close',
  during_market: 'during market',
  unknown: '',
};

export interface Supersession {
  loserId: number;
  winnerId: number;
  /** Note for the winning event, e.g. "derived estimate 12/9 (+1 day)". */
  winnerNote: string;
}

const signedDays = (n: number) =>
  n === 0 ? 'same day' : `${n > 0 ? '+' : ''}${n} day${Math.abs(n) === 1 ? '' : 's'}`;

/**
 * Decides which events are superseded by a higher-precedence one (pure). Cancelled events are
 * ignored; each loser is superseded by its nearest-dated winner.
 */
export function reconcileEvents(events: readonly ReconcileEvent[]): Supersession[] {
  const live = events.filter((e) => e.status !== 'cancelled');
  const out: Supersession[] = [];
  const taken = new Set<number>();
  for (const rule of PRECEDENCE) {
    for (const loser of live) {
      if (taken.has(loser.id) || loser.source !== rule.loser) continue;
      if (rule.types !== 'any' && !rule.types.includes(loser.eventType)) continue;
      if (rule.loserUnconfirmedOnly && loser.confirmed) continue;
      const winners = live
        .filter(
          (w) =>
            w.source === rule.winner &&
            (!rule.winnerConfirmedOnly || w.confirmed) &&
            w.ticker === loser.ticker &&
            w.eventType === loser.eventType &&
            Math.abs(daysBetween(loser.date, w.date)) <= rule.windowDays,
        )
        .sort(
          (a, b) =>
            Math.abs(daysBetween(loser.date, a.date)) - Math.abs(daysBetween(loser.date, b.date)),
        );
      const winner = winners[0];
      if (!winner) continue;
      taken.add(loser.id);
      const diff = daysBetween(winner.date, loser.date);
      const what =
        loser.source === 'rule'
          ? 'rule reminder'
          : loser.estimated
            ? `${loser.source} estimate`
            : loser.source;
      const avDetails = [
        loser.timeOfDay ? TIME_TEXT[loser.timeOfDay] : '',
        loser.epsEstimate ? `EPS est ${Number(loser.epsEstimate)}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      const label =
        loser.source === 'seed'
          ? `replaced seeded estimate ${shortDate(loser.date)}`
          : loser.source === 'alphavantage'
            ? `Alpha Vantage: ${shortDate(loser.date)}${avDetails ? ` ${avDetails}` : ''}`
            : `${what} ${shortDate(loser.date)}`;
      out.push({
        loserId: loser.id,
        winnerId: winner.id,
        winnerNote: diff === 0 ? `${label} (same day)` : `${label} (${signedDays(diff)})`,
      });
    }
  }
  return out;
}

/** Estimated IPO lockup expiry: first trading day + 180 days. */
export function lockupExpiry(firstTradingDay: string): string {
  return addDays(firstTradingDay, 180);
}
