/** `pnpm db:migrate`: applies pending migrations to DATABASE_URL (the worker also does this on start). */
import { loadDatabaseUrl } from './env';
import { describeDatabaseUrl, runMigrations } from './migrations';

const url = loadDatabaseUrl();
console.log(`[db] migrating ${describeDatabaseUrl(url)}`);
await runMigrations(url);
console.log('[db] migrations applied');
