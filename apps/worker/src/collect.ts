/**
 * Run a collector once by hand:
 *   pnpm collect calendar
 *   pnpm collect bars [--days 365]
 *   pnpm collect quotes [--force]        (skips when the market is closed unless --force)
 *   pnpm collect news [--days 7]
 *   pnpm collect stream [--minutes 5]    (run the news websocket for a while)
 *   pnpm collect ciks                    (refresh ticker → SEC CIK map)
 *   pnpm collect filings [--days 30]     (EDGAR; --days > 1 is recorded as a backfill)
 *   pnpm collect check [--date YYYY-MM-DD]  (evaluate rules for the latest completed session)
 *   pnpm collect due                     (run the close check if one is due)
 *   pnpm collect health [--alert]        (feed health pass; --alert emails failures/recoveries)
 *   pnpm collect digest [--date D] [--send] (preview the digest; --send runs the real job if due)
 *   pnpm collect alerts                  (last 20 alerts and their send status)
 *   pnpm collect test-email              (send one test message)
 *   pnpm collect schedule                (show the cron schedule and next runs, PT)
 *   pnpm collect status                  (coverage + feed latency report)
 */
import { parseArgs } from 'node:util';
import { filings, newsItems, pricesDaily, symbolDataStatus } from '@aia/db';
import { count, desc, eq, max, sql } from 'drizzle-orm';
import { createContext } from './context';
import { runJob } from './lib/jobs';
import { collectDailyBars } from './market/bars';
import { syncCalendar } from './market/calendar';
import { collectQuotes } from './market/quotes';
import { loadUniverse } from './market/universe';
import { collectNews } from './news/backfill';
import { NewsStreamManager } from './news/run-stream';
import { runFeedHealth } from './health/run';
import { gatherDigest, renderDigest } from './notify/digest';
import { alerts } from '@aia/db';
import { digestJob, drainOutbox, outboxJob } from './schedule/jobs';
import { latestCompletedSession } from './rules/check';
import { closeCheckJob } from './schedule/jobs';
import { scheduleDefinitions, TIMEZONE } from './schedule/scheduler';
import { Cron } from 'croner';
import { syncCiks } from './sec/ciks';
import { collectFilings } from './sec/filings';
import { checkRules, type CheckResult } from './rules/check';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    days: { type: 'string' },
    date: { type: 'string' },
    minutes: { type: 'string', default: '5' },
    force: { type: 'boolean', default: false },
    send: { type: 'boolean', default: false },
    alert: { type: 'boolean', default: false },
  },
});
const command = positionals[0];
const ctx = createContext();
const { db, alpaca, env } = ctx;

