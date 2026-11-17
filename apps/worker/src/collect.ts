/**
 * Run a collector once by hand:
 *   pnpm collect calendar
 *   pnpm collect bars [--days 365]
 *   pnpm collect quotes [--force]        (skips when the market is closed unless --force)
 *   pnpm collect news [--days 7]
 *   pnpm collect stream [--minutes 5]    (run the news websocket for a while)
 *   pnpm collect ciks                    (refresh ticker → SEC CIK map)
 *   pnpm collect filings [--days 30]     (EDGAR; --days > 1 is recorded as a backfill)
 *   pnpm collect earnings                (Alpha Vantage earnings calendar; ≤ 2 calls/day)
 *   pnpm collect events [--force]        (rules/derived, dividends/splits, econ calendar; list upcoming)
 *   pnpm collect morning [--dry-run|--send] [--html f] [--test-send] [--as-of ISO]  (morning email)
 *   pnpm collect levels [--as-of ISO]    (pre-market prices + levels to watch)
 *   pnpm collect check [--date YYYY-MM-DD]  (evaluate rules for the latest completed session)
 *   pnpm collect due                     (run the close check if one is due)
 *   pnpm collect health [--alert]        (feed health pass; --alert emails failures/recoveries)
 *   pnpm collect digest [--date D] [--dry-run] [--html out.html] [--json] [--test-send] [--send]
 *       (preview the digest: plain text, or HTML written to a file plus .preview/digest-props.json
 *        for `pnpm email:preview`; --test-send emails a one-off copy; --send runs the real job if due)
 *   pnpm collect alert --ticker T [--date D] [--html f] [--test-send]
 *       (preview the alert email for a rule that fired on that date)
 *   pnpm collect health-email [--feed F] [--recovery] [--html f] [--test-send]
 *       (preview a simulated HEALTH email; test sends say "(test)")
 *   pnpm collect universe-refresh        (rebuild config/universe/*.csv; commit the result)
 *   pnpm collect screen-bars [--years 5] (pullback universe: history backfill + refresh)
 *   pnpm collect screen-prices [--live] [--symbols A,B]  (pullback price metrics)
 *   pnpm collect fundamentals [--symbols A,B]  (SEC company facts → scorecards; weekly job)
 *   pnpm collect scorecard [--symbols A,B]     (print scorecards and the quality filter)
 *   pnpm collect pullback-check --check open|midday|eod [--date D]  (run one check now)
 *   pnpm collect pullbacks                     (tickers in a pullback episode)
 *   pnpm collect pullback-export [--format json|csv] [--out file] [--date D]  (shared output)
 *   pnpm collect pullback-preview --symbols A,B [--check midday] [--html f] [--test-send]
 *       (the alert email those symbols would get if they qualified now; stores nothing)
 *   pnpm collect alerts                  (last 20 alerts and their send status)
 *   pnpm collect test-email              (send one test message)
 *   pnpm collect schedule                (show the cron schedule and next runs, PT)
 *   pnpm collect status                  (coverage + feed latency report)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { events as eventsTable, filings, newsItems, pricesDaily, symbolDataStatus } from '@aia/db';
import { nyDate } from '@aia/core';
import { count, desc, eq, gte, max, sql } from 'drizzle-orm';
import { createContext } from './context';
import { runJob } from './lib/jobs';
import { collectDailyBars } from './market/bars';
import { syncCalendar } from './market/calendar';
import { collectQuotes } from './market/quotes';
import { loadUniverse } from './market/universe';
import { collectNews } from './news/backfill';
import { printLevels } from './morning/inspect';
import { gatherMorning } from './morning/gather';
import { renderMorning } from './morning/render';
import { enqueueAlert } from './notify/outbox';
import { NewsStreamManager } from './news/run-stream';
import { runFeedHealth } from './health/run';
import { gatherDigest } from './notify/digest';
import { buildPullbackExport, pullbackExportCsv } from './pullbacks/export';
import { composeDigest } from './notify/digest-email';
import { composeHealthAlert } from './notify/health-alerts';
import { previewRuleAlert } from './notify/rule-alerts';
import { alerts } from '@aia/db';
import {
  digestJob,
  drainOutbox,
  earningsJob,
  eventsRefreshJob,
  fundamentalsJob,
  outboxJob,
  pullbackPreview,
  runPullbackCheckJob,
} from './schedule/jobs';
import { latestCompletedSession } from './rules/check';
import { closeCheckJob } from './schedule/jobs';
import { scheduleDefinitions, TIMEZONE } from './schedule/scheduler';
import { Cron } from 'croner';
import { syncCiks } from './sec/ciks';
import { collectFilings } from './sec/filings';
import { checkRules, type CheckResult } from './rules/check';
import {
  pullbacksCommand,
  scorecardCommand,
  screenBarsCommand,
  screenPricesCommand,
  universeRefreshCommand,
} from './pullbacks/inspect';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    days: { type: 'string' },
    date: { type: 'string' },
    'as-of': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    minutes: { type: 'string', default: '5' },
    force: { type: 'boolean', default: false },
    send: { type: 'boolean', default: false },
    alert: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    html: { type: 'string' },
    'test-send': { type: 'boolean', default: false },
    ticker: { type: 'string' },
    years: { type: 'string' },
    live: { type: 'boolean', default: false },
    symbols: { type: 'string' },
    check: { type: 'string' },
    format: { type: 'string', default: 'json' },
    out: { type: 'string' },
    feed: { type: 'string', default: 'alpaca_news_stream' },
    recovery: { type: 'boolean', default: false },
  },
});
const command = positionals[0];
const ctx = createContext();
const { db, alpaca, env } = ctx;

/**
 * --html <file>: writes the HTML (and .preview/<name>-props.json for `pnpm email:preview`);
 * --test-send: emails a one-off copy under a unique dedupe key; otherwise prints the text.
 */
