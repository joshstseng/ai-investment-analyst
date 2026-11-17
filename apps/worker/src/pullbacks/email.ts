/**
 * Pullback alert emails (view model): one email per triggered ticker, or one combined email when
 * more than `alerts.maxSeparateEmails` trigger in a run (full blocks for the most severe, a table
 * for the rest). Plus the one-time starting list after the silent baseline.
 */
import {
  bullEvidence,
  exitLevels,
  noiseReason,
  sourceDomain,
  tradingDaysSince,
  valuationNow,
  type PullbackCheck,
  type Scorecard,
} from '@aia/core';
import {
  accounts,
  events,
  fundamentals,
  holdings,
  instruments,
  marketCalendar,
  newsItems,
  type Db,
} from '@aia/db';
import {
  money,
  signedPct,
  type PullbackBlock,
  type PullbackEmailProps,
  type PullbackRow,
} from '@aia/emails';
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import type { AlpacaClient } from '../alpaca/client';
import { log } from '../lib/log';
import { ACCOUNT_LABEL } from '../notify/format';
import type { PullbackResult } from './check';
import type { PullbackConfig } from './config';
import { INTRADAY_LABEL } from './prices';
import { readNasdaq100, readSp500 } from './universe';

export const CHECK_LABEL: Record<PullbackCheck, string> = {
  open: 'Open',
  midday: 'Midday',
  eod: 'Close',
};

export const PULLBACK_LABEL =
  'Story check (cause of drop, guidance, thesis) pending. Intraday moves can reverse by the close. A falling price alone is not an opportunity. Research only, not an order.';

export interface AlertContext {
  names: Map<string, string>;
  /** Lots per (underlying) symbol: "Roth IRA 10 sh". */
  holdingsBy: Map<string, string[]>;
  heldEtfs: string[];
  nextEarnings: Map<
    string,
    { date: string; timeOfDay: string; estimated: boolean; source: string }
  >;
  lastRelease: Map<string, string | null>;
  sessions: string[];
  headlines: Map<string, { headline: string; url: string | null; publishedAt: Date }[]>;
  cfg: PullbackConfig;
}

const pct1 = (n: number) => `${Number(n.toFixed(1))}%`;
const big = (n: number | null, currency = 'USD') => {
  if (n === null) return '—';
  const a = Math.abs(n);
  const s =
    a >= 1e12
      ? `${(a / 1e12).toFixed(2)}T`
      : a >= 1e9
        ? `${(a / 1e9).toFixed(1)}B`
        : `${(a / 1e6).toFixed(0)}M`;
  const sign = n < 0 ? '−' : '';
  return currency === 'USD' ? `${sign}$${s}` : `${sign}${s} ${currency}`;
};
const nyTime = (d: Date) =>
  `${d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })} ET`;
const day = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

/** Most severe first: deepest tier, then the biggest day drop. */
export function bySeverity(a: PullbackResult, b: PullbackResult) {
  return (
    (b.decision.q.tier ?? 0) - (a.decision.q.tier ?? 0) ||
    a.metrics.d1Pct - b.metrics.d1Pct ||
    a.symbol.localeCompare(b.symbol)
  );
}

/** What triggered the alert, in words. */
function triggerText(r: PullbackResult): string {
  const a = r.decision.alert;
  const m = r.metrics;
  const parts = [`${pct1(m.belowHighPct)} below the 52-week high`];
  if (a?.kinds.includes('first')) {
    const why = r.decision.q.reasons.map((x) =>
      x === 'from_high'
        ? '≥20% off the high'
        : x === 'multi_day'
          ? `down ${pct1(-m.worstDropPct)} in ${m.worstDropDays} day${m.worstDropDays > 1 ? 's' : ''}`
          : `down ${pct1(-m.d1Pct)} today`,
    );
    parts.push(`now qualifies (${why.join(', ')})`);
  }
  if (a?.kinds.includes('deeper_tier') && a.tier !== null)
    parts.push(`crossed the −${a.tier}% tier`);
  // Already said when the one-day drop is why it first qualified.
  const firstForDrop = a?.kinds.includes('first') && r.decision.q.reasons.includes('one_day');
  if (a?.kinds.includes('one_day_drop') && !firstForDrop)
    parts.push(`down ${pct1(-m.d1Pct)} today`);
  if (a?.gapDown) parts.push(`gap-down ${pct1(-m.d1Pct)} at the open`);
  return parts.join(' · ');
}

