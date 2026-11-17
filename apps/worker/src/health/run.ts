import { inEdgarWindow, nyDate } from '@aia/core';
import { feedStatus, jobRuns, pricesDaily, quotesLatest, symbolDataStatus } from '@aia/db';
import { composeHealthAlert, feedTransitions } from '../notify/health-alerts';
import { enqueueAlert } from '../notify/outbox';
import type { FeedState } from './assess';
import { and, eq, gte, inArray, max } from 'drizzle-orm';
import type { Context } from '../context';
import type { JobResult } from '../lib/jobs';
import { loadUniverse } from '../market/universe';
import { NEWS_STREAM_CONNECTION_FEED } from '../news/run-stream';
import { closeCheckAt, isMarketOpen, loadNearbySessions } from '../schedule/market';
import { assessFeeds, type HealthSnapshot } from './assess';
import { recordFeedStatus } from './feed-status';

const MIN = 60_000;
/** Bars are expected this long after a session's close-check time. */
const BARS_GRACE_MS = 15 * MIN;

const laWeekday = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  weekday: 'short',
});
const isLaWeekday = (d: Date) => !['Sat', 'Sun'].includes(laWeekday.format(d));

export async function gatherHealth(ctx: Context, now = new Date()): Promise<HealthSnapshot> {
  const { db, env, sec } = ctx;
  const sessions = await loadNearbySessions(db, now);
  const open = sessions.find((s) => s.openAt <= now && now < s.closeAt) ?? null;
  const expected =
    sessions.filter((s) => closeCheckAt(s).getTime() + BARS_GRACE_MS <= now.getTime()).at(-1) ??
    null;

  const [conn] = await db
    .select()
    .from(feedStatus)
    .where(eq(feedStatus.feed, NEWS_STREAM_CONNECTION_FEED));
  const [q] = await db.select({ at: max(quotesLatest.receivedAt) }).from(quotesLatest);

  const universe = await loadUniverse(db);
  const noData = new Set(
    (
      await db
        .select({ symbol: symbolDataStatus.symbol })
        .from(symbolDataStatus)
        .where(
          and(
            eq(symbolDataStatus.dataset, 'daily_bars'),
            eq(symbolDataStatus.status, 'no_data_source'),
          ),
        )
    ).map((r) => r.symbol),
  );
  const tracked = universe.priceSymbols.filter((s) => !noData.has(s));
  let missing: string[] = [];
  if (expected && tracked.length) {
    const have = new Set(
      (
        await db
          .select({ symbol: pricesDaily.symbol })
          .from(pricesDaily)
          .where(and(eq(pricesDaily.date, expected.date), inArray(pricesDaily.symbol, tracked)))
      ).map((r) => r.symbol),
    );
    missing = tracked.filter((s) => !have.has(s));
  }

  const [edgar] = await db
    .select({ at: max(jobRuns.finishedAt) })
    .from(jobRuns)
    .where(
      and(inArray(jobRuns.job, ['edgar_poll', 'edgar_backfill']), eq(jobRuns.status, 'success')),
    );
  const erroring = (
    await db
      .select({ symbol: symbolDataStatus.symbol })
      .from(symbolDataStatus)
      .where(and(eq(symbolDataStatus.dataset, 'filings'), eq(symbolDataStatus.status, 'error')))
  ).map((r) => r.symbol);
  const halfHourAgo = new Date(now.getTime() - 30 * MIN);

  const errors = await db
    .select({ job: jobRuns.job, at: jobRuns.startedAt, error: jobRuns.error })
    .from(jobRuns)
    .where(
      and(eq(jobRuns.status, 'error'), gte(jobRuns.startedAt, new Date(now.getTime() - 60 * MIN))),
    );

  return {
    now,
    marketOpen: isMarketOpen(sessions, now),
    openedAt: open?.openAt ?? null,
    news: {
      enabled: env.NEWS_STREAM_ENABLED,
      status: conn
        ? { status: conn.status, since: conn.since, lastOkAt: conn.lastOkAt, detail: conn.detail }
        : null,
    },
    quotes: { latestReceivedAt: q?.at ?? null },
    bars: { expectedDate: expected?.date ?? null, missing, tracked: tracked.length },
    edgar: {
      enabled: !!sec,
      // In the window, on a weekday, and for at least 30 min (so the first poll has had time).
      inWindow: isLaWeekday(now) && inEdgarWindow(now) && inEdgarWindow(halfHourAgo),
      lastSuccessAt: edgar?.at ?? null,
      erroring,
    },
    jobErrors: errors.map((e) => ({ job: e.job, at: e.at, error: e.error ?? '' })),
  };
}

/**
 * Assesses every feed and stores the result. With `alert`, queues a HEALTH email for each feed
 * that just failed or recovered (manual runs pass alert=false so they can't send false alarms).
 */
export async function runFeedHealth(
  ctx: Context,
  opts: { alert: boolean; now?: Date },
): Promise<JobResult> {
  const now = opts.now ?? new Date();
  const snapshot = await gatherHealth(ctx, now);
  const results = assessFeeds(snapshot);
  const prevRows = await ctx.db
    .select({ feed: feedStatus.feed, status: feedStatus.status, since: feedStatus.since })
    .from(feedStatus);
  const previous = new Map<string, FeedState>(prevRows.map((r) => [r.feed, r.status]));
  const sinceBy = new Map(prevRows.map((r) => [r.feed, r.since]));
  const transitions = feedTransitions(previous, results);
  for (const r of results) await recordFeedStatus(ctx.db, r, now);
  if (opts.alert) {
    for (const t of transitions) {
      const msg = await composeHealthAlert(t, now, {
        // A recovery's outage started when the feed last changed state.
        since: t.kind === 'recovery' ? (sinceBy.get(t.feed) ?? null) : now,
        others: results.map((r) => ({ feed: r.feed, status: r.status })),
      });
      await enqueueAlert(ctx.db, {
        dedupeKey: `health:${t.feed}:${t.kind}:${now.toISOString().slice(0, 16)}`,
        kind: 'health',
        severity: t.kind === 'failure' ? 'warn' : 'info',
        channel: 'email',
        subject: msg.subject,
        body: msg.text,
        html: msg.html,
      });
    }
  }
  const issues = results.filter((r) => r.status === 'degraded' || r.status === 'down');
  return {
    items: results.length,
    meta: {
      date: nyDate(now),
      issues: issues.map((i) => `${i.feed}: ${i.status} (${i.detail})`),
      transitions: transitions.map((t) => `${t.feed}: ${t.from} → ${t.to}`),
      alerted: opts.alert,
      feeds: Object.fromEntries(results.map((r) => [r.feed, r.status])),
    },
  };
}
