/**
 * Weekly fundamentals for the pullback screen: SEC company facts → compact series per metric
 * (fundamentals table) → quality scorecard (scorecards table). Also the latest earnings release
 * (8-K item 2.02) from EDGAR submissions. SEC fair access: 8 requests/second, declared
 * User-Agent (SEC_USER_AGENT); about 2 requests per company.
 */
import {
  addDays,
  buildScorecard,
  CONCEPTS,
  mergeConcepts,
  nyDate,
  qualityCheck,
  type CompanyFacts,
  type Metric,
  type Scorecard,
  type XbrlFact,
} from '@aia/core';
import { fundamentals, scorecards, type Db } from '@aia/db';
import { inArray, sql } from 'drizzle-orm';
import type { JobResult } from '../lib/jobs';
import { log } from '../lib/log';
import { padCik, type CompanyFactsJson, type SecClient, type Submissions } from '../sec/client';
import type { PullbackConfig } from './config';
import { loadDailyBars } from './prices';
import { readSp500 } from './universe';

/** Facts older than this are dropped (CAGR needs 3 years, valuation medians up to 5). */
const KEEP_YEARS = 7;

/** Compact series per metric from company facts (pure). US GAAP preferred, else IFRS. */
export function extractCompanyFacts(json: CompanyFactsJson, today: string): CompanyFacts | null {
  const taxonomy = json.facts['us-gaap'] ? 'us-gaap' : json.facts['ifrs-full'] ? 'ifrs-full' : null;
  if (!taxonomy) return null;
  const tax = json.facts[taxonomy]!;
  const concepts = CONCEPTS[taxonomy];

  // Reporting currency: the monetary unit with the most net-income facts.
  const counts = new Map<string, number>();
  for (const c of concepts.netIncome ?? []) {
    for (const [unit, facts] of Object.entries(tax[c]?.units ?? {})) {
      if (/^[A-Z]{3}$/.test(unit)) counts.set(unit, (counts.get(unit) ?? 0) + facts.length);
    }
  }
  const currency = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'USD';
  const since = addDays(today, -KEEP_YEARS * 366);

  const series: Partial<Record<Metric, XbrlFact[]>> = {};
  for (const [metric, names] of Object.entries(concepts) as [Metric, string[]][]) {
    const unit = metric === 'dilutedShares' ? 'shares' : currency;
    const lists = names.map((n) =>
      (tax[n]?.units[unit] ?? [])
        .filter((f) => f.end >= since)
        .map((f) => ({
          ...(f.start ? { start: f.start } : {}),
          end: f.end,
          val: f.val,
          form: f.form,
          filed: f.filed,
        })),
    );
    const merged = mergeConcepts(lists);
    if (merged.length) series[metric] = merged;
  }
  return { taxonomy, currency, series };
}

/** Combines a company's facts with a predecessor's (pure); `current` wins on overlaps. */
export function mergeFacts(current: CompanyFacts, prior: CompanyFacts): CompanyFacts {
  const series: CompanyFacts['series'] = {};
  const metrics = new Set([
    ...Object.keys(current.series),
    ...Object.keys(prior.series),
  ]) as Set<Metric>;
  for (const m of metrics)
    series[m] = mergeConcepts([current.series[m] ?? [], prior.series[m] ?? []]);
  return { ...current, series };
}

/** Filing date of the latest 8-K with item 2.02 (results of operations), or null (pure). */
export function lastEarningsRelease(s: Submissions): string | null {
  const r = s.filings.recent;
  let best: string | null = null;
  r.form.forEach((form, i) => {
    if (!/^8-K(\/A)?$/.test(form) || !(r.items[i] ?? '').split(',').includes('2.02')) return;
    const d = r.filingDate[i]!;
    if (!best || d > best) best = d;
  });
  return best;
}

/** Ticker → CIK from SEC's company tickers file ("BRK.B" is "BRK-B" there) and the S&P CSV. */
async function resolveCiks(sec: SecClient, symbols: readonly string[]) {
  const tickers = await sec.companyTickers();
  const by = new Map(
    Object.values(tickers).map((c) => [c.ticker.toUpperCase(), padCik(c.cik_str)]),
  );
  const sp = new Map(readSp500().map((r) => [r.symbol, r.cik]));
  const out = new Map<string, string>();
  for (const s of symbols) {
    const cik = by.get(s) ?? by.get(s.replace('.', '-')) ?? sp.get(s);
    if (cik) out.set(s, cik);
  }
  return out;
}

