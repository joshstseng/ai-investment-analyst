/**
 * events.csv (gitignored, one-time seed): date,ticker,event_type,title,notes,confirmed.
 * After this import, events are maintained automatically (Alpha Vantage, Alpaca, rules,
 * derived); there is no routine manual entry.
 */
import { EVENT_TYPES, isIsoDate, parseTimeOfDay, type EventType } from '@aia/core';
import type { EventInput } from '../events';
import { SeedParseError, TICKER_RE } from './errors';
import { readCsv } from './positions-csv';

const FILE = 'events.csv';
export const EVENTS_COLUMNS = [
  'date',
  'ticker',
  'event_type',
  'title',
  'notes',
  'confirmed',
] as const;

export interface ParsedEventRow {
  line: number;
  date: string;
  ticker: string;
  eventType: EventType;
  title: string;
  notes: string | null;
  confirmed: boolean;
}

export function parseEventsCsv(text: string): ParsedEventRow[] {
  const seen = new Set<string>();
  return readCsv(FILE, text, EVENTS_COLUMNS).map(({ line, get }) => {
    const fail = (msg: string): never => {
      throw new SeedParseError(FILE, line, msg);
    };
    const date = get('date');
    if (!isIsoDate(date)) fail(`bad date "${date}"`);
    const ticker = get('ticker').toUpperCase();
    if (!TICKER_RE.test(ticker)) fail(`bad ticker "${get('ticker')}"`);
    const eventType = get('event_type').toLowerCase();
    if (!(EVENT_TYPES as readonly string[]).includes(eventType)) {
      fail(`unknown event_type "${get('event_type')}" (expected one of ${EVENT_TYPES.join(', ')})`);
    }
    const title = get('title');
    if (!title) fail('title is required');
    const confirmedRaw = get('confirmed').toLowerCase();
    if (!['true', 'false'].includes(confirmedRaw))
      fail(`confirmed must be true or false, got "${get('confirmed')}"`);
    const key = `${ticker}:${eventType}:${date}`;
    if (seen.has(key)) fail(`duplicate event ${key}`);
    seen.add(key);
    return {
      line,
      date,
      ticker,
      eventType: eventType as EventType,
      title,
      notes: get('notes') || null,
      confirmed: confirmedRaw === 'true',
    };
  });
}

/** Seed rows → event inputs. Unconfirmed rows are estimates (other sources may replace them). */
export function seedEventInputs(rows: readonly ParsedEventRow[]): EventInput[] {
  return rows.map((r) => ({
    ticker: r.ticker,
    eventType: r.eventType,
    date: r.date,
    timeOfDay: parseTimeOfDay(r.title),
    title: r.title,
    notes: r.notes,
    confirmed: r.confirmed,
    estimated: !r.confirmed,
    source: 'seed',
    sourceRef: `${r.ticker}:${r.eventType}:${r.date}`,
  }));
}
