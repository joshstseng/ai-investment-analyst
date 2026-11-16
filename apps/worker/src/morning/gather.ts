/** Gathers everything the morning email shows. Rendering is separate and pure (render.ts). */
import { addDays, describeFiling, laDate, weekStart, type LevelToWatch } from '@aia/core';
import {
  alerts,
  alertStates,
  econEvents,
  events,
  exitRules,
  feedStatus,
  filings,
  holdings,
  instruments,
  jobRuns,
  marketCalendar,
  newsItems,
  pricesDaily,
  ruleEvaluations,
  watchlist,
  type Db,
} from '@aia/db';
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, ne } from 'drizzle-orm';
import type { AlpacaClient } from '../alpaca/client';
import { ECON_JOB } from '../events/econ-calendar';
import { EARNINGS_FEED } from '../events/alphavantage';
import { BENCHMARKS } from '../market/universe';
import type { CalSession } from '../schedule/market';
import { summarizeTrades, type Form4Summary, type TradeSummary } from '../sec/form4';
import { loadLevels } from './levels';
import { fetchPremarket, type PremarketQuote } from './premarket';
import { morningWindow, type MorningWindow } from './window';

export interface MorningData {
  window: MorningWindow;
  generatedAt: Date;
  alerts: { subject: string; createdAt: Date; sent: boolean }[];
  econ: {
    available: boolean;
    items: {
      at: Date;
      allDay: boolean;
      impact: string;
      title: string;
      forecast: string | null;
      previous: string | null;
      actual: string | null;
    }[];
  };
  filings: {
    ticker: string;
    held: boolean;
    items: { form: string; label: string; dilution: boolean; filedAt: Date; url: string }[];
    insiderTrades: (TradeSummary & { url: string })[];
    otherInsiderFilings: number;
    /** Other Form 4 activity across the window, by transaction code (e.g. { A: 4, F: 2 }). */
    otherCodes: Record<string, number>;
  }[];
  headlines: {
    ticker: string;
    held: boolean;
    items: {
      headline: string;
      source: string;
      url: string | null;
      publishedAt: Date;
      /** Other followed tickers the headline mentions (it is listed only once). */
      also: string[];
    }[];
    more: number;
  }[];
  premarket: {
    available: boolean;
    feed: string | null;
    asOf: Date | null;
    quotes: PremarketQuote[];
    note: string | null;
  };
  levels: LevelToWatch[];
  active: {
    display: string;
    level: string;
    status: string;
    firstFiredOn: string;
    daysActive: number;
    message: string;
  }[];
  upcoming: {
    available: { earnings: boolean; lastFetched: string | null };
    items: {
      date: string;
      ticker: string;
      eventType: string;
      title: string;
      timeOfDay: string;
      estimated: boolean;
      confirmed: boolean;
      source: string;
      previousDate: string | null;
      note: string | null;
    }[];
  };
  lastWeek: { symbol: string; held: boolean; changePct: number | null }[] | null;
  pastWeekAlerts: { subject: string; createdAt: Date }[] | null;
  health: { ok: number; issues: { feed: string; status: string; detail: string | null }[] };
}

const HEADLINES = { normal: 5, recap: 8 };
const UPCOMING_DAYS = 7;
const RECAP_EARNINGS_DAYS = 21;

function sourceName(source: string): string {
  const s = source.replace(/^alpaca:/, '');
  return s === 'benzinga' ? 'Benzinga' : s;
}

