/** Alpha Vantage sync and health against Postgres, in rolled-back transactions (made-up data). */
import {
  alerts,
  createDb,
  events,
  feedStatus,
  jobRuns,
  testDatabaseUrl,
  upsertEvents,
  type Db,
} from '@aia/db';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EARNINGS_FEED,
  EARNINGS_JOB,
  parseEarningsCsv,
  syncEarningsCalendar,
  updateCalendarHealth,
} from './alphavantage';

const url = testDatabaseUrl();
class Rollback extends Error {}
const HEADER = 'symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay';
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');
const TICKERS = new Set(['ACMX', 'BKX']);

describe.skipIf(!url)('Alpha Vantage sync (Postgres)', () => {
  const { db, sql: client } = createDb(url ?? '', { max: 1 });
  afterAll(() => client.end());

  async function inTx(fn: (tx: Db) => Promise<void>) {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(4242)`);
        await tx.execute(
          sql`TRUNCATE events, alerts, job_runs, feed_status RESTART IDENTITY CASCADE`,
        );
        await fn(tx as unknown as Db);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }
  const now = new Date('2026-11-16T13:00:00Z');
  const seedEstimate = (tx: Db, ticker: string, date: string, confirmed = false) =>
    upsertEvents(tx, [
      {
        ticker,
        eventType: 'earnings',
        date,
        title: 'Estimated results',
        confirmed,
        estimated: !confirmed,
        source: 'seed',
        sourceRef: `${ticker}:earnings:${date}`,
      },
    ]);

  it('replaces a seeded estimate within ±45 days and notes it; leaves confirmed seeds alone', async () => {
    await inTx(async (tx) => {
      await seedEstimate(tx, 'ACMX', '2026-12-09');
      await seedEstimate(tx, 'BKX', '2026-11-19', true);
      const res = await syncEarningsCalendar(
        tx,
        parseEarningsCsv(
          csv(
            'ACMX,ACME,2026-12-10,2026-10-31,1.59,USD,post-market',
            'BKX,BKX,2026-11-20,2026-09-30,,USD,',
            'ZZZZ,OTHER,2026-12-01,2026-09-30,,USD,',
          ),
        ),
        TICKERS,
        now,
      );
      expect(res).toMatchObject({ events: 2, inserted: 2, superseded: 2 });
      // Sort in JS: `source` is an enum, which Postgres orders by declaration, not alphabetically.
      const rows = (await tx.select().from(events)).sort(
        (a, b) => a.ticker.localeCompare(b.ticker) || a.source.localeCompare(b.source),
      );
      const view = rows.map((e) => [e.ticker, e.source, e.date, e.status, e.autoNote]);
      expect(view).toEqual([
        ['ACMX', 'alphavantage', '2026-12-10', 'active', 'replaced seeded estimate 12/9 (-1 day)'],
        ['ACMX', 'seed', '2026-12-09', 'superseded', null],
        ['BKX', 'alphavantage', '2026-11-20', 'superseded', null],
        ['BKX', 'seed', '2026-11-19', 'active', 'Alpha Vantage: 11/20 (+1 day)'], // confirmed seed kept
      ]);
    });
  });

  it('detects a date change for the same fiscal period and cancels dates it drops', async () => {
    await inTx(async (tx) => {
      const first = csv(
        'ACMX,ACME,2026-11-19,2026-10-31,1.59,USD,post-market',
        'BKX,BKX,2026-12-10,2026-10-31,,USD,',
      );
      await syncEarningsCalendar(tx, parseEarningsCsv(first), TICKERS, now);
      const moved = await syncEarningsCalendar(
        tx,
        parseEarningsCsv(csv('ACMX,ACME,2026-11-20,2026-10-31,1.59,USD,post-market')),
        TICKERS,
        new Date('2026-11-17T13:00:00Z'),
      );
      expect(moved.dateChanges).toEqual(['ACMX moved 11/19 → 11/20']);
      expect(moved.cancelled).toBe(1);
      const [acmx] = await tx.select().from(events).where(eq(events.ticker, 'ACMX'));
      expect(acmx).toMatchObject({ date: '2026-11-20', previousDate: '2026-11-19' });
      const [bkx] = await tx.select().from(events).where(eq(events.ticker, 'BKX'));
      expect(bkx!.status).toBe('cancelled');
    });
  });

  it('sends one HEALTH email after 2 failed days in a row, and one on recovery', async () => {
    await inTx(async (tx) => {
      const run = (day: string, hourUtc: number, status: 'success' | 'error') =>
        tx
          .insert(jobRuns)
          .values({ job: EARNINGS_JOB, status, startedAt: new Date(`${day}T${hourUtc}:00:00Z`) });
      await run('2026-11-12', 13, 'success');
      await run('2026-11-13', 13, 'error');
      await run('2026-11-13', 13, 'error');
      expect(await updateCalendarHealth(tx, new Date('2026-11-13T14:00:00Z'))).toMatchObject({
        status: 'degraded',
        failedDays: 1,
      });
      expect(await tx.$count(alerts)).toBe(0);

      await run('2026-11-16', 13, 'error');
      expect(await updateCalendarHealth(tx, new Date('2026-11-16T13:05:00Z'))).toMatchObject({
        status: 'down',
        failedDays: 2,
      });
      await run('2026-11-16', 14, 'error');
      await updateCalendarHealth(tx, new Date('2026-11-16T14:05:00Z')); // still down: no second email
      await run('2026-11-17', 13, 'success');
      expect(await updateCalendarHealth(tx, new Date('2026-11-17T13:05:00Z'))).toMatchObject({
        status: 'ok',
      });

      const subjects = (await tx.select().from(alerts).orderBy(asc(alerts.id))).map(
        (a) => a.subject,
      );
      expect(subjects).toEqual([
        '[AIA] HEALTH Earnings calendar (Alpha Vantage): down',
        '[AIA] HEALTH Earnings calendar (Alpha Vantage): recovered',
      ]);
      const [status] = await tx.select().from(feedStatus).where(eq(feedStatus.feed, EARNINGS_FEED));
      expect(status!.status).toBe('ok');
    });
  });
});

describe.skipIf(!url)('economic calendar (Postgres)', () => {
  const { db, sql: client } = createDb(url ?? '', { max: 1 });
  afterAll(() => client.end());

  it('stores USD High/Medium idempotently and fetches at most once a day unless forced', async () => {
    const { econEvents } = await import('@aia/db');
    const { econCalendarJob, ECON_JOB } = await import('./econ-calendar');
    const feed = [
      {
        title: 'CPI m/m',
        country: 'USD',
        date: '2026-11-18T08:30:00-05:00',
        impact: 'High',
        forecast: '0.3%',
        previous: '0.4%',
      },
      {
        title: 'Speech',
        country: 'USD',
        date: '2026-11-18T10:00:00-05:00',
        impact: 'Low',
        forecast: '',
        previous: '',
      },
    ];
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify(feed), { status: 200 });
    }) as typeof fetch;
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(4242)`);
        await tx.execute(sql`TRUNCATE econ_events, job_runs RESTART IDENTITY CASCADE`);
        const t = tx as unknown as Db;
        const now = new Date('2026-11-16T13:00:00Z');
        expect((await econCalendarJob(t, { now, fetchImpl })).items).toBe(1);
        await t.insert(jobRuns).values({ job: ECON_JOB, status: 'success', startedAt: now });
        expect((await econCalendarJob(t, { now, fetchImpl })).status).toBe('skipped');
        expect((await econCalendarJob(t, { now, fetchImpl, force: true })).items).toBe(1);
        expect(calls).toBe(2);
        expect(await t.$count(econEvents)).toBe(1); // re-fetch updated, didn't duplicate
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });
});
