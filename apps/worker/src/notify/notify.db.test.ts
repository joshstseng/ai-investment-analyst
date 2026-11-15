/** Escalation + outbox against Postgres, inside a rolled-back transaction. */
import type { Outcome } from '@aia/core';
import {
  alerts,
  alertStates,
  createDb,
  exitRules,
  instruments,
  loadDatabaseUrl,
  type Db,
} from '@aia/db';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { CheckResult } from '../rules/check';
import type { Mailer } from './mailer';
import { enqueueAlert, MAX_ATTEMPTS, sendPending } from './outbox';
import { processRuleAlerts } from './rule-alerts';

const url = (() => {
  try {
    return loadDatabaseUrl();
  } catch {
    return undefined;
  }
})();

class Rollback extends Error {}

const stopFired = (close: number, level: 'warning' | 'stop'): Outcome => ({
  kind: 'fired',
  severity: level === 'stop' ? 'critical' : 'warn',
  level,
  message: `closed at ${close}`,
  observed: { close },
  track: { kind: 'state', rank: level === 'stop' ? 2 : 1, direction: 'down', price: close },
});
const notFired: Outcome = { kind: 'not_fired', message: 'ok', observed: {} };

describe.skipIf(!url)('alerts (Postgres)', () => {
  const { db, sql: client } = createDb(url ?? '', { max: 1 });
  afterAll(() => client.end());

  async function inTx(fn: (tx: Db) => Promise<void>) {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(4242)`);
        await tx.execute(
          sql`TRUNCATE alerts, alert_states, exit_rules, instruments RESTART IDENTITY CASCADE`,
        );
        await fn(tx as unknown as Db);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  async function seedRule(tx: Db) {
    const [inst] = await tx
      .insert(instruments)
      .values({ symbol: 'BKX', instrumentType: 'stock' })
      .returning({ id: instruments.id });
    const [rule] = await tx
      .insert(exitRules)
      .values({
        instrumentId: inst!.id,
        purpose: 'risk_stop',
        status: 'CONFIRMED',
        ruleType: 'stop_close_below',
        params: { level: 96.28, warn_close_at_or_below: 100 },
        alertNote: 'Exit all.',
      })
      .returning({ id: exitRules.id });
    return rule!.id;
  }

  const result = (ruleId: number, outcome: Outcome): CheckResult => ({
    ruleId,
    externalKey: 'k',
    symbol: 'BKX',
    evaluatedSymbol: 'BKX',
    status: 'CONFIRMED',
    ruleType: 'stop_close_below',
    outcome,
  });

  it('alerts on first fire, then only on escalation, and resets when it clears', async () => {
    await inTx(async (tx) => {
      const id = await seedRule(tx);
      const day = async (date: string, o: Outcome) =>
        (await processRuleAlerts(tx, [result(id, o)], date)).queued.length;

      expect(await day('2026-11-23', stopFired(99, 'warning'))).toBe(1); // first: WARNING
      expect(await day('2026-11-23', stopFired(99, 'warning'))).toBe(0); // same-day re-run
      expect(await day('2026-11-24', stopFired(98, 'warning'))).toBe(0); // still active, <2%
      expect(await day('2026-11-25', stopFired(96, 'stop'))).toBe(1); // warning → breach
      expect(await day('2026-11-27', stopFired(94.4, 'stop'))).toBe(0); // 1.7% further
      expect(await day('2026-11-30', stopFired(94, 'stop'))).toBe(1); // 2.08% further
      expect(await day('2026-12-01', notFired)).toBe(0); // clears → reset
      const [state] = await tx.select().from(alertStates).where(eq(alertStates.exitRuleId, id));
      expect(state!.active).toBe(false);
      expect(await day('2026-12-02', stopFired(99.5, 'warning'))).toBe(1); // first again

      const subjects = (await tx.select().from(alerts).orderBy(asc(alerts.id))).map(
        (a) => a.subject,
      );
      expect(subjects).toEqual([
        '[AIA] WARNING BKX: at warning level',
        '[AIA] ACTION BKX: closed below stop (escalated)',
        '[AIA] ACTION BKX: closed below stop (further move)',
        '[AIA] WARNING BKX: at warning level',
      ]);
    });
  });

  it('sends queued alerts once, retries failures, and dedupes by key', async () => {
    await inTx(async (tx) => {
      const sent: string[] = [];
      const ok: Mailer = {
        from: 'a@b.co',
        to: ['a@b.co'],
        send: vi.fn(async (m) => {
          sent.push(m.subject);
          return { messageId: 'x' };
        }),
      };
      const broken: Mailer = {
        ...ok,
        send: vi.fn(async () => Promise.reject(new Error('smtp down'))),
      };

      const a = {
        kind: 'test' as const,
        severity: 'info' as const,
        channel: 'email' as const,
        subject: 'S',
        body: 'B',
      };
      expect(await enqueueAlert(tx, { ...a, dedupeKey: 'k1' })).not.toBeNull();
      expect(await enqueueAlert(tx, { ...a, dedupeKey: 'k1' })).toBeNull(); // duplicate key

      expect(await sendPending(tx, broken)).toMatchObject({ pending: 1, sent: 0, failed: 1 });
      const [failed] = await tx.select().from(alerts);
      expect(failed).toMatchObject({ attempts: 1, error: 'Error: smtp down', sentAt: null });

      expect(await sendPending(tx, ok)).toMatchObject({ sent: 1 });
      expect(await sendPending(tx, ok)).toMatchObject({ pending: 0 }); // never twice
      expect(sent).toEqual(['S']);

      // Gives up after MAX_ATTEMPTS.
      await enqueueAlert(tx, { ...a, dedupeKey: 'k2' });
      for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await sendPending(tx, broken);
      const [k2] = await tx.select().from(alerts).where(eq(alerts.dedupeKey, 'k2'));
      expect(k2!.attempts).toBe(MAX_ATTEMPTS);
    });
  });
});