export function pullbackBlock(
  r: PullbackResult,
  check: PullbackCheck,
  ctx: AlertContext,
): PullbackBlock {
  const m = r.metrics;
  const sc: Scorecard | null = r.scorecard && 'revenueTtm' in r.scorecard ? r.scorecard : null;
  const usd = !sc || sc.currency === 'USD';
  const v = valuationNow(usd ? sc : null, m.price);
  const a = r.decision.alert;
  const pills: PullbackBlock['pills'] = [];
  if (a?.kinds.includes('first')) pills.push({ label: 'newly qualifies', tone: 'review' });
  if (a?.kinds.includes('deeper_tier'))
    pills.push({ label: `deeper tier −${a.tier}%`, tone: 'review' });
  if (a?.kinds.includes('one_day_drop')) pills.push({ label: 'one-day drop', tone: 'loss' });
  if (a?.gapDown) pills.push({ label: 'gap-down', tone: 'loss' });
  if (r.qualityPass === false) pills.push({ label: 'quality ✗', tone: 'loss' });
  if (r.sources.includes('holding')) pills.push({ label: 'you hold it', tone: 'navy' });
  else if (r.sources.includes('watchlist')) pills.push({ label: 'watchlist', tone: 'neutral' });

  const facts: PullbackBlock['facts'] = [
    { label: 'Previous close', value: money(m.prevClose) },
    { label: '1-day', value: signedPct(m.d1Pct), tone: m.d1Pct < 0 ? 'loss' : 'gain' },
    { label: '52-week high', value: `${money(m.high52)} (${day(m.high52Date)})` },
    {
      label: '5-day',
      value: m.d5Pct === null ? '—' : signedPct(m.d5Pct),
      tone: (m.d5Pct ?? 0) < 0 ? 'loss' : 'gain',
    },
    { label: '52-week low', value: money(m.low52) },
    { label: 'From high', value: `−${pct1(m.belowHighPct)}`, tone: 'loss' },
    { label: 'Tier', value: r.decision.q.tier === null ? 'above −20%' : `−${r.decision.q.tier}%` },
    ...(r.decision.q.gapDown
      ? [{ label: 'Gap-down', value: signedPct(m.d1Pct), tone: 'loss' as const }]
      : []),
  ];

  const lots = ctx.holdingsBy.get(r.symbol);
  const exposure =
    ctx.heldEtfs.length && (r.sources.includes('nasdaq100') || r.sources.includes('core'))
      ? `You already hold ${ctx.heldEtfs.join(', ')}: ETFs that give you large exposure to mega-cap tech. Check the overlap before adding.`
      : null;

  const earnings: string[] = [];
  const next = ctx.nextEarnings.get(r.symbol);
  earnings.push(
    next
      ? `Next earnings: ${day(next.date)}${next.timeOfDay && next.timeOfDay !== 'unknown' ? ` ${next.timeOfDay.replace('_', ' ')}` : ''} (${next.estimated ? 'estimated' : 'confirmed'}, ${next.source === 'alphavantage' ? 'Alpha Vantage' : next.source})`
      : 'Next earnings: not on the calendar',
  );
  const release = ctx.lastRelease.get(r.symbol) ?? null;
  const since = tradingDaysSince(release, m.asOfDate, ctx.sessions);
  if (release) {
    earnings.push(
      since !== null && since <= ctx.cfg.alerts.earningsWindowTradingDays
        ? `⚠️ The drop is ${since === 0 ? 'on the day of' : `${since} trading day${since > 1 ? 's' : ''} after`} the earnings release filed ${day(release)} (8-K item 2.02).`
        : `Last earnings release: ${day(release)} (8-K item 2.02).`,
    );
  }

  const exits = exitLevels({
    price: m.price,
    low52: m.low52,
    atr14: m.atr14,
    epsTtm: usd ? (sc?.epsTtm ?? null) : null,
    peMedian: usd ? (sc?.peMedian ?? null) : null,
    nextEarnings: next?.date ?? null,
  });
  const cur = sc?.currency ?? 'USD';
  return {
    ticker: r.symbol,
    name: ctx.names.get(r.symbol) ?? null,
    headline: triggerText(r),
    pills,
    price: money(m.price),
    changePct: m.d1Pct,
    priceLine: `${nyTime(r.price.at)} · ${r.price.source === 'alpaca:iex' ? 'Alpaca IEX' : r.price.source === 'twelvedata' ? 'Twelve Data' : 'official close (SIP)'} · ${CHECK_LABEL[check]} check${m.intraday ? ` · ${INTRADAY_LABEL}` : ''}${r.windowStart ? ` · 52-week range measured from the ${day(r.windowStart)} spin-off` : ''}`,
    facts,
    range:
      m.high52 > m.low52
        ? {
            left: `low ${money(m.low52)}`,
            right: `high ${money(m.high52)}`,
            markerPct: ((m.price - m.low52) / (m.high52 - m.low52)) * 100,
          }
        : null,
    holding: lots?.length
      ? `you hold it: ${lots.join(' · ')}`
      : r.sources.includes('watchlist')
        ? 'not held (on your watchlist)'
        : 'not held',
    exposureNote: exposure,
    earnings,
    headlines: (ctx.headlines.get(r.symbol) ?? []).slice(0, 3).map((h) => ({
      title: h.headline,
      href: h.url ?? undefined,
      source: sourceDomain(h.url) ?? 'Benzinga',
      day: h.publishedAt.toLocaleDateString('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }),
      tickers: [],
    })),
    quality: { pass: r.qualityPass, reasons: r.qualityReasons },
    scorecard: sc
      ? [
          {
            label: 'Revenue TTM',
            value: `${big(sc.revenueTtm, cur)}${sc.revenueYoYPct === null ? '' : ` (${signedPct(sc.revenueYoYPct)} y/y)`}`,
          },
          {
            label: '3-yr CAGR',
            value: sc.revenueCagr3yPct === null ? '—' : pct1(sc.revenueCagr3yPct),
          },
          {
            label: 'Gross margin',
            value: sc.grossMarginPct === null ? '—' : pct1(sc.grossMarginPct),
          },
          {
            label: 'Operating margin',
            value: sc.operatingMarginPct === null ? '—' : pct1(sc.operatingMarginPct),
          },
          { label: 'Net margin', value: sc.netMarginPct === null ? '—' : pct1(sc.netMarginPct) },
          {
            label: 'FCF TTM',
            value: `${big(sc.fcfTtm, cur)}${sc.fcfMarginPct === null ? '' : ` (${pct1(sc.fcfMarginPct)} margin)`}`,
          },
          {
            label: sc.netCash !== null && sc.netCash < 0 ? 'Net debt' : 'Net cash',
            value: big(sc.netCash === null ? null : Math.abs(sc.netCash), cur),
          },
          {
            label: 'Diluted shares',
            value: sc.dilutionYoYPct === null ? '—' : `${signedPct(sc.dilutionYoYPct)} y/y`,
          },
          {
            label: 'P/E',
            value:
              v.pe === null
                ? '—'
                : `${v.pe}${sc.peMedian === null ? '' : ` vs ${ctx.cfg.prices.historyYears}-yr median ${sc.peMedian}`}`,
          },
          {
            label: 'P/FCF',
            value:
              v.pfcf === null
                ? '—'
                : `${v.pfcf}${sc.pfcfMedian === null ? '' : ` vs median ${sc.pfcfMedian}`}`,
          },
        ]
      : [],
    scorecardNotes: sc?.notes ?? (r.qualityPass === null ? ['no fundamentals'] : []),
    bull: bullEvidence(usd ? sc : null, v, ctx.cfg.prices.historyYears),
    exits: [
      { label: 'Risk stop', value: money(exits.riskStop.value), basis: exits.riskStop.basis },
      exits.valuationTrim
        ? {
            label: 'Valuation trim',
            value: money(exits.valuationTrim.value),
            basis: exits.valuationTrim.basis,
          }
        : {
            label: 'Valuation trim',
            value: '—',
            basis: usd ? 'no positive TTM EPS or P/E history' : `reported in ${cur}`,
          },
      exits.reUnderwrite
        ? {
            label: 'Re-underwrite',
            value: day(exits.reUnderwrite.date),
            basis: exits.reUnderwrite.basis,
          }
        : { label: 'Re-underwrite', value: '—', basis: 'next earnings date not on the calendar' },
    ],
  };
}

/** "Numbers check: passed. …" — or which names failed (holdings/watchlist are always checked). */
export function labelFor(rs: readonly PullbackResult[]): string {
  const failed = rs.filter((r) => r.qualityPass !== true).map((r) => r.symbol);
  const head =
    failed.length === 0
      ? 'Numbers check: passed.'
      : failed.length === rs.length
        ? 'Numbers check: failed.'
        : `Numbers check: passed, except ${failed.join(', ')} (quality failed or no data).`;
  return `${head} ${PULLBACK_LABEL}`;
}

/** Subject for one ticker: pullback, or gap-down at the open. */
export function pullbackSubject(r: PullbackResult, check: PullbackCheck): string {
  const m = r.metrics;
  if (r.decision.alert?.gapDown) {
    return `📝 [AIA] REVIEW Gap-down – ${r.symbol} −${pct1(-m.d1Pct)} at open (−${pct1(m.belowHighPct)} from high)`;
  }
  return `📝 [AIA] REVIEW Pullback opportunity – ${r.symbol} (−${pct1(m.belowHighPct)} from high, ${CHECK_LABEL[check]})`;
}

export function pullbackRow(r: PullbackResult, note: string): PullbackRow {
  return {
    ticker: r.symbol,
    tier: r.decision.q.tier === null ? '—' : `−${r.decision.q.tier}%`,
    belowHigh: pct1(r.metrics.belowHighPct),
    d1Pct: r.metrics.d1Pct,
    note,
    quality: r.qualityPass === null ? 'n/a' : r.qualityPass ? 'pass' : 'fail',
  };
}

const footer = (check: PullbackCheck, date: string) => [
  `Pullback screen · ${CHECK_LABEL[check]} check · ${day(date)} · prices: Alpaca (IEX intraday, SIP closes), Twelve Data fallback · fundamentals: SEC EDGAR`,
];

/** The alert emails for a run: one per ticker, or one combined when more than the limit. */
export function pullbackEmails(
  alerted: readonly PullbackResult[],
  check: PullbackCheck,
  date: string,
  ctx: AlertContext,
): { dedupeKey: string; props: PullbackEmailProps }[] {
  const sorted = [...alerted].sort(bySeverity);
  const max = ctx.cfg.alerts.maxSeparateEmails;
  const preview = (r: PullbackResult) => {
    const v = valuationNow(r.scorecard, r.metrics.price);
    return [
      `−${pct1(r.metrics.belowHighPct)} from high`,
      r.decision.q.tier === null ? null : `tier −${r.decision.q.tier}%`,
      `day ${signedPct(r.metrics.d1Pct)}`,
      v.pe !== null && r.scorecard?.peMedian
        ? `P/E ${Math.round(v.pe)} vs median ${Math.round(r.scorecard.peMedian)}`
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
  };
  if (sorted.length <= max) {
    return sorted.map((r) => ({
      dedupeKey: `pullback:${date}:${check}:${r.symbol}`,
      props: {
        subject: pullbackSubject(r, check),
        preview: preview(r),
        title: r.symbol,
        subtitle: `${CHECK_LABEL[check]} check · ${day(date)}`,
        blocks: [pullbackBlock(r, check, ctx)],
        table: null,
        label: labelFor([r]),
        footer: footer(check, date),
      },
    }));
  }
  const head = sorted.slice(0, max);
  const rest = sorted.slice(max);
  return [
    {
      dedupeKey: `pullback:${date}:${check}:combined`,
      props: {
        subject: `📝 [AIA] REVIEW Pullback opportunities – ${sorted.length} names (${CHECK_LABEL[check]}): ${sorted
          .slice(0, 4)
          .map((r) => r.symbol)
          .join(', ')}${sorted.length > 4 ? ', …' : ''}`,
        preview: sorted
          .slice(0, 4)
          .map((r) => `${r.symbol} −${pct1(r.metrics.belowHighPct)}`)
          .join(' · '),
        title: `${sorted.length} pullbacks`,
        subtitle: `${CHECK_LABEL[check]} check · ${day(date)} · most severe first`,
        blocks: head.map((r) => pullbackBlock(r, check, ctx)),
        table: {
          title: `Also triggered (${rest.length})`,
          rows: rest.map((r) => pullbackRow(r, triggerText(r))),
        },
        label: labelFor(sorted),
        footer: footer(check, date),
      },
    },
  ];
}

/** One email after the silent baseline: everything that qualifies today, compact. */
export function startingListEmail(
  results: readonly PullbackResult[],
  date: string,
): { dedupeKey: string; props: PullbackEmailProps } {
  const q = results.filter((r) => r.decision.q.qualifies).sort(bySeverity);
  return {
    dedupeKey: `pullback:${date}:baseline`,
    props: {
      subject: `📝 [AIA] REVIEW Pullback screen – starting list: ${q.length} names`,
      preview: `${q.length} names qualify at the ${day(date)} close; alerts start with the next check`,
      title: 'Pullback screen: starting list',
      subtitle: `Close of ${day(date)} · ${q.length} names qualify · from now on you get an email when a name first qualifies, reaches a deeper tier or drops 7%+ in a day`,
      blocks: [],
      table: {
        title: 'Currently qualifying (most severe first)',
        rows: q.map((r) =>
          pullbackRow(
            r,
            r.decision.q.reasons
              .map((x) =>
                x === 'from_high'
                  ? '≥20% off high'
                  : x === 'multi_day'
                    ? `−${pct1(-r.metrics.worstDropPct)} in ${r.metrics.worstDropDays}d`
                    : `−${pct1(-r.metrics.d1Pct)} today`,
              )
              .join(', '),
          ),
        ),
      },
      label: labelFor(q),
      footer: footer('eod', date),
    },
  };
}

// ---- Context loading ----------------------------------------------------------------------------

export async function loadAlertContext(
  db: Db,
  alpaca: AlpacaClient,
  symbols: readonly string[],
  date: string,
  cfg: PullbackConfig,
): Promise<AlertContext> {
  const list = [...symbols];
  const names = new Map<string, string>();
  for (const r of readNasdaq100()) names.set(r.symbol, r.name);
  for (const r of readSp500()) names.set(r.symbol, r.name);

  const lotRows = await db
    .select({
      symbol: instruments.symbol,
      type: instruments.instrumentType,
      underlying: instruments.underlyingSymbol,
      name: instruments.name,
      account: accounts.accountType,
      quantity: holdings.quantity,
    })
    .from(holdings)
    .innerJoin(instruments, eq(holdings.instrumentId, instruments.id))
    .innerJoin(accounts, eq(holdings.accountId, accounts.id))
    .where(ne(holdings.status, 'closed'));
  const holdingsBy = new Map<string, string[]>();
  for (const l of lotRows) {
    const key = l.type === 'option' ? l.underlying : l.symbol;
    if (!key) continue;
    const what = l.type === 'option' ? (l.name ?? l.symbol) : `${Number(l.quantity)} sh`;
    holdingsBy.set(key, [
      ...(holdingsBy.get(key) ?? []),
      `${ACCOUNT_LABEL[l.account] ?? l.account} ${what}`,
    ]);
  }
  const heldEtfs = [
    ...new Set(lotRows.filter((l) => l.type === 'etf').map((l) => l.symbol)),
  ].sort();

  const nextEarnings = new Map<
    string,
    { date: string; timeOfDay: string; estimated: boolean; source: string }
  >();
  if (list.length) {
    const rows = await db
      .select({
        ticker: events.ticker,
        date: events.date,
        timeOfDay: events.timeOfDay,
        estimated: events.estimated,
        source: events.source,
      })
      .from(events)
      .where(
        and(
          inArray(events.ticker, list),
          eq(events.eventType, 'earnings'),
          eq(events.status, 'active'),
          gte(events.date, date),
        ),
      )
      .orderBy(asc(events.date));
    for (const r of rows) if (!nextEarnings.has(r.ticker)) nextEarnings.set(r.ticker, r);
  }

  const lastRelease = new Map(
    (list.length
      ? await db
          .select({ symbol: fundamentals.symbol, d: fundamentals.lastEarningsRelease })
          .from(fundamentals)
          .where(inArray(fundamentals.symbol, list))
      : []
    ).map((r) => [r.symbol, r.d] as const),
  );
  const sessions = (
    await db
      .select({ date: marketCalendar.date })
      .from(marketCalendar)
      .where(
        and(
          gte(
            marketCalendar.date,
            new Date(Date.parse(date) - 30 * 86_400_000).toISOString().slice(0, 10),
          ),
          lte(marketCalendar.date, date),
        ),
      )
      .orderBy(asc(marketCalendar.date))
  ).map((r) => r.date);

  // Headlines: stored news first; names outside the news universe are fetched now (3 days).
  const headlines = new Map<
    string,
    { headline: string; url: string | null; publishedAt: Date }[]
  >();
  if (list.length) {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const rows = await db
      .select({
        headline: newsItems.headline,
        url: newsItems.url,
        publishedAt: newsItems.publishedAt,
        symbols: newsItems.symbols,
      })
      .from(newsItems)
      .where(
        and(
          gte(newsItems.publishedAt, since),
          sql`${newsItems.symbols} && ${sql`ARRAY[${sql.join(
            list.map((s) => sql`${s}`),
            sql`, `,
          )}]::text[]`}`,
        ),
      )
      .orderBy(desc(newsItems.publishedAt))
      .limit(500);
    for (const r of rows) {
      if (noiseReason(r)) continue; // roundups and chatter: same filter as the digest
      for (const s of r.symbols) {
        if (!list.includes(s)) continue;
        const xs = headlines.get(s) ?? [];
        if (xs.length < 3) xs.push(r);
        headlines.set(s, xs);
      }
    }
    const missing = list.filter((s) => !headlines.has(s));
    if (missing.length) {
      try {
        const news = await alpaca.news({
          symbols: missing,
          start: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        });
        for (const n of news.reverse()) {
          if (noiseReason(n)) continue;
          for (const s of n.symbols) {
            if (!missing.includes(s)) continue;
            const xs = headlines.get(s) ?? [];
            if (xs.length < 3)
              xs.push({
                headline: n.headline,
                url: n.url ?? null,
                publishedAt: new Date(n.created_at),
              });
            headlines.set(s, xs);
          }
        }
      } catch (error) {
        log.warn('pullback headlines fetch failed', { error: String(error) });
      }
    }
  }
  return { names, holdingsBy, heldEtfs, nextEarnings, lastRelease, sessions, headlines, cfg };
}
