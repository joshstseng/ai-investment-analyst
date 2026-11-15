/**
 * Alert outbox. Alerts are written once (dedupe_key is unique), then sent. A crash between the
 * two leaves the row unsent and the retry job picks it up; a re-run never sends twice.
 */
import { alerts, type Db } from '@aia/db';
import { and, asc, eq, gte, isNull, lt } from 'drizzle-orm';
import { log } from '../lib/log';
import type { Mailer } from './mailer';

export const MAX_ATTEMPTS = 5;
/** Unsent alerts older than this are left alone (stale; the digest still shows conditions). */
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface NewAlert {
  dedupeKey: string;
  kind: 'rule' | 'health' | 'digest' | 'test';
  severity: 'info' | 'warn' | 'critical';
  channel: 'email' | 'digest';
  subject: string;
  body: string;
  html?: string;
  symbol?: string | null;
  ruleEvaluationId?: number | null;
  asOfDate?: string | null;
}

/** Inserts the alert unless its dedupe_key already exists. Returns the new id or null. */
export async function enqueueAlert(db: Db, a: NewAlert): Promise<number | null> {
  const [row] = await db
    .insert(alerts)
    .values({
      dedupeKey: a.dedupeKey,
      kind: a.kind,
      severity: a.severity,
      channel: a.channel,
      subject: a.subject,
      body: a.body,
      html: a.html ?? null,
      symbol: a.symbol ?? null,
      ruleEvaluationId: a.ruleEvaluationId ?? null,
      asOfDate: a.asOfDate ?? null,
    })
    .onConflictDoNothing({ target: alerts.dedupeKey })
    .returning({ id: alerts.id });
  return row?.id ?? null;
}

/** True while a send pass is running in this process (two passes could send an alert twice). */
let sending = false;

/**
 * Sends unsent alerts, oldest first (under the attempt limit, created in the last 24 h).
 * Stops at the first failure: if the mail server is down, the rest would fail the same way, so
 * they stay queued for the next pass instead of each burning the full retry time.
 * Returns skipped=true if another pass is already running in this process.
 */
export async function sendPending(db: Db, mailer: Mailer | null, now = new Date()) {
  if (sending) return { pending: 0, sent: 0, failed: 0, deferred: 0, skipped: true };
  sending = true;
  try {
    const pending = await db
      .select()
      .from(alerts)
      .where(
        and(
          isNull(alerts.sentAt),
          lt(alerts.attempts, MAX_ATTEMPTS),
          gte(alerts.createdAt, new Date(now.getTime() - RETRY_WINDOW_MS)),
        ),
      )
      .orderBy(asc(alerts.id));
    let sent = 0;
    let failed = 0;
    for (const a of pending) {
      if (!mailer) {
        await db
          .update(alerts)
          .set({ error: 'email not configured (GMAIL_USER / GMAIL_APP_PASSWORD / ALERT_EMAIL_TO)' })
          .where(eq(alerts.id, a.id));
        failed++;
        continue;
      }
      try {
        await mailer.send({ subject: a.subject, text: a.body, html: a.html ?? undefined });
        await db
          .update(alerts)
          .set({ sentAt: new Date(), attempts: a.attempts + 1, error: null })
          .where(eq(alerts.id, a.id));
        sent++;
        log.info('alert sent', { id: a.id, subject: a.subject });
      } catch (error) {
        // mailer errors are already redacted
        await db
          .update(alerts)
          .set({ attempts: a.attempts + 1, error: String(error).slice(0, 500) })
          .where(eq(alerts.id, a.id));
        failed++;
        log.warn('alert send failed; leaving the rest queued for the next pass', {
          id: a.id,
          attempt: a.attempts + 1,
          stillQueued: pending.length - sent - failed,
          error: String(error),
        });
        break;
      }
    }
    return {
      pending: pending.length,
      sent,
      failed,
      deferred: pending.length - sent - failed,
      skipped: false,
    };
  } finally {
    sending = false;
  }
}
