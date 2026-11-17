/**
 * Earnings dates from Alpha Vantage's EARNINGS_CALENDAR (one CSV for the whole market,
 * horizon 3 months), kept only for tickers we follow. Alpha Vantage is the authority for
 * earnings dates: its date replaces an unconfirmed seeded estimate within ±45 days (see
 * PRECEDENCE in @aia/core), and a changed date is recorded as a date change.
 *
 * Budget: the free plan allows 25 requests/day; we make at most 2 per Pacific day (5:00 and,
 * only if that failed, 5:30) and never retry inside a call. If it fails 2 days in a row we send
 * one HEALTH email, and one more when it recovers.
 */
import { laDate, nyDate } from '@aia/core';
import {
  cancelMissing,
  feedStatus,
  jobRuns,
  reconcileStoredEvents,
  upsertEvents,
  type Db,
  type EventInput,
} from '@aia/db';
import { parse } from 'csv-parse/sync';
import { and, desc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { recordFeedStatus } from '../health/feed-status';
import { requestJson } from '../lib/http';
import type { JobResult } from '../lib/jobs';
import { log } from '../lib/log';
import { loadUniverse } from '../market/universe';
import { loadPullbackConfig } from '../pullbacks/config';
import { loadScreenUniverse } from '../pullbacks/universe';
import { composeHealthAlert } from '../notify/health-alerts';
import { enqueueAlert } from '../notify/outbox';

export const EARNINGS_JOB = 'earnings_calendar';
export const EARNINGS_FEED = 'alphavantage_calendar';
export const MAX_CALLS_PER_DAY = 2;
export const FAILED_DAYS_FOR_HEALTH_ALERT = 2;

const COLUMNS = [
  'symbol',
  'name',
  'reportDate',
  'fiscalDateEnding',
  'estimate',
  'currency',
  'timeOfTheDay',
];

export interface EarningsRow {
  symbol: string;
  name: string;
  reportDate: string;
  fiscalDateEnding: string;
  estimate: string | null;
  timeOfTheDay: string;
}

export class AlphaVantageError extends Error {
  override name = 'AlphaVantageError';
}

/**
 * Parses the CSV. Alpha Vantage answers errors and rate limits with HTTP 200 and a JSON body
 * ({"Information": ...} / {"Note": ...} / {"Error Message": ...}); that is a failure, never an
 * empty calendar.
 */
export function parseEarningsCsv(text: string): EarningsRow[] {
  const body = text.trim();
  if (body.startsWith('{')) {
    let message = body.slice(0, 200);
    try {
      const j = JSON.parse(body) as Record<string, string>;
      message = j.Information ?? j.Note ?? j['Error Message'] ?? message;
    } catch {
      // keep the raw prefix
    }
    throw new AlphaVantageError(`Alpha Vantage returned a message instead of CSV: ${message}`);
  }
  const header = body.split('\n')[0]?.trim().split(',') ?? [];
  const missing = COLUMNS.filter((c) => !header.includes(c));
  if (missing.length)
    throw new AlphaVantageError(`unexpected CSV header (missing ${missing.join(', ')})`);
  const records = parse(body, { columns: true, skip_empty_lines: true, trim: true }) as Record<
    string,
    string
  >[];
  return records
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.reportDate ?? ''))
    .map((r) => ({
      symbol: (r.symbol ?? '').toUpperCase(),
      name: r.name ?? '',
      reportDate: r.reportDate!,
      fiscalDateEnding: r.fiscalDateEnding ?? '',
      estimate: r.estimate && /^-?\d+(\.\d+)?$/.test(r.estimate) ? r.estimate : null,
      timeOfTheDay: r.timeOfTheDay ?? '',
    }));
}

