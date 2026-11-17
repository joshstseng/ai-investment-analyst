/**
 * Cron schedule (America/Los_Angeles). Every job is protected against overlapping itself, and
 * errors are contained (runJob records them in job_runs; the worker keeps running).
 *
 *   job            pattern              gate
 *   calendar_sync  0 3 * * *            —
 *   sec_cik_sync   30 4 * * *           SEC_USER_AGENT set
 *   quotes         *\/5 6-13 * * 1-5     market open per calendar (6:30–1:00 PT, early closes)
 *   edgar_poll     *\/10 5-20 * * 1-5    5:00–20:50 PT on weekdays
 *   close_check    *\/5 * * * *          due: close + 20 min (early close + 60 min), once per session
 *   bars_refresh   0 14 * * 1-5         trading day per calendar
 *   feed_health    5 * * * *            hourly (also refreshes the news stream's symbols)
 *   digest         *\/5 14-20 * * 1-5    due: trading day, at/after 2:15 PM PT, once per session
 *   events_refresh 0 5 * * 1-5         5:00 AM: rule/derived events, dividends/splits, econ calendar
 *   earnings       0,30 5 * * 1-5      5:00 AM (5:30 only if 5:00 failed; ≤ 2 Alpha Vantage calls/day)
 *   morning        *\/5 5-11 * * 1-5     due: weekdays from 5:45 AM PT, once per day (holiday version too)
 *   outbox_retry   *\/10 * * * *         resend failed alerts (max 5 attempts within 24 h)
 */
import { Cron } from 'croner';
import type { Context } from '../context';
import { log } from '../lib/log';
import type { NewsStreamManager } from '../news/run-stream';
import {
  barsRefreshJob,
  calendarJob,
  ciksJob,
  closeCheckJob,
  digestJob,
  earningsJob,
  fundamentalsJob,
  pullbackJob,
  eventsRefreshJob,
  morningJob,
  outboxJob,
  edgarJob,
  feedHealthJob,
  quotesJob,
} from './jobs';

export const TIMEZONE = 'America/Los_Angeles';

export interface ScheduledJob {
  name: string;
  pattern: string;
  run: () => Promise<unknown>;
}

export function scheduleDefinitions(
  ctx: Context,
  stream: NewsStreamManager | null,
): ScheduledJob[] {
  return [
    { name: 'calendar_sync', pattern: '0 3 * * *', run: () => calendarJob(ctx) },
    { name: 'sec_cik_sync', pattern: '30 4 * * *', run: () => ciksJob(ctx) },
    { name: 'quotes', pattern: '*/5 6-13 * * 1-5', run: () => quotesJob(ctx) },
    { name: 'edgar_poll', pattern: '*/10 5-20 * * 1-5', run: () => edgarJob(ctx) },
    { name: 'close_check', pattern: '*/5 * * * *', run: () => closeCheckJob(ctx) },
    { name: 'bars_refresh', pattern: '0 14 * * 1-5', run: () => barsRefreshJob(ctx) },
    { name: 'digest', pattern: '*/5 14-20 * * 1-5', run: () => digestJob(ctx) },
    { name: 'events_refresh', pattern: '0 5 * * 1-5', run: () => eventsRefreshJob(ctx) },
    { name: 'earnings', pattern: '0,30 5 * * 1-5', run: () => earningsJob(ctx) },
    // Pullback screen checks: Open 09:40 ET, Midday 12:30 ET, EOD after the close check.
    { name: 'pullbacks', pattern: '*/5 6-14 * * 1-5', run: () => pullbackJob(ctx) },
    // Pullback screen fundamentals (SEC company facts), Saturdays 6:00 AM PT.
    { name: 'fundamentals', pattern: '0 6 * * 6', run: () => fundamentalsJob(ctx) },
    { name: 'morning', pattern: '*/5 5-11 * * 1-5', run: () => morningJob(ctx) },
    { name: 'outbox_retry', pattern: '*/10 * * * *', run: () => outboxJob(ctx) },
    {
      name: 'feed_health',
      pattern: '5 * * * *',
      run: async () => {
        await stream?.refreshSymbols();
        await feedHealthJob(ctx);
      },
    },
  ];
}

export function startScheduler(jobs: ScheduledJob[]) {
  const crons = jobs.map(
    (j) =>
      new Cron(j.pattern, { name: j.name, timezone: TIMEZONE, protect: true }, async () => {
        try {
          await j.run();
        } catch (error) {
          // runJob has already recorded the failure in job_runs.
          log.warn(`scheduled job ${j.name} failed; will retry on its next run`, {
            error: String(error),
          });
        }
      }),
  );
  for (const c of crons) {
    const next = c.nextRun();
    log.info('scheduled', {
      job: c.name,
      next: next?.toISOString(),
      nextPT: next?.toLocaleString('en-US', {
        timeZone: TIMEZONE,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }),
    });
  }
  return { stop: () => crons.forEach((c) => c.stop()), crons };
}