async function previewOrSend(
  name: string,
  msg: { subject: string; html: string; text: string; props: unknown },
) {
  if (values.html) {
    // Paths are relative to where `pnpm collect` was run (pnpm runs the script in apps/worker).
    const root = process.env.INIT_CWD ?? process.cwd();
    const out = resolve(root, values.html);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, msg.html);
    const props = resolve(root, `.preview/${name}-props.json`);
    mkdirSync(dirname(props), { recursive: true });
    writeFileSync(props, JSON.stringify(msg.props, null, 2));
    console.log(
      `wrote ${out} (${(Buffer.byteLength(msg.html) / 1024).toFixed(1)} KB) and ${props}`,
    );
  }
  if (values['test-send']) {
    await enqueueAlert(db, {
      dedupeKey: `${name}-test:${new Date().toISOString()}`,
      kind: 'test',
      severity: 'info',
      channel: 'email',
      subject: msg.subject,
      body: msg.text,
      html: msg.html,
    });
    const res = await outboxJob(ctx);
    console.log(`queued test ${name} "${msg.subject}"; outbox: ${JSON.stringify(res)}`);
    return;
  }
  if (!values.html) console.log(`Subject: ${msg.subject}\n\n${msg.text}`);
}

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
    case 'earnings': {
      // Uses one of the 2 allowed Alpha Vantage calls today (skips if today already succeeded).
      const res = await earningsJob(ctx).catch((e: unknown) => {
        console.error(String(e));
        return null;
      });
      if (res) console.log(JSON.stringify(res.meta, null, 2));
      break;
    }
    case 'morning': {
      // --dry-run (default): print the email; --html f / --test-send as for the digest.
      // --send: send it now as a real morning email (a one-off key, so the scheduled 5:45 AM
      // email still goes out). --as-of: render as of another time.
      const now = values['as-of'] ? new Date(values['as-of']) : new Date();
      const msg = await renderMorning(await gatherMorning(db, alpaca, now));
      if (!values.send) {
        await previewOrSend(
          'morning',
          values['test-send'] ? { ...msg, subject: `${msg.subject} (test)` } : msg,
        );
        break;
      }
      await enqueueAlert(db, {
        dedupeKey: `morning-manual:${new Date().toISOString()}`,
        kind: 'morning',
        severity: 'info',
        channel: 'email',
        subject: msg.subject,
        body: msg.text,
        html: msg.html,
      });
      const res = await outboxJob(ctx);
      console.log(`queued "${msg.subject}"; outbox: ${JSON.stringify(res)}`);
      break;
    }
    case 'levels':
      await printLevels(ctx, values['as-of'] ? new Date(values['as-of']) : new Date());
      break;
    case 'events': {
      const failed = await eventsRefreshJob(ctx, { forceEcon: values.force });
      if (failed.length) console.log(`failed: ${failed.join(', ')}`);
      const rows = await db
        .select()
        .from(eventsTable)
        .where(gte(eventsTable.date, nyDate(new Date())))
        .orderBy(eventsTable.date, eventsTable.ticker);
      for (const e of rows) {
        console.log(
          `  ${e.date} ${e.ticker.padEnd(6)} ${e.eventType.padEnd(14)} ${e.source.padEnd(12)} ${e.status.padEnd(10)} ${e.estimated ? 'est ' : '    '}${e.title.slice(0, 60)}${e.autoNote ? `  [${e.autoNote}]` : ''}${e.previousDate ? `  (was ${e.previousDate})` : ''}`,
        );
      }
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
      const data = await gatherDigest(db, date);
      if (values.json) {
        console.log(JSON.stringify(data, null, 2));
        break;
      }
      const msg = await composeDigest(data, { barsFeed: env.ALPACA_BARS_FEED });
      await previewOrSend(
        'digest',
        values['test-send'] ? { ...msg, subject: `${msg.subject} (test)` } : msg,
      );
      break;
    }
    case 'alert': {
      if (!values.ticker) throw new Error('--ticker is required');
      const date = values.date ?? (await latestCompletedSession(db));
      if (!date) throw new Error('no completed session');
      const res = await previewRuleAlert(db, values.ticker, date);
      if (!res.msg) {
        console.log(
          `no rule fired for ${values.ticker} on ${date}; fired: ${res.fired.join(', ') || 'none'} (run \`pnpm collect check --date ${date}\` first if needed)`,
        );
        break;
      }
      await previewOrSend('alert', { ...res.msg, subject: `${res.msg.subject} (test)` });
      break;
    }
    case 'health-email': {
      const now = new Date();
      const recovery = values.recovery;
      const msg = await composeHealthAlert(
        {
          feed: values.feed,
          kind: recovery ? 'recovery' : 'failure',
          from: recovery ? 'down' : 'ok',
          to: recovery ? 'ok' : 'down',
          detail: recovery ? 'connected' : 'simulated outage (preview)',
        },
        now,
        {
          since: recovery ? new Date(now.getTime() - 95 * 60_000) : now,
          others: [
            'alpaca_news_stream',
            'alpaca_quotes',
            'alpaca_bars',
            'sec_edgar',
            'scheduler',
          ].map((feed) => ({ feed, status: 'ok' as const })),
        },
      );
      await previewOrSend('health', { ...msg, subject: `${msg.subject} (test)` });
      break;
    }
    case 'universe-refresh':
      await universeRefreshCommand(ctx);
      break;
    case 'screen-bars':
      await screenBarsCommand(ctx, values.years ? Number(values.years) : undefined);
      break;
    case 'fundamentals':
      console.log(
        await fundamentalsJob(ctx, {
          symbols: values.symbols?.split(',').map((x) => x.trim().toUpperCase()),
        }),
      );
      break;
    case 'scorecard':
      await scorecardCommand(
        ctx,
        values.symbols?.split(',').map((x) => x.trim().toUpperCase()),
      );
      break;
    case 'pullback-check': {
      const check = values.check as 'open' | 'midday' | 'eod' | undefined;
      if (!check || !['open', 'midday', 'eod'].includes(check)) {
        throw new Error('--check open|midday|eod is required');
      }
      const date = values.date ?? nyDate(new Date());
      const res = await runPullbackCheckJob(ctx, check, date);
      console.log(JSON.stringify(res.meta, null, 2));
      break;
    }
    case 'pullback-preview': {
      // Real data, nothing stored: the alert email these symbols would get as new qualifiers.
      const symbols = values.symbols?.split(',').map((x) => x.trim().toUpperCase()) ?? [];
      if (!symbols.length) throw new Error('--symbols A,B is required');
      const check = (values.check ?? 'midday') as 'open' | 'midday' | 'eod';
      const date = values.date ?? nyDate(new Date());
      const msgs = await pullbackPreview(ctx, check, date, symbols);
      if (!msgs.length) console.log('none of those symbols qualifies right now');
      for (const m of msgs) {
        await previewOrSend(
          'pullback',
          values['test-send'] ? { ...m, subject: `${m.subject} (test)` } : m,
        );
      }
      break;
    }
    case 'pullback-export': {
      const data = await buildPullbackExport(db, { date: values.date });
      const body =
        values.format === 'csv' ? pullbackExportCsv(data) : JSON.stringify(data, null, 2);
      if (values.out) {
        const out = resolve(process.env.INIT_CWD ?? process.cwd(), values.out);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, `${body}\n`);
        console.log(`wrote ${data.items.length} names (${data.date} ${data.check}) to ${out}`);
      } else console.log(body);
      break;
    }
    case 'pullbacks':
      await pullbacksCommand(ctx);
      break;
    case 'screen-prices':
      await screenPricesCommand(ctx, {
        live: values.live,
        symbols: values.symbols?.split(',').map((x) => x.trim().toUpperCase()),
      });
      break;
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
        'usage: pnpm collect <calendar|bars|quotes|news|stream|ciks|filings|earnings|events|levels|morning|check|due|health|digest|alerts|test-email|schedule|status> [options]',
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
