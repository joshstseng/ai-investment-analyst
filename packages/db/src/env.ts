import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Loads ../../.env when present (local dev); on Railway, variables come from the environment. */
export function loadDatabaseUrl(): string {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  } catch {
    // no .env file
  }
  // Strip quotes pasted around the value (shells and dashboards can keep them literally).
  const raw = process.env.DATABASE_URL?.trim().replace(/^(["'])(.*)\1$/, '$2');
  return z.string({ error: 'DATABASE_URL is not set' }).url().parse(raw);
}