/** Fetches company facts and submissions for each symbol and stores the extracted series. */
export async function refreshFundamentals(
  db: Db,
  sec: SecClient,
  symbols: readonly string[],
  now = new Date(),
  predecessorCiks: Readonly<Record<string, readonly string[]>> = {},
): Promise<JobResult> {
  const today = nyDate(now);
  const ciks = await resolveCiks(sec, symbols);
  const failed: string[] = [];
  const noCik = symbols.filter((s) => !ciks.has(s));
  let stored = 0;
  for (const symbol of symbols) {
    const cik = ciks.get(symbol);
    const row = {
      symbol,
      cik: cik ?? null,
      entityName: null as string | null,
      taxonomy: null as string | null,
      currency: null as string | null,
      series: {} as Record<string, unknown[]>,
      lastEarningsRelease: null as string | null,
      fetchedAt: now,
      error: null as string | null,
    };
    if (!cik) {
      row.error = 'no CIK (not an SEC registrant)';
    } else {
      try {
        const json = await sec.companyFacts(cik);
        let facts = extractCompanyFacts(json, today);
        // Merge the history of earlier registrants (the current CIK wins on the same period).
        for (const old of predecessorCiks[symbol] ?? []) {
          const prior = extractCompanyFacts(await sec.companyFacts(old), today);
          if (facts && prior && prior.currency === facts.currency) facts = mergeFacts(facts, prior);
          else if (!facts) facts = prior;
        }
        row.entityName = json.entityName ?? null;
        if (!facts) row.error = 'no us-gaap or ifrs-full facts';
        else {
          row.taxonomy = facts.taxonomy;
          row.currency = facts.currency;
          row.series = facts.series as Record<string, unknown[]>;
        }
        row.lastEarningsRelease = lastEarningsRelease(await sec.submissions(cik));
        stored += 1;
      } catch (error) {
        row.error = String(error).slice(0, 300);
        failed.push(symbol);
        log.warn('fundamentals fetch failed', { symbol, error: row.error });
      }
    }
    await db
      .insert(fundamentals)
      .values(row)
      .onConflictDoUpdate({
        target: fundamentals.symbol,
        set: {
          cik: sql`excluded.cik`,
          entityName: sql`excluded.entity_name`,
          taxonomy: sql`excluded.taxonomy`,
          currency: sql`excluded.currency`,
          series: sql`excluded.series`,
          lastEarningsRelease: sql`excluded.last_earnings_release`,
          fetchedAt: sql`excluded.fetched_at`,
          error: sql`excluded.error`,
          updatedAt: now,
        },
      });
  }
  return { items: stored, meta: { symbols: symbols.length, stored, noCik, failed } };
}

/** First index in `dates` (sorted) at or before `date`, by binary search. */
function closeLookup(bars: { date: string; close: number }[]) {
  return (date: string): number | null => {
    let lo = 0;
    let hi = bars.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid]!.date <= date) [ans, lo] = [mid, mid + 1];
      else hi = mid - 1;
    }
    // A close more than 10 days before the date (gap in history) isn't "on or before" enough.
    if (ans < 0 || bars[ans]!.date < addDays(date, -10)) return null;
    return bars[ans]!.close;
  };
}

export interface StoredScorecard {
  symbol: string;
  scorecard: Scorecard;
  marketCapUsd: number | null;
  qualityPass: boolean;
  qualityReasons: string[];
}

/** Recomputes scorecards and the quality filter from stored fundamentals and closes. */
export async function computeScorecards(
  db: Db,
  symbols: readonly string[],
  cfg: PullbackConfig,
  now = new Date(),
): Promise<JobResult & { cards: StoredScorecard[] }> {
  const today = nyDate(now);
  const rows = symbols.length
    ? await db
        .select()
        .from(fundamentals)
        .where(inArray(fundamentals.symbol, [...symbols]))
    : [];
  const bars = await loadDailyBars(
    db,
    symbols,
    today,
    Math.ceil(cfg.prices.historyYears * 366) + 10,
  );
  const cards: StoredScorecard[] = [];
  for (const r of rows) {
    const facts: CompanyFacts | null =
      r.taxonomy && r.currency
        ? {
            taxonomy: r.taxonomy as CompanyFacts['taxonomy'],
            currency: r.currency,
            series: r.series as CompanyFacts['series'],
          }
        : null;
    const history = bars.get(r.symbol) ?? [];
    const sc = facts
      ? buildScorecard(facts, {
          today,
          historyYears: cfg.prices.historyYears,
          closeOnOrBefore: closeLookup(history),
        })
      : null;
    const lastClose = history.at(-1)?.close ?? null;
    const marketCapUsd =
      sc && sc.currency === 'USD' && sc.dilutedShares && lastClose
        ? Math.round(lastClose * sc.dilutedShares)
        : null;
    const q = sc
      ? qualityCheck(sc, cfg.quality, marketCapUsd)
      : {
          pass: false,
          reasons: [`no data: ${r.error ?? 'fundamentals unavailable'}`],
          missing: [],
        };
    if (sc) {
      cards.push({
        symbol: r.symbol,
        scorecard: sc,
        marketCapUsd,
        qualityPass: q.pass,
        qualityReasons: q.reasons,
      });
    }
    await db
      .insert(scorecards)
      .values({
        symbol: r.symbol,
        computedAt: now,
        scorecard: (sc ?? { notes: [r.error ?? 'fundamentals unavailable'] }) as Record<
          string,
          unknown
        >,
        marketCapUsd: marketCapUsd === null ? null : String(marketCapUsd),
        qualityPass: q.pass,
        qualityReasons: q.reasons,
      })
      .onConflictDoUpdate({
        target: scorecards.symbol,
        set: {
          computedAt: sql`excluded.computed_at`,
          scorecard: sql`excluded.scorecard`,
          marketCapUsd: sql`excluded.market_cap_usd`,
          qualityPass: sql`excluded.quality_pass`,
          qualityReasons: sql`excluded.quality_reasons`,
          updatedAt: now,
        },
      });
  }
  const passed = cards.filter((c) => c.qualityPass).length;
  return {
    items: rows.length,
    cards,
    meta: { scored: rows.length, passed, failed: rows.length - passed },
  };
}
