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
  if (!raw) {
    throw new Error(
      'DATABASE_URL is not set or is empty (a shell variable like DATABASE_URL="$X" with an empty $X overrides .env)',
    );
  }
  if (raw.includes('${{')) {
    throw new Error('DATABASE_URL is a Railway template (${{...}}), not the resolved URL');
  }
  // Never echo the value: it contains the password.
  return z.string().url({ error: 'DATABASE_URL is not a valid URL' }).parse(raw);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

/**
 * DATABASE_URL for integration tests, or undefined (tests skip) unless it points at a local
 * database. The DB tests truncate tables inside rolled-back transactions; they must never run
 * against Railway or any other real database, whatever .env says.
 */
export function testDatabaseUrl(): string | undefined {
  let url: string;
  try {
    url = loadDatabaseUrl();
  } catch {
    return undefined;
  }
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    console.warn(`[db tests] skipped: DATABASE_URL host "${host}" is not a local database`);
    return undefined;
  }
  return url;
}
