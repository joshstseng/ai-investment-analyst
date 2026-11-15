import { jobRuns, type Db } from '@aia/db';
import { eq } from 'drizzle-orm';
import { log } from './log';

export interface JobResult {
  status?: 'success' | 'skipped';
  items?: number;
  meta?: Record<string, unknown>;
}

/** Runs `fn` and records it in job_runs (running → success/skipped/error). Rethrows errors. */
export async function runJob<T extends JobResult>(db: Db, job: string, fn: () => Promise<T>) {
  const [run] = await db.insert(jobRuns).values({ job }).returning({ id: jobRuns.id });
  const started = Date.now();
  try {
    const result = await fn();
    await db
      .update(jobRuns)
      .set({
        status: result.status ?? 'success',
        finishedAt: new Date(),
        itemsProcessed: result.items ?? null,
        meta: result.meta ?? {},
      })
      .where(eq(jobRuns.id, run!.id));
    log.info(`job ${job} ${result.status ?? 'success'}`, {
      ms: Date.now() - started,
      items: result.items,
      ...result.meta,
    });
    return result;
  } catch (error) {
    await db
      .update(jobRuns)
      .set({ status: 'error', finishedAt: new Date(), error: String(error) })
      .where(eq(jobRuns.id, run!.id));
    log.error(`job ${job} failed`, { ms: Date.now() - started, error: String(error) });
    throw error;
  }
}