/** Rows for followed tickers → events. One event per ticker and fiscal period. */
export function toEarningsEvents(
  rows: readonly EarningsRow[],
  tickers: ReadonlySet<string>,
): EventInput[] {
  return rows
    .filter((r) => tickers.has(r.symbol))
    .map((r) => ({
      ticker: r.symbol,
      eventType: 'earnings' as const,
      date: r.reportDate,
      timeOfDay:
        r.timeOfTheDay === 'pre-market'
          ? ('before_open' as const)
          : r.timeOfTheDay === 'post-market'
            ? ('after_close' as const)
            : ('unknown' as const),
      title: r.fiscalDateEnding
        ? `Earnings (fiscal period ending ${r.fiscalDateEnding})`
        : 'Earnings',
      fiscalPeriod: r.fiscalDateEnding || null,
      epsEstimate: r.estimate,
      confirmed: true,
      estimated: false,
      source: 'alphavantage' as const,
      sourceRef: `${r.symbol}:${r.fiscalDateEnding || r.reportDate}`,
      sourceUrl: 'https://www.alphavantage.co/documentation/#earnings-calendar',
    }));
}

export interface RunDay {
  /** Pacific date of the attempt. */
  day: string;
  success: boolean;
}

/** Whether a call is allowed now (pure): not if today already succeeded or used 2 attempts. */
export function callBudget(runs: readonly RunDay[], today: string) {
  const todays = runs.filter((r) => r.day === today);
  if (todays.some((r) => r.success)) return { allowed: false, reason: 'already fetched today' };
  if (todays.length >= MAX_CALLS_PER_DAY) {
    return { allowed: false, reason: `daily limit of ${MAX_CALLS_PER_DAY} calls used` };
  }
  return { allowed: true, reason: `attempt ${todays.length + 1} of ${MAX_CALLS_PER_DAY} today` };
}

/** Consecutive most-recent days (days with at least one attempt) without a success (pure). */
export function consecutiveFailedDays(runs: readonly RunDay[]): number {
  const days = new Map<string, boolean>();
  for (const r of runs) days.set(r.day, (days.get(r.day) ?? false) || r.success);
  let n = 0;
  for (const day of [...days.keys()].sort().reverse()) {
    if (days.get(day)) break;
    n++;
  }
  return n;
}

/** Stores a fetched calendar: upserts, cancels dates it dropped, applies precedence. */
export async function syncEarningsCalendar(
  db: Db,
  rows: readonly EarningsRow[],
  tickers: ReadonlySet<string>,
  now = new Date(),
) {
  const input = toEarningsEvents(rows, tickers);
  const res = await upsertEvents(db, input, now);
  const cancelled = await cancelMissing(
    db,
    'alphavantage',
    input.map((e) => e.sourceRef),
    nyDate(now),
  );
  const reconcile = await reconcileStoredEvents(db);
  return { ...res, events: input.length, cancelled, superseded: reconcile.newlySuperseded };
}

const csvText = z.string();

async function fetchCalendar(apiKey: string, fetchImpl?: typeof fetch): Promise<string> {
  return requestJson(
    `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&horizon=3month&apikey=${encodeURIComponent(apiKey)}`,
    { schema: csvText, responseType: 'text', retries: 0, timeoutMs: 30_000, fetchImpl },
  );
}

async function recentRuns(db: Db, now: Date): Promise<RunDay[]> {
  const rows = await db
    .select({ startedAt: jobRuns.startedAt, status: jobRuns.status })
    .from(jobRuns)
    .where(
      and(
        eq(jobRuns.job, EARNINGS_JOB),
        gte(jobRuns.startedAt, new Date(now.getTime() - 21 * 86_400_000)),
      ),
    )
    .orderBy(desc(jobRuns.startedAt));
  return rows
    .filter((r) => r.status === 'success' || r.status === 'error')
    .map((r) => ({ day: laDate(r.startedAt), success: r.status === 'success' }));
}

/**
 * Checks the budget, fetches, syncs, and keeps the calendar's feed status. Runs through the
 * caller's runJob('earnings_calendar', ...) so attempts are counted in job_runs.
 */
