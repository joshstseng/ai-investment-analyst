import { feedStatus, type Db } from '@aia/db';
import { sql } from 'drizzle-orm';
import type { FeedState } from './assess';

/** Upserts a feed's status; `since` only moves when the status changes. */
export async function recordFeedStatus(
  db: Db,
  r: {
    feed: string;
    status: FeedState;
    detail: string | null;
    okNow: boolean;
    meta?: Record<string, unknown>;
  },
  now = new Date(),
) {
  await db
    .insert(feedStatus)
    .values({
      feed: r.feed,
      status: r.status,
      detail: r.detail,
      since: now,
      lastOkAt: r.okNow ? now : null,
      checkedAt: now,
      meta: r.meta ?? {},
    })
    .onConflictDoUpdate({
      target: feedStatus.feed,
      set: {
        since: sql`CASE WHEN ${feedStatus.status} = excluded.status THEN ${feedStatus.since} ELSE excluded.since END`,
        status: sql`excluded.status`,
        detail: sql`excluded.detail`,
        lastOkAt: sql`COALESCE(excluded.last_ok_at, ${feedStatus.lastOkAt})`,
        checkedAt: sql`excluded.checked_at`,
        meta: sql`excluded.meta`,
      },
    });
}
