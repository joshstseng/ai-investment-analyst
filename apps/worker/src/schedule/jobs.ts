/** The work each scheduled job does. Gates (market hours, due checks) live here too. */
import { laDate, nyDate } from '@aia/core';
import { alerts, jobRuns, marketCalendar } from '@aia/db';
import { and, eq, sql } from 'drizzle-orm';
import type { Context } from '../context';
import { runJob } from '../lib/jobs';
import { collectDailyBars } from '../market/bars';
import { syncCalendar } from '../market/calendar';
import { collectQuotes } from '../market/quotes';
import { loadUniverse } from '../market/universe';
import { checkRules } from '../rules/check';
import { syncCiks } from '../sec/ciks';
import { collectFilings } from '../sec/filings';
import { runFeedHealth } from '../health/run';
import { EARNINGS_JOB, earningsCalendarJob, updateCalendarHealth } from '../events/alphavantage';
import { syncCorporateActions } from '../events/corporate-actions';
import { syncDerivedEvents } from '../events/derived';
import { gatherMorning } from '../morning/gather';
import { renderMorning } from '../morning/render';
import { morningDueDate } from '../morning/window';
import { ECON_JOB, econCalendarJob } from '../events/econ-calendar';
import { digestDue, gatherDigest } from '../notify/digest';
import { composeDigest } from '../notify/digest-email';
import { enqueueAlert, sendPending } from '../notify/outbox';
import { processRuleAlerts } from '../notify/rule-alerts';
import { log } from '../lib/log';
import { dueCloseCheck, isMarketOpen, loadNearbySessions, sessionOn } from './market';

export async function calendarJob(ctx: Context) {
  await runJob(ctx.db, 'calendar_sync', () => syncCalendar(ctx.db, ctx.alpaca));
}

export async function ciksJob(ctx: Context) {
  if (!ctx.sec) return;
  const universe = await loadUniverse(ctx.db);
  await runJob(ctx.db, 'sec_cik_sync', () => syncCiks(ctx.db, ctx.sec!, universe.newsSymbols));
}

/** Quotes only while the market is open (calendar-based, so holidays and early closes count). */
export async function quotesJob(ctx: Context, now = new Date()) {
  const sessions = await loadNearbySessions(ctx.db, now);
  if (!isMarketOpen(sessions, now)) return 'skipped: market closed';
  const universe = await loadUniverse(ctx.db);
  await runJob(ctx.db, 'quotes', () =>
    collectQuotes(ctx.db, ctx.alpaca, { universe, force: true, now }),
  );
  return 'ran';
}

export async function edgarJob(ctx: Context) {
  if (!ctx.sec) return;
  const universe = await loadUniverse(ctx.db);
  await runJob(ctx.db, 'edgar_poll', () =>
    collectFilings(ctx.db, ctx.sec!, { symbols: universe.newsSymbols, days: 1, via: 'poll' }),
  );
}

export async function lastCheckedSession(ctx: Context): Promise<string | null> {
  const [row] = await ctx.db
    .select({ date: sql<string | null>`max(${jobRuns.meta}->>'asOfDate')` })
    .from(jobRuns)
    .where(and(eq(jobRuns.job, 'close_check'), eq(jobRuns.status, 'success')));
  return row?.date ?? null;
}

/**
 * Runs the close check for the newest session whose check time has passed, once per session:
 * refresh recent bars first (the 2 PM refresh is later), then evaluate rules.
 */
export async function closeCheckJob(ctx: Context, now = new Date()) {
  const sessions = await loadNearbySessions(ctx.db, now);
  const due = dueCloseCheck(sessions, now, await lastCheckedSession(ctx));
  if (!due) return 'not due';
  const universe = await loadUniverse(ctx.db);
  await runJob(ctx.db, 'close_check', async () => {
    const bars = await collectDailyBars(ctx.db, ctx.alpaca, {
      universe,
      days: 10,
      feed: ctx.env.ALPACA_BARS_FEED,
      now,
    });
    const res = await checkRules(ctx.db, { asOfDate: due });
    const alerted = await processRuleAlerts(ctx.db, res.results, due, now);
    return {
      items: res.items,
      meta: {
        ...res.meta,
        barsWritten: bars.items,
        alertsQueued: alerted.queued.length,
        decisions: alerted.decisions,
      },
    };
  });
  kickOutbox(ctx);
  return `checked ${due}`;
}

/** 2 PM PT refresh on trading days, to pick up late bar corrections. */
export async function barsRefreshJob(ctx: Context, now = new Date()) {
  const sessions = await loadNearbySessions(ctx.db, now);
  if (!sessionOn(sessions, nyDate(now))) return 'skipped: not a trading day';
  const universe = await loadUniverse(ctx.db);
  await runJob(ctx.db, 'bars_refresh', () =>
    collectDailyBars(ctx.db, ctx.alpaca, {
      universe,
      days: 10,
      feed: ctx.env.ALPACA_BARS_FEED,
      now,
    }),
  );
  return 'ran';
}

export async function feedHealthJob(ctx: Context) {
  await runJob(ctx.db, 'feed_health', () => runFeedHealth(ctx, { alert: true }));
  kickOutbox(ctx);
}