try {
  switch (command) {
    case 'calendar':
      await runJob(db, 'calendar_sync', () => syncCalendar(db, alpaca));
      break;
    case 'bars': {
      const universe = await loadUniverse(db);
      await runJob(db, 'bars_backfill', () =>
        collectDailyBars(db, alpaca, {
          universe,
          days: Number(values.days ?? 365),
          feed: env.ALPACA_BARS_FEED,
        }),
      );
      break;
    }
    case 'quotes': {
      const universe = await loadUniverse(db);
      await runJob(db, 'quotes', () =>
        collectQuotes(db, alpaca, { universe, force: values.force }),
      );
      break;
    }
    case 'news': {
      const universe = await loadUniverse(db);
      await runJob(db, 'news_backfill', () =>
        collectNews(db, alpaca, { symbols: universe.newsSymbols, days: Number(values.days ?? 7) }),
      );
      break;
    }
    case 'stream': {
      const stream = new NewsStreamManager(ctx);
      await stream.start();
      await new Promise((r) => setTimeout(r, Number(values.minutes) * 60_000));
      stream.stop();
      break;
    }
    case 'ciks': {
      const universe = await loadUniverse(db);
      await runJob(db, 'sec_cik_sync', () => syncCiks(db, ctx.requireSec(), universe.newsSymbols));
      break;
    }
    case 'filings': {
      const universe = await loadUniverse(db);
      const days = Number(values.days ?? 1);
      await runJob(db, days > 1 ? 'edgar_backfill' : 'edgar_poll', () =>
        collectFilings(db, ctx.requireSec(), {
          symbols: universe.newsSymbols,
          days,
          via: days > 1 ? 'backfill' : 'poll',
        }),
      );
      break;
    }
    case 'check': {
      const res = await runJob(db, 'rule_check', () => checkRules(db, { asOfDate: values.date }));
      printCheck(res.results);
      break;
    }
    case 'health': {
      const res = await runJob(db, 'feed_health', () =>
        runFeedHealth(ctx, { alert: values.alert }),
      );
      if (values.alert) await outboxJob(ctx);
      console.log(JSON.stringify(res.meta, null, 2));
      break;
    }
    case 'test-email': {
      if (!ctx.mailer) {
        throw new Error(
          'email not configured: set RESEND_API_KEY (or GMAIL_USER + GMAIL_APP_PASSWORD) and ALERT_EMAIL_TO',
        );
      }
      const res = await ctx.mailer.send({
        subject: '[AIA] HEALTH Test email',
        text: `This is a test from the AI Investment Analyst worker.\n\nProvider: ${ctx.mailer.provider}\nFrom: ${ctx.mailer.from}\nTo: ${ctx.mailer.to.join(', ')}\nSent: ${new Date().toISOString()}`,
      });
      console.log(
        `sent test email via ${ctx.mailer.provider} to ${ctx.mailer.to.join(', ')} (message id ${res.messageId})`,
      );
      break;
    }
    case 'digest': {
      if (values.send) {
        console.log(`digest: ${await digestJob(ctx)}`);
        break;
      }
      // Preview only: print the plain-text digest for a session (default: latest completed).
      const date = values.date ?? (await latestCompletedSession(db));
      if (!date) throw new Error('no completed session');
      const msg = renderDigest(await gatherDigest(db, date));
      console.log(`Subject: ${msg.subject}\n\n${msg.text}`);
      break;
    }
    case 'alerts': {
      const rows = await db.select().from(alerts).orderBy(desc(alerts.id)).limit(20);
      for (const a of rows) {
        console.log(
          `  #${a.id} ${a.createdAt.toISOString().slice(0, 16)} ${a.sentAt ? 'sent' : `UNSENT (${a.attempts} tries${a.error ? `: ${a.error}` : ''})`}  ${a.subject}`,
        );
      }
      break;
    }
    case 'due':
      console.log(`close check: ${await closeCheckJob(ctx)}`);
      break;
    case 'schedule':
      for (const j of scheduleDefinitions(ctx, null)) {
        const next = new Cron(j.pattern, { timezone: TIMEZONE, paused: true }).nextRuns(3);
        console.log(
          `  ${j.name.padEnd(14)} ${j.pattern.padEnd(18)} next: ${next.map((d) => d.toLocaleString('en-US', { timeZone: TIMEZONE, weekday: 'short', hour: 'numeric', minute: '2-digit' })).join(' | ')}`,
        );
      }
      break;
    case 'status':
      await printStatus();
      break;
    default:
      console.error(
        'usage: pnpm collect <calendar|bars|quotes|news|stream|ciks|filings|check|due|health|digest|alerts|test-email|schedule|status> [options]',
      );
      process.exitCode = 2;
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
} finally {
  await drainOutbox();
  await ctx.close();
}

async function printStatus() {
  const coverage = await db
    .select()
    .from(symbolDataStatus)
    .orderBy(symbolDataStatus.dataset, symbolDataStatus.symbol);
  console.log('Data coverage');
  for (const c of coverage) {
    console.log(
      `  ${c.dataset.padEnd(14)} ${c.symbol.padEnd(20)} ${c.status.padEnd(15)} ${
        c.lastDataAt?.toISOString().slice(0, 16) ?? ''
      } ${c.note ?? ''}`,
    );
  }
  const [bars] = await db
    .select({
      rows: count(),
      symbols: sql<number>`count(distinct ${pricesDaily.symbol})`,
      last: max(pricesDaily.date),
    })
    .from(pricesDaily);
  console.log(`\nDaily bars: ${bars!.rows} rows, ${bars!.symbols} symbols, latest ${bars!.last}`);

  const [news] = await db.select({ rows: count() }).from(newsItems);
  const latency = await db
    .select({
      p50: sql<number>`percentile_cont(0.5) within group (order by extract(epoch from ${newsItems.receivedAt} - ${newsItems.publishedAt}))`,
      p90: sql<number>`percentile_cont(0.9) within group (order by extract(epoch from ${newsItems.receivedAt} - ${newsItems.publishedAt}))`,
      n: count(),
    })
    .from(newsItems)
    .where(eq(newsItems.via, 'stream'));
  console.log(`News: ${news!.rows} items`);
  const l = latency[0]!;
  console.log(
    l.n > 0
      ? `Stream latency (received - published): p50 ${Math.round(l.p50)}s, p90 ${Math.round(l.p90)}s over ${l.n} items`
      : 'Stream latency: no streamed items yet',
  );
  const recent = await db.select().from(newsItems).orderBy(desc(newsItems.publishedAt)).limit(5);
  for (const n of recent) {
    console.log(
      `  ${n.publishedAt.toISOString().slice(0, 16)} [${n.symbols.join(',')}] ${n.headline.slice(0, 80)}`,
    );
  }

  const recentFilings = await db.select().from(filings).orderBy(desc(filings.filedAt)).limit(8);
  const [fcount] = await db.select({ n: count() }).from(filings);
  console.log(`\nFilings: ${fcount!.n}`);
  for (const f of recentFilings) {
    console.log(
      `  ${f.filedAt.toISOString().slice(0, 16)} ${(f.ticker ?? '').padEnd(6)} ${f.form.padEnd(7)} ${f.items.join(',')}`,
    );
  }
}

function printCheck(results: CheckResult[]) {
  const order = { fired: 0, not_checked: 1, not_fired: 2 } as const;
  const sorted = [...results].sort(
    (a, b) => order[a.outcome.kind] - order[b.outcome.kind] || a.symbol.localeCompare(b.symbol),
  );
  for (const r of sorted) {
    const o = r.outcome;
    const tag =
      o.kind === 'fired'
        ? `FIRED ${o.severity}`
        : o.kind === 'not_checked'
          ? `not checked (${o.reason})`
          : 'ok';
    console.log(
      `  ${r.symbol.padEnd(20)} ${r.status.padEnd(11)} ${r.ruleType.padEnd(28)} ${tag.padEnd(30)} ${o.message}`,
    );
  }
}