export async function gatherMorning(
  db: Db,
  alpaca: AlpacaClient | null,
  now = new Date(),
): Promise<MorningData> {
  const calRows = await db
    .select()
    .from(marketCalendar)
    .where(
      and(
        gte(marketCalendar.date, addDays(laDate(now), -40)),
        lte(marketCalendar.date, addDays(laDate(now), 21)),
      ),
    )
    .orderBy(asc(marketCalendar.date));
  const sessions: CalSession[] = calRows.map((r) => ({
    date: r.date,
    openAt: r.openAt,
    closeAt: r.closeAt,
    earlyClose: r.earlyClose,
  }));
  const w = morningWindow(sessions, now);
  const today = w.today;

  // Holdings and watchlist (display names, held vs watched).
  const held = await db
    .selectDistinct({
      id: instruments.id,
      symbol: instruments.symbol,
      type: instruments.instrumentType,
      underlying: instruments.underlyingSymbol,
      name: instruments.name,
    })
    .from(holdings)
    .innerJoin(instruments, eq(holdings.instrumentId, instruments.id))
    .where(ne(holdings.status, 'closed'));
  const watched = await db
    .select({ symbol: instruments.symbol })
    .from(watchlist)
    .innerJoin(instruments, eq(watchlist.instrumentId, instruments.id));
  const heldTickers = new Set(held.map((h) => h.underlying ?? h.symbol));
  const followed = [...new Set([...heldTickers, ...watched.map((x) => x.symbol)])];
  const order = (a: string, b: string) =>
    Number(heldTickers.has(b)) - Number(heldTickers.has(a)) || a.localeCompare(b);

  // 2. Alerts sent (or queued) in the window.
  const alertRows = await db
    .select({ subject: alerts.subject, createdAt: alerts.createdAt, sentAt: alerts.sentAt })
    .from(alerts)
    .where(
      and(eq(alerts.kind, 'rule'), gte(alerts.createdAt, w.start), lte(alerts.createdAt, w.end)),
    )
    .orderBy(asc(alerts.createdAt));

  // 3. Economic calendar: today (recap: the week), only if today's fetch succeeded.
  const econRuns = await db
    .select({ startedAt: jobRuns.startedAt })
    .from(jobRuns)
    .where(
      and(
        eq(jobRuns.job, ECON_JOB),
        eq(jobRuns.status, 'success'),
        gte(jobRuns.startedAt, new Date(now.getTime() - 36 * 3_600_000)),
      ),
    );
  const econAvailable = econRuns.some((r) => laDate(r.startedAt) === laDate(now));
  const econDays = w.recap ? 7 : 1;
  // Select generously in UTC, then keep the Pacific calendar days we want (DST-safe).
  const econRows = econAvailable
    ? (
        await db
          .select()
          .from(econEvents)
          .where(
            and(
              gte(econEvents.at, new Date(now.getTime() - 86_400_000)),
              lt(econEvents.at, new Date(now.getTime() + (econDays + 1) * 86_400_000)),
            ),
          )
      ).filter((e) => {
        const d = laDate(e.at);
        return d >= laDate(now) && d < addDays(laDate(now), econDays);
      })
    : [];

  // 4. Filings in the window, by ticker.
  const filingRows = followed.length
    ? await db
        .select()
        .from(filings)
        .where(
          and(
            inArray(filings.ticker, followed),
            gt(filings.filedAt, w.start),
            lte(filings.filedAt, w.end),
          ),
        )
        .orderBy(desc(filings.filedAt))
    : [];
  const filingGroups = [...new Set(filingRows.map((f) => f.ticker!))].sort(order).map((ticker) => {
    const rows = filingRows.filter((f) => f.ticker === ticker);
    const form4s = rows.filter((f) => f.form === '4' || f.form === '4/A');
    const insiderTrades = form4s.flatMap((f) => {
      const s = (f.details as { form4?: Form4Summary } | null)?.form4;
      return s ? summarizeTrades(s.trades).map((t) => ({ ...t, url: f.url })) : [];
    });
    const withTrades = new Set(insiderTrades.map((t) => t.url));
    return {
      ticker,
      held: heldTickers.has(ticker),
      items: rows
        .filter((f) => f.form !== '4' && f.form !== '4/A')
        .map((f) => ({
          form: f.form,
          ...describeFiling(f.form, f.items),
          filedAt: f.filedAt,
          url: f.url,
        })),
      insiderTrades,
      otherInsiderFilings: form4s.filter((f) => !withTrades.has(f.url)).length,
      otherCodes: form4s.reduce<Record<string, number>>((acc, f) => {
        const counts = (f.details as { form4?: Form4Summary } | null)?.form4?.otherCounts ?? {};
        for (const [code, n] of Object.entries(counts)) acc[code] = (acc[code] ?? 0) + n;
        return acc;
      }, {}),
    };
  });

  // 5. Headlines in the window, newest first, per ticker.
  const perTicker = w.recap ? HEADLINES.recap : HEADLINES.normal;
  const newsRows = await db
    .select({
      headline: newsItems.headline,
      url: newsItems.url,
      source: newsItems.source,
      publishedAt: newsItems.publishedAt,
      symbols: newsItems.symbols,
    })
    .from(newsItems)
    .where(and(gt(newsItems.publishedAt, w.start), lte(newsItems.publishedAt, w.end)))
    .orderBy(desc(newsItems.publishedAt));
  // Each headline appears once, under the first followed ticker it mentions (holdings first),
  // with the other followed tickers noted; market roundups would otherwise repeat everywhere.
  const followedSet = new Set(followed);
  const seen = new Set<string>();
  const headlines: MorningData['headlines'] = [];
  for (const ticker of [...followed].sort(order)) {
    const fresh = newsRows.filter(
      (n) => n.symbols.includes(ticker) && !seen.has(n.url ?? n.headline),
    );
    if (!fresh.length) continue;
    const shown = fresh.slice(0, perTicker);
    for (const n of shown) seen.add(n.url ?? n.headline);
    headlines.push({
      ticker,
      held: heldTickers.has(ticker),
      items: shown.map((n) => ({
        headline: n.headline,
        source: sourceName(n.source),
        url: n.url,
        publishedAt: n.publishedAt,
        also: n.symbols.filter((x) => x !== ticker && followedSet.has(x)),
      })),
      more: fresh.length - shown.length,
    });
  }

  // 6. Pre-market (SPY, QQQ and holdings) — only on trading days.
  const lastSession = w.prev?.date ?? today;
  const pmSymbols = [...new Set([...BENCHMARKS, ...[...heldTickers].sort()])];
  const lastCloses = new Map<string, number>();
  const closeRows = await db
    .select({ symbol: pricesDaily.symbol, date: pricesDaily.date, close: pricesDaily.close })
    .from(pricesDaily)
    .where(
      and(
        inArray(pricesDaily.symbol, pmSymbols),
        gte(pricesDaily.date, addDays(lastSession, -21)),
        lte(pricesDaily.date, lastSession),
      ),
    )
    .orderBy(asc(pricesDaily.date));
  for (const r of closeRows) lastCloses.set(r.symbol, Number(r.close));
  let premarket: MorningData['premarket'] = {
    available: false,
    feed: null,
    asOf: null,
    quotes: [],
    note: null,
  };
  const todayRow = calRows.find((r) => r.date === today);
  if (w.session && todayRow?.sessionOpenAt && alpaca) {
    try {
      const pm = await fetchPremarket(alpaca, {
        symbols: pmSymbols,
        lastCloses,
        sessionOpenAt: todayRow.sessionOpenAt,
        openAt: todayRow.openAt,
        now,
      });
      premarket = {
        available: true,
        feed: pm.feed,
        asOf: pm.asOf,
        quotes: pm.quotes,
        note: pm.feed === 'iex' ? 'IEX only (SIP refused): sparse before the open' : null,
      };
    } catch (error) {
      premarket = {
        available: false,
        feed: null,
        asOf: null,
        quotes: pmSymbols.map((s) => ({
          symbol: s,
          lastClose: lastCloses.get(s) ?? null,
          price: null,
          at: null,
          changePct: null,
          volume: 0,
          feed: null,
        })),
        note: `pre-market unavailable (${String(error).slice(0, 80)})`,
      };
    }
  }

  // 7. Levels to watch (from the last completed session's close).
  const levels = w.prev ? await loadLevels(db, w.prev.date) : [];

  // 8. Still-active conditions, with trading days active.
  const activeRows = await db
    .select({
      ruleId: alertStates.exitRuleId,
      level: alertStates.level,
      firstFiredOn: alertStates.firstFiredOn,
      status: exitRules.status,
      symbol: instruments.symbol,
      name: instruments.name,
      type: instruments.instrumentType,
    })
    .from(alertStates)
    .innerJoin(exitRules, eq(alertStates.exitRuleId, exitRules.id))
    .innerJoin(instruments, eq(exitRules.instrumentId, instruments.id))
    .where(eq(alertStates.active, true))
    .orderBy(asc(alertStates.firstFiredOn));
  const latestMessages = new Map<number, string>();
  for (const a of activeRows) {
    const [ev] = await db
      .select({ message: ruleEvaluations.message })
      .from(ruleEvaluations)
      .where(eq(ruleEvaluations.exitRuleId, a.ruleId))
      .orderBy(desc(ruleEvaluations.asOfDate))
      .limit(1);
    if (ev?.message) latestMessages.set(a.ruleId, ev.message);
  }
  const sessionDates = sessions.map((s) => s.date);
  const active = activeRows.map((a) => ({
    display: a.type === 'option' && a.name ? a.name : a.symbol,
    level: a.level,
    status: a.status,
    firstFiredOn: a.firstFiredOn,
    daysActive: sessionDates.filter((d) => d >= a.firstFiredOn && d <= lastSession).length || 1,
    message: latestMessages.get(a.ruleId) ?? '',
  }));

  // 9. Upcoming events.
  const horizon = addDays(today, w.recap ? 7 : UPCOMING_DAYS);
  const earningsHorizon = w.recap ? addDays(today, RECAP_EARNINGS_DAYS) : horizon;
  const eventRows = await db
    .select()
    .from(events)
    .where(
      and(eq(events.status, 'active'), gte(events.date, today), lt(events.date, earningsHorizon)),
    )
    .orderBy(asc(events.date), asc(events.ticker));
  const [avStatus] = await db.select().from(feedStatus).where(eq(feedStatus.feed, EARNINGS_FEED));
  const avMeta = (avStatus?.meta ?? {}) as { lastSuccess?: string | null };
  const upcoming: MorningData['upcoming'] = {
    available: {
      earnings: !!avMeta.lastSuccess && avMeta.lastSuccess === laDate(now),
      lastFetched: avMeta.lastSuccess ?? null,
    },
    items: eventRows
      .filter((e) => e.date < horizon || e.eventType === 'earnings')
      .map((e) => ({
        date: e.date,
        ticker: e.ticker,
        eventType: e.eventType,
        title: e.title,
        timeOfDay: e.timeOfDay,
        estimated: e.estimated,
        confirmed: e.confirmed,
        source: e.source,
        previousDate: e.previousDate,
        note: e.autoNote,
      })),
  };

  // 10. Recap only: last week's % change and alerts.
  let lastWeek: MorningData['lastWeek'] = null;
  let pastWeekAlerts: MorningData['pastWeekAlerts'] = null;
  if (w.recap && w.prev) {
    const endOfLastWeek = w.prev.date;
    // The last session before last week's Monday (normally the Friday before).
    const before = sessions.filter((s) => s.date < weekStart(endOfLastWeek)).at(-1);
    const closeOn = (sym: string, date: string | undefined) => {
      if (!date) return null;
      const r = closeRows.filter((c) => c.symbol === sym && c.date <= date).at(-1);
      return r ? Number(r.close) : null;
    };
    lastWeek = pmSymbols.map((symbol) => {
      const a = closeOn(symbol, before?.date);
      const b = closeOn(symbol, endOfLastWeek);
      return {
        symbol,
        held: heldTickers.has(symbol),
        changePct: a && b ? Math.round(((b - a) / a) * 1000) / 10 : null,
      };
    });
    pastWeekAlerts = await db
      .select({ subject: alerts.subject, createdAt: alerts.createdAt })
      .from(alerts)
      .where(
        and(
          eq(alerts.kind, 'rule'),
          gte(alerts.createdAt, new Date(now.getTime() - 7 * 86_400_000)),
        ),
      )
      .orderBy(asc(alerts.createdAt));
  }

  // 11. Feed health.
  const feeds = (await db.select().from(feedStatus)).filter((f) => !f.feed.includes(':'));
  const issues = feeds
    .filter((f) => f.status === 'degraded' || f.status === 'down')
    .map((f) => ({ feed: f.feed, status: f.status, detail: f.detail }));

  return {
    window: w,
    generatedAt: now,
    alerts: alertRows.map((a) => ({
      subject: a.subject,
      createdAt: a.createdAt,
      sent: !!a.sentAt,
    })),
    econ: {
      available: econAvailable,
      items: econRows.map((e) => ({
        at: e.at,
        allDay: e.allDay,
        impact: e.impact,
        title: e.title,
        forecast: e.forecast,
        previous: e.previous,
        actual: e.actual,
      })),
    },
    filings: filingGroups,
    headlines,
    premarket,
    levels,
    active,
    upcoming,
    lastWeek,
    pastWeekAlerts,
    health: { ok: feeds.length - issues.length, issues },
  };
}
