import type { AddressInfo } from 'node:net';
import type { Db } from '@aia/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pullbackExportCsv, type PullbackExport } from './pullbacks/export';
import { startExportServer, tokenMatches } from './server';

const TOKEN = 'test-token-0123456789abcdef';

describe('tokenMatches', () => {
  it('needs the exact token', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches('', TOKEN)).toBe(false);
    expect(tokenMatches(null, TOKEN)).toBe(false);
  });
});

describe('export server (no database needed for these paths)', () => {
  let base = '';
  let server: ReturnType<typeof startExportServer>;
  beforeAll(async () => {
    server = startExportServer({ db: {} as Db, token: TOKEN, port: 0 });
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('health is open; the export needs the token; unknown paths 404', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/pullbacks.json`)).status).toBe(401);
    expect(
      (await fetch(`${base}/pullbacks.json`, { headers: { Authorization: 'Bearer wrong' } }))
        .status,
    ).toBe(401);
    expect((await fetch(`${base}/other`)).status).toBe(404);
    expect((await fetch(`${base}/pullbacks.json`, { method: 'POST' })).status).toBe(405);
  });
});

describe('pullbackExportCsv', () => {
  it('one row per name with key scorecard columns', () => {
    const e: PullbackExport = {
      generatedAt: '2026-11-17T21:30:00.000Z',
      date: '2026-11-17',
      check: 'eod',
      note: 'x',
      items: [
        {
          symbol: 'ACMX',
          date: '2026-11-17',
          check: 'eod',
          checkedAt: '2026-11-17T21:21:00.000Z',
          price: 187.5,
          priceAt: '2026-11-17T21:21:00.000Z',
          priceSource: 'alpaca:sip',
          intraday: false,
          prevClose: 205,
          high52: 250,
          high52Date: '2026-07-15',
          low52: 150,
          belowHighPct: 25,
          d1Pct: -8.54,
          d5Pct: -9.1,
          worstDropPct: -9.1,
          worstDropDays: 5,
          atr14: 6,
          tier: 25,
          reasons: ['from_high', 'one_day'],
          gapDown: false,
          qualityPass: true,
          alertKinds: ['deeper_tier', 'one_day_drop'],
          qualifiedSince: '2026-11-10',
          lastAlertedTier: 25,
          scorecard: { revenueYoYPct: 18, peMedian: 27, currency: 'USD' },
        },
      ],
    };
    const [header, row] = pullbackExportCsv(e).split('\n');
    expect(header!.startsWith('symbol,date,check,checkedAt,price')).toBe(true);
    expect(header).toContain('sc_peMedian');
    expect(row).toContain('ACMX,2026-11-17,eod');
    expect(row).toContain('from_high|one_day');
    expect(row!.endsWith(',27,,USD')).toBe(true);
  });
});
