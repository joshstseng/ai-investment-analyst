/**
 * Minimal read-only HTTP server for the pullback screen's shared output (only started when
 * PULLBACK_EXPORT_TOKEN is set). Railway sets PORT and, once a public domain is generated,
 * routes https://<domain>/ to it.
 *   GET /health              → 200 "ok" (no auth)
 *   GET /pullbacks.json      → latest qualifying names (Authorization: Bearer <token>, or ?token=)
 *   GET /pullbacks.csv       → the same as CSV
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Db } from '@aia/db';
import { log } from './lib/log';
import { buildPullbackExport, pullbackExportCsv } from './pullbacks/export';

/** Constant-time token check (pure). */
export function tokenMatches(given: string | null | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startExportServer(p: { db: Db; token: string; port: number }): Server {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method !== 'GET') {
        res.writeHead(405).end();
        return;
      }
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
        return;
      }
      if (url.pathname !== '/pullbacks.json' && url.pathname !== '/pullbacks.csv') {
        res.writeHead(404).end();
        return;
      }
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!tokenMatches(bearer ?? url.searchParams.get('token'), p.token)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
        return;
      }
      const data = await buildPullbackExport(p.db, {
        date: url.searchParams.get('date') ?? undefined,
      });
      if (url.pathname.endsWith('.csv')) {
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(pullbackExportCsv(data));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data, null, 2));
      }
    } catch (error) {
      log.error('export server error', { path: url.pathname, error: String(error) });
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  server.listen(p.port, () => log.info('export server listening', { port: p.port }));
  return server;
}
