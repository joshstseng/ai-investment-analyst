/**
 * `pnpm collect universe-refresh`: rebuilds config/universe/sp500.csv and nasdaq100.csv.
 * Membership: Wikipedia's constituent tables. S&P 500 rank: market cap = shares (SEC XBRL frames,
 * one request for all filers) × last SIP close (Alpaca). Run it locally and commit the CSVs.
 */
import { addDays, nyDate } from '@aia/core';
import { z } from 'zod';
import type { AlpacaClient } from '../alpaca/client';
import { requestJson } from '../lib/http';
import { log } from '../lib/log';
import type { SecClient } from '../sec/client';
import type { PullbackConfig } from './config';
import { parseNasdaq100, parseSp500, rankSp500, writeUniverseCsvs } from './universe';

/** Generic client name: no personal details go to Wikipedia. */
const WIKI_UA = 'ai-investment-analyst-universe-refresh/1.0';
const wikiRaw = (title: string) =>
  requestJson(
    `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(title)}&action=raw`,
    {
      schema: z.string(),
      responseType: 'text',
      headers: { 'User-Agent': WIKI_UA },
      timeoutMs: 30_000,
    },
  );

/** Calendar quarters before `date`, newest first: ["CY2026Q3", "CY2026Q2", …]. */
export function recentQuarters(date: string, n: number): string[] {
  let y = Number(date.slice(0, 4));
  let q = Math.floor((Number(date.slice(5, 7)) - 1) / 3); // current quarter index 0..3 → previous
  const out: string[] = [];
  while (out.length < n) {
    if (q === 0) {
      y -= 1;
      q = 4;
    }
    out.push(`CY${y}Q${q}`);
    q -= 1;
  }
  return out;
}

/**
 * Shares per CIK: diluted weighted-average shares from the latest quarters (covers multi-class
 * companies), falling back to the cover-page shares outstanding.
 */
async function sharesByCik(sec: SecClient, today: string) {
  const out = new Map<string, number>();
  const tries = [
    ...recentQuarters(today, 3).map((period) => ({
      tax: 'us-gaap',
      concept: 'WeightedAverageNumberOfDilutedSharesOutstanding',
      period,
    })),
    ...recentQuarters(today, 2).map((p) => ({
      tax: 'dei',
      concept: 'EntityCommonStockSharesOutstanding',
      period: `${p}I`,
    })),
  ];
  for (const { tax, concept, period } of tries) {
    try {
      const frame = await sec.frames(tax, concept, 'shares', period);
      for (const d of frame.data) {
        const cik = String(d.cik).padStart(10, '0');
        if (!out.has(cik) && d.val > 0) out.set(cik, d.val);
      }
    } catch (error) {
      log.warn('frames request failed', { concept, period, error: String(error) });
    }
  }
  return out;
}

export async function refreshUniverse(
  p: { sec: SecClient; alpaca: AlpacaClient; cfg: PullbackConfig },
  now = new Date(),
) {
  const [spRaw, ndxRaw] = [
    await wikiRaw('List of S&P 500 companies'),
    await wikiRaw('List of NASDAQ-100 companies'),
  ];
  const sp = parseSp500(spRaw);
  const ndx = parseNasdaq100(ndxRaw);
  if (sp.length < 490 || ndx.length < 95) {
    throw new Error(
      `unexpected list sizes (S&P ${sp.length}, Nasdaq-100 ${ndx.length}); not writing`,
    );
  }

  const today = nyDate(now);
  const shares = await sharesByCik(p.sec, today);
  const bars = await p.alpaca.dailyBars({
    symbols: sp.map((m) => m.symbol),
    start: addDays(today, -10),
    end: new Date(now.getTime() - 16 * 60_000).toISOString(),
    feed: 'sip',
  });
  const closes = new Map(
    [...bars].filter(([, b]) => b.length).map(([s, b]) => [s, b.at(-1)!.c] as const),
  );
  const ranked = rankSp500(sp, shares, closes, p.cfg.universe.core);
  writeUniverseCsvs(ranked, ndx);

  const unsized = ranked.filter((r) => r.marketCapUsd === null).map((r) => r.symbol);
  return {
    sp500: ranked.length,
    nasdaq100: ndx.length,
    top10: ranked.slice(0, 10).map((r) => `${r.rank}. ${r.symbol}`),
    cutoff: ranked.find((r) => r.rank === p.cfg.universe.sp500Top),
    unsized,
  };
}