/** Sends queued alerts; failures stay queued and are retried (max 5 attempts, 24 h). */
export async function outboxJob(ctx: Context) {
  const res = await sendPending(ctx.db, ctx.mailer);
  if (res.pending) log.info('outbox', res);
  return res;
}

/**
 * Starts a send pass without waiting for it. Jobs that queue alerts call this so a slow or
 * unreachable mail server never delays price checks, the schedule, or other jobs.
 */
let inflight: Promise<unknown> = Promise.resolve();

export function kickOutbox(ctx: Context) {
  inflight = outboxJob(ctx).catch((error: unknown) =>
    log.warn('outbox pass failed', { error: String(error) }),
  );
}

/** Waits for a background send pass to finish (CLI commands call this before exiting). */
export function drainOutbox(): Promise<unknown> {
  return inflight;
}

export async function lastDigestDate(ctx: Context): Promise<string | null> {
  const [row] = await ctx.db
    .select({ date: sql<string | null>`max(${alerts.asOfDate})` })
    .from(alerts)
    .where(eq(alerts.kind, 'digest'));
  return row?.date ?? null;
}

/** Daily digest once per trading day at/after 2:15 PM PT (due-based, so restarts can't skip it). */
export async function digestJob(ctx: Context, now = new Date()) {
  const sessions = (await ctx.db.select({ date: marketCalendar.date }).from(marketCalendar)).map(
    (s) => s.date,
  );
  const due = digestDue(sessions, now, await lastDigestDate(ctx));
  if (!due) return 'not due';
  await runJob(ctx.db, 'digest', async () => {
    const msg = await composeDigest(await gatherDigest(ctx.db, due, now), {
      barsFeed: ctx.env.ALPACA_BARS_FEED,
    });
    const id = await enqueueAlert(ctx.db, {
      dedupeKey: `digest:${due}`,
      kind: 'digest',
      severity: 'info',
      channel: 'digest',
      subject: msg.subject,
      body: msg.text,
      html: msg.html,
      asOfDate: due,
    });
    return { items: id ? 1 : 0, meta: { date: due, subject: msg.subject } };
  });
  kickOutbox(ctx);
  return `digest ${due}`;
}

/**
 * Earnings calendar (Alpha Vantage), at most 2 calls per Pacific day (enforced inside). The
 * calendar's health is updated after every attempt, success or failure.
 */
export async function earningsJob(ctx: Context, now = new Date()) {
  try {
    const res = await runJob(ctx.db, EARNINGS_JOB, () =>
      earningsCalendarJob(ctx.db, { apiKey: ctx.env.ALPHAVANTAGE_API_KEY, now }),
    );
    return res;
  } finally {
    if (ctx.env.ALPHAVANTAGE_API_KEY) {
      await updateCalendarHealth(ctx.db, now);
      kickOutbox(ctx);
    }
  }
}

/**
 * Daily events refresh (5:00 AM PT): rule/derived events, Alpaca dividends and splits, and the
 * ForexFactory economic calendar. Each part runs independently: one failing doesn't block the
 * others (failures are recorded in job_runs).
 */
export async function eventsRefreshJob(ctx: Context, opts: { forceEcon?: boolean } = {}) {
  const parts: [string, () => Promise<unknown>][] = [
    ['events_sync', () => runJob(ctx.db, 'events_sync', () => syncDerivedEvents(ctx.db))],
    [
      'corporate_actions',
      () => runJob(ctx.db, 'corporate_actions', () => syncCorporateActions(ctx.db, ctx.alpaca)),
    ],
    [
      ECON_JOB,
      () => runJob(ctx.db, ECON_JOB, () => econCalendarJob(ctx.db, { force: opts.forceEcon })),
    ],
  ];
  const failed: string[] = [];
  for (const [name, run] of parts) {
    try {
      await run();
    } catch {
      failed.push(name);
    }
  }
  return failed;
}

export async function lastMorningDate(ctx: Context): Promise<string | null> {
  const [row] = await ctx.db
    .select({ date: sql<string | null>`max(${alerts.asOfDate})` })
    .from(alerts)
    .where(eq(alerts.kind, 'morning'));
  return row?.date ?? null;
}

/**
 * Weekday morning email (from 5:45 AM PT, once per day, catches up after a restart). On a
 * market holiday it sends the short "market closed" version.
 */
export async function morningJob(ctx: Context, now = new Date()) {
  const due = morningDueDate(now, await lastMorningDate(ctx), laDate(now));
  if (!due) return 'not due';
  await runJob(ctx.db, 'morning_email', async () => {
    const msg = await renderMorning(await gatherMorning(ctx.db, ctx.alpaca, now));
    const id = await enqueueAlert(ctx.db, {
      dedupeKey: `morning:${due}`,
      kind: 'morning',
      severity: 'info',
      channel: 'email',
      subject: msg.subject,
      body: msg.text,
      html: msg.html,
      asOfDate: due,
    });
    return { items: id ? 1 : 0, meta: { date: due, subject: msg.subject } };
  });
  kickOutbox(ctx);
  return `morning ${due}`;
}
