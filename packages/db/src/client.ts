import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>['db'];

/** Creates a Drizzle client. Sessions run in UTC so timestamps round-trip unchanged. */
export function createDb(url: string, opts: { max?: number } = {}) {
  const sql = postgres(url, {
    max: opts.max ?? 5,
    connect_timeout: 10,
    idle_timeout: 30,
    connection: { TimeZone: 'UTC' },
    onnotice: () => {},
  });
  return { db: drizzle(sql, { schema, casing: 'snake_case' }), sql };
}

/** A transaction handle, as passed to `db.transaction(async (tx) => ...)`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
