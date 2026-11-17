/**
 * Always-on worker.
 * Startup: database migrations (before anything else), calendar sync, 1-year bars backfill, SEC CIK sync + 30-day EDGAR backfill, news
 * stream (unless NEWS_STREAM_ENABLED=false), then any due close check and a feed-health pass.
 * After that, everything runs on the schedule in schedule/scheduler.ts.
 */
import { describeDatabaseUrl, runMigrations } from '@aia/db';
import { createContext } from './context';
import { runJob } from './lib/jobs';
import { log } from './lib/log';
import { collectDailyBars } from './market/bars';
import { loadUniverse } from './market/universe';
import { collectNews } from './news/backfill';
import { NewsStreamManager } from './news/run-stream';
import {
  calendarJob,
  ciksJob,
  closeCheckJob,
  earningsJob,
  fundamentalsJob,
  fundamentalsStale,
  eventsRefreshJob,
  feedHealthJob,
} from './schedule/jobs';
import { scheduleDefinitions, startScheduler } from './schedule/scheduler';
import { collectFilings } from './sec/filings';
import { startExportServer } from './server';

const ctx = createContext();
const { db, alpaca, env, sec } = ctx;

// Migrations first: if they fail the process exits non-zero and the platform restarts it,
// rather than running jobs against an out-of-date schema.
log.info('applying database migrations', { database: describeDatabaseUrl(env.DATABASE_URL) });
await runMigrations(env.DATABASE_URL);
log.info('database migrations applied');

async function safely(job: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch {
    // runJob already logged it and recorded it in job_runs; keep the worker alive.
    log.warn(`continuing after ${job} failure`);
  }
}

log.info('worker starting', {
  newsStream: env.NEWS_STREAM_ENABLED,
  edgar: sec ? 'enabled' : 'disabled (SEC_USER_AGENT not set)',
});
await safely('calendar_sync', () => calendarJob(ctx));
await safely('bars_backfill', async () => {
  const universe = await loadUniverse(db);
  await runJob(db, 'bars_backfill', () =>
    collectDailyBars(db, alpaca, { universe, days: 365, feed: env.ALPACA_BARS_FEED }),
  );
});
if (sec) {
  await safely('sec_cik_sync', () => ciksJob(ctx));
  await safely('edgar_backfill', async () => {
    const universe = await loadUniverse(db);
    await runJob(db, 'edgar_backfill', () =>
      collectFilings(db, sec, { symbols: universe.newsSymbols, days: 30, via: 'backfill' }),
    );
  });
}

let stream: NewsStreamManager | null = null;
if (env.NEWS_STREAM_ENABLED) {
  stream = new NewsStreamManager(ctx);
  await safely('news_stream', () => stream!.start());
  // Let the first health pass see the connection instead of reporting a false outage.
  if (!(await stream.waitUntilConnected(20_000))) {
    log.warn('news stream not connected after 20 s; continuing (it keeps retrying)');
  }
} else {
  log.info('news stream disabled (NEWS_STREAM_ENABLED=false); REST backfill only');
  await safely('news_backfill', async () => {
    const universe = await loadUniverse(db);
    await runJob(db, 'news_backfill', () =>
      collectNews(db, alpaca, { symbols: universe.newsSymbols, days: 7 }),
    );
  });
}

// Events (rules/derived, dividends/splits, econ calendar) and earnings, so a morning email sent
// by catch-up after a deploy isn't missing them. Both are budget/once-a-day guarded.
await safely('events_refresh', () => eventsRefreshJob(ctx));
await safely('earnings', () => earningsJob(ctx));
// Pullback fundamentals take a few minutes: catch up in the background, don't block startup.
if (await fundamentalsStale(ctx)) {
  void safely('fundamentals', () => fundamentalsJob(ctx));
}
await safely('close_check', async () => log.info(`close check: ${await closeCheckJob(ctx)}`));
await safely('feed_health', () => feedHealthJob(ctx));

const scheduler = startScheduler(scheduleDefinitions(ctx, stream));
// Read-only pullback export for external research agents (only with a token).
const exportServer = env.PULLBACK_EXPORT_TOKEN
  ? startExportServer({ db, token: env.PULLBACK_EXPORT_TOKEN, port: env.PORT })
  : null;

async function shutdown(signal: string) {
  log.info(`worker stopping (${signal})`);
  scheduler.stop();
  exportServer?.close();
  stream?.stop();
  await ctx.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