export async function earningsCalendarJob(
  db: Db,
  p: { apiKey: string | undefined; now?: Date; fetchImpl?: typeof fetch },
): Promise<JobResult> {
  const now = p.now ?? new Date();
  if (!p.apiKey) return { status: 'skipped', meta: { reason: 'ALPHAVANTAGE_API_KEY not set' } };
  const budget = callBudget(await recentRuns(db, now), laDate(now));
  if (!budget.allowed) return { status: 'skipped', meta: { reason: budget.reason } };

  // Holdings and watchlist, plus the pullback screen universe (alerts show the next earnings).
  const tickers = new Set((await loadUniverse(db)).newsSymbols);
  try {
    for (const m of await loadScreenUniverse(db, loadPullbackConfig())) tickers.add(m.symbol);
  } catch (error) {
    log.warn('pullback universe unavailable for the earnings filter', { error: String(error) });
  }
  const rows = parseEarningsCsv(await fetchCalendar(p.apiKey, p.fetchImpl));
  const res = await syncEarningsCalendar(db, rows, tickers, now);
  return {
    items: res.events,
    meta: {
      attempt: budget.reason,
      marketRows: rows.length,
      followed: res.events,
      inserted: res.inserted,
      updated: res.updated,
      dateChanges: res.dateChanges,
      cancelled: res.cancelled,
      estimatesReplaced: res.superseded,
    },
  };
}

/**
 * After each attempt: updates the calendar's feed status and sends a HEALTH email when it has
 * failed FAILED_DAYS_FOR_HEALTH_ALERT days in a row, and again when it recovers.
 */
export async function updateCalendarHealth(db: Db, now = new Date()) {
  const runs = await recentRuns(db, now);
  const failedDays = consecutiveFailedDays(runs);
  const lastSuccess = runs.find((r) => r.success)?.day ?? null;
  const [prev] = await db.select().from(feedStatus).where(eq(feedStatus.feed, EARNINGS_FEED));
  const wasDown = prev?.status === 'down';
  const status =
    failedDays >= FAILED_DAYS_FOR_HEALTH_ALERT ? 'down' : failedDays === 1 ? 'degraded' : 'ok';
  const detail =
    status === 'ok'
      ? `fetched ${lastSuccess ?? 'never'}`
      : `failed ${failedDays} day${failedDays === 1 ? '' : 's'} in a row (last success ${lastSuccess ?? 'never'})`;
  await recordFeedStatus(
    db,
    {
      feed: EARNINGS_FEED,
      status,
      detail,
      okNow: status === 'ok',
      meta: { failedDays, lastSuccess },
    },
    now,
  );

  const send = async (kind: 'failure' | 'recovery', lead: string) => {
    const msg = await composeHealthAlert(
      {
        feed: EARNINGS_FEED,
        kind,
        from: kind === 'failure' ? (prev?.status ?? 'ok') : 'down',
        to: kind === 'failure' ? 'down' : 'ok',
        detail,
      },
      now,
      { lead, since: kind === 'recovery' ? (prev?.since ?? null) : null },
    );
    await enqueueAlert(db, {
      dedupeKey: `health:${EARNINGS_FEED}:${kind}:${laDate(now)}`,
      kind: 'health',
      severity: kind === 'failure' ? 'warn' : 'info',
      channel: 'email',
      subject: msg.subject,
      body: msg.text,
      html: msg.html,
    });
    log.warn(msg.subject);
  };
  if (status === 'down' && !wasDown) {
    await send(
      'failure',
      `The earnings calendar has failed ${failedDays} days in a row (last success ${lastSuccess ?? 'never'}). The morning email shows "calendar unavailable" and earnings dates may be stale until it recovers.`,
    );
  } else if (status === 'ok' && wasDown) {
    await send(
      'recovery',
      `The earnings calendar is fetching again (last success ${lastSuccess}).`,
    );
  }
  return { status, failedDays, lastSuccess };
}
