/**
 * Morning email view model (pure): MorningData → MorningEmailProps (subject, inbox preview, header
 * with today's session, KPI tiles, then the sections in their fixed order). Empty sections are
 * skipped, except alerts ("None."). Times are shown in Pacific time. Rendering is in @aia/emails.
 */
import { addDays, filingTitle, FORM4_CODES } from '@aia/core';
import {
  money,
  renderMorningEmail,
  signedPct,
  type FilingItem,
  type KpiTile,
  type MorningEmailProps,
  type PillTone,
  type Severity,
} from '@aia/emails';
import { headlinesProps, levelPhrase, tradeLine } from '../notify/digest-email';
import type { MorningData } from './gather';

const TZ = 'America/Los_Angeles';
const time = (d: Date) =>
  d.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const dayTime = (d: Date) =>
  `${d.toLocaleString('en-US', { timeZone: TZ, weekday: 'short' })} ${time(d)}`;
const dayOfDate = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
const shortDay = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
  });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const price = (n: number | null) => (n === null ? '—' : money(n, n < 1 ? 4 : 2));

const TIME_OF_DAY: Record<string, string> = {
  before_open: 'before open',
  after_close: 'after close',
  during_market: 'during market',
  unknown: '',
};
const EVENT_LABEL: Record<string, string> = {
  earnings: 'earnings',
  dividend: 'dividend',
  split: 'split',
  lockup_expiry: 'lockup expiry',
  option_expiry: 'option expiry',
  guidance: 'guidance',
  reminder: 'reminder',
  other: 'event',
};
/** Source pills on upcoming events. */
const SOURCE_PILL: Record<string, { label: string; tone: PillTone }> = {
  seed: { label: 'manual', tone: 'neutral' },
  alphavantage: { label: 'alphavantage', tone: 'gain' },
  alpaca: { label: 'alpaca', tone: 'gain' },
  rule: { label: 'rule', tone: 'neutral' },
  derived: { label: 'derived', tone: 'neutral' },
  ai_extracted: { label: 'ai', tone: 'escalated' },
};
const FEED_LABEL: Record<string, string> = {
  alpaca_news_stream: 'news stream',
  alpaca_quotes: 'quotes',
  alpaca_bars: 'daily bars',
  sec_edgar: 'EDGAR',
  scheduler: 'scheduler',
  alphavantage_calendar: 'earnings calendar',
};
const TAG_SEVERITY: Record<string, Severity> = {
  ACTION: 'action',
  WARNING: 'warning',
  REVIEW: 'review',
  REMINDER: 'reminder',
};

const filingCount = (d: MorningData) =>
  d.filings.reduce(
    (a, f) => a + f.items.length + f.insiderTrades.length + f.otherInsiderFilings,
    0,
  );

/** Earnings on the calendar from today through the next 6 days. */
const earningsThisWeek = (d: MorningData) =>
  d.upcoming.items.filter(
    (e) =>
      e.eventType === 'earnings' && e.date >= d.window.today && e.date < addDays(d.window.today, 7),
  );

/**
 * "☀️ [AIA] MORNING Tue, Nov 17 · 2 alerts · 3 filings · 1 level";
 * recap "🗓️ [AIA] MORNING Mon, Nov 23 · weekend recap + week ahead"; holiday "· market closed".
 */
export function morningSubject(d: MorningData): string {
  const day = dayOfDate(d.window.today);
  if (d.window.closed) return `☀️ [AIA] MORNING ${day} · market closed`;
  if (d.window.recap) return `🗓️ [AIA] MORNING ${day} · weekend recap + week ahead`;
  return `☀️ [AIA] MORNING ${day} · ${plural(d.alerts.length, 'alert')} · ${plural(filingCount(d), 'filing')} · ${plural(d.levels.length, 'level')}`;
}

/** Inbox preview: alerts, the first high-impact release, today's earnings, the nearest level. */
export function morningPreviewText(d: MorningData): string {
  const w = d.window;
  if (w.closed) {
    return `Market closed${w.next ? ` · next session ${dayOfDate(w.next.date)}` : ''}`;
  }
  const parts: string[] = [];
  if (d.alerts.length) parts.push(`${plural(d.alerts.length, 'alert')} overnight`);
  const high = d.econ.items
    .filter((e) => e.impact === 'High' && !e.allDay && e.at >= d.generatedAt)
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  if (high && !w.recap) parts.push(`${high.title} ${time(high.at)}`);
  const todayEarnings = d.upcoming.items.filter(
    (e) => e.eventType === 'earnings' && e.date === w.today,
  );
  for (const e of todayEarnings.slice(0, 2)) {
    parts.push(
      `${e.ticker} earnings${TIME_OF_DAY[e.timeOfDay] ? ` ${TIME_OF_DAY[e.timeOfDay]}` : ''}`,
    );
  }
  const lvl = d.levels[0];
  if (lvl && parts.length < 4) {
    parts.push(
      `${lvl.display} ${lvl.distancePct.toFixed(1)}% ${lvl.direction === 'down' ? 'above' : 'below'} ${lvl.kind === 'drawdown_tier' ? lvl.label.replace(' drawdown tier', ' tier') : lvl.label}`,
    );
  }
  if (w.recap) parts.unshift('Weekend recap + week ahead');
  return parts.slice(0, 4).join(' · ') || 'Quiet morning: no alerts, filings or levels to watch';
}

function kpis(d: MorningData): KpiTile[] {
  const earnings = earningsThisWeek(d);
  const earnings8k = d.filings
    .flatMap((g) => g.items)
    .filter((f) => filingTitle(f.form, f.items).earnings).length;
  return [
    {
      label: d.window.recap ? 'Alerts since Fri' : 'Overnight alerts',
      value: String(d.alerts.length),
      sub: d.alerts.length
        ? d.alerts.some((a) => !a.sent)
          ? 'some not yet emailed'
          : 'all emailed'
        : 'none',
    },
    {
      label: 'Filings',
      value: String(filingCount(d)),
      sub: earnings8k ? `${earnings8k} earnings 8-K` : 'since the close',
    },
    { label: 'Levels', value: String(d.levels.length), sub: 'to watch' },
    {
      label: 'Earnings',
      value: String(earnings.length),
      sub: earnings.length
        ? earnings
            .slice(0, 2)
            .map((e) => `${e.ticker} ${shortDay(e.date).split(',')[0]}`)
            .join(', ')
        : 'this week',
    },
  ];
}

function filingItems(d: MorningData): FilingItem[] {
  const out: FilingItem[] = [];
  for (const g of d.filings) {
    const wl = g.held ? '' : ' · watchlist';
    for (const f of g.items) {
      const t = filingTitle(f.form, f.items);
      out.push({
        tickers: [g.ticker],
        title: t.title,
        href: f.url,
        strong: t.notable || t.dilution,
        detail:
          [t.itemsNote ? `(${t.itemsNote})` : null, dayTime(f.filedAt)]
            .filter(Boolean)
            .join(' · ') + wl,
      });
    }
    for (const tr of g.insiderTrades) {
      out.push({
        tickers: [g.ticker],
        title: `Form 4 · open-market ${tr.code === 'P' ? 'buy' : 'sale'}`,
        href: tr.url,
        strong: true,
        detail: wl ? wl.slice(3) : undefined,
        lines: [tradeLine(tr)],
      });
    }
    const activity = Object.entries(g.otherCodes)
      .sort((x, y) => y[1] - x[1])
      .map(([code, n]) => `${FORM4_CODES[code] ?? `code ${code}`} ×${n}`)
      .join(', ');
    if (g.otherInsiderFilings) {
      out.push({
        tickers: [g.ticker],
        title: `Form 4 · ${plural(g.otherInsiderFilings, 'insider filing')}, no open-market buys/sells`,
        detail: (activity ? `(${activity})` : '') + wl || undefined,
      });
    }
  }
  return out;
}

export function morningEmailProps(d: MorningData): MorningEmailProps {
  const w = d.window;
  const day = dayOfDate(w.today);
  const subtitle = w.closed
    ? `${day} · market closed${w.next ? ` · next session ${dayOfDate(w.next.date)}, opens ${time(w.next.openAt)} PT` : ''}`
    : `${day} · opens ${time(w.session!.openAt)} PT · ${w.session!.earlyClose ? `EARLY CLOSE ${time(w.session!.closeAt)} PT` : `closes ${time(w.session!.closeAt)} PT`}`;

  const alerts: MorningEmailProps['alerts'] = {
    title: w.recap ? 'Alerts since Friday' : 'Overnight alerts',
    items: d.alerts.map((a) => {
      const tag = /\[AIA\] (ACTION|WARNING|REVIEW|REMINDER)\b/.exec(a.subject)?.[1];
      return {
        time: dayTime(a.createdAt),
        severity: tag ? TAG_SEVERITY[tag]! : null,
        text: a.subject.replace(/^.*?\[AIA\] (?:ACTION|WARNING|REVIEW|REMINDER|HEALTH) /, ''),
        pending: !a.sent,
      };
    }),
  };

  let econ: MorningEmailProps['econ'] = null;
  if (!w.closed && (!d.econ.available || d.econ.items.length)) {
    const rank = (i: string) => (i === 'High' ? 0 : 1);
    const items = [...d.econ.items].sort((a, b) =>
      w.recap
        ? a.at.getTime() - b.at.getTime() || rank(a.impact) - rank(b.impact)
        : rank(a.impact) - rank(b.impact) || a.at.getTime() - b.at.getTime(),
    );
    econ = {
      title: w.recap ? 'Economic calendar this week' : 'Economic calendar today',
      available: d.econ.available,
      rows: items.map((e) => ({
        time: e.allDay
          ? `${w.recap ? `${shortDay(e.at.toISOString().slice(0, 10)).split(',')[0]} ` : ''}all day`
          : w.recap
            ? dayTime(e.at)
            : time(e.at),
        event: e.title,
        impact: e.impact,
        forecast: e.forecast,
        previous: e.previous,
        actual: e.actual,
        // Never invent an actual: if it's out but the feed hasn't got it, say so.
        status:
          !e.actual && !e.allDay && e.at <= d.generatedAt
            ? `released ${time(e.at)}, see brief`
            : null,
      })),
    };
  }

  let premarket: MorningEmailProps['premarket'] = null;
  if (!w.closed && d.premarket.quotes.length) {
    const asOf = d.premarket.asOf
      ? ` · as of ${time(d.premarket.asOf)} PT${d.premarket.feed === 'sip' ? ' (15-min delayed)' : ''}`
      : '';
    premarket = {
      title: `Pre-market${asOf}`,
      note: !d.premarket.available
        ? 'Pre-market unavailable on the free feed; last close shown.'
        : d.premarket.note,
      rows: d.premarket.quotes.map((q) => ({
        symbol: q.symbol,
        close: price(q.lastClose),
        pre:
          q.price === null
            ? q.lastClose === null
              ? 'no data source'
              : 'no pre-market trades'
            : `${price(q.price)} ${q.changePct === null ? '' : signedPct(q.changePct, 2)}`.trim(),
        changePct: q.price === null ? null : q.changePct,
      })),
    };
  }

  const upcoming: MorningEmailProps['upcoming'] =
    d.upcoming.items.length || !d.upcoming.available.earnings
      ? {
          title: w.recap ? 'This week (+ earnings, next 3 weeks)' : 'Upcoming 7 days',
          note: d.upcoming.available.earnings
            ? null
            : `Earnings calendar unavailable today${d.upcoming.available.lastFetched ? ` (last updated ${d.upcoming.available.lastFetched})` : ''}.`,
          items: d.upcoming.items.map((e) => {
            const tod = TIME_OF_DAY[e.timeOfDay] ? ` ${TIME_OF_DAY[e.timeOfDay]}` : '';
            const state = ['earnings', 'lockup_expiry', 'guidance'].includes(e.eventType)
              ? e.estimated
                ? ' (estimated)'
                : ' (confirmed)'
              : '';
            const src = SOURCE_PILL[e.source] ?? { label: e.source, tone: 'neutral' as const };
            return {
              date: shortDay(e.date).replace(',', ''),
              ticker: e.ticker,
              what: `${EVENT_LABEL[e.eventType] ?? e.eventType}${tod}${state}`,
              title: e.title,
              moved: e.previousDate
                ? `moved from ${shortDay(e.previousDate).replace(',', '')}`
                : null,
              note: e.note,
              source: src.label,
              sourceTone: src.tone,
            };
          }),
        }
      : null;

  const health = d.health.issues.length
    ? `🩺 ${plural(d.health.issues.length, 'feed issue')}: ${d.health.issues.map((i) => `${FEED_LABEL[i.feed] ?? i.feed} ${i.status}${i.detail ? ` (${i.detail})` : ''}`).join('; ')}`
    : `🩺 All ${d.health.ok} feeds OK`;

  return {
    subject: morningSubject(d),
    preview: morningPreviewText(d),
    title: w.closed
      ? '☀️ Market Closed'
      : w.recap
        ? '🗓️ Weekend Recap + Week Ahead'
        : '☀️ Morning Brief',
    subtitle,
    kpis: kpis(d),
    alerts,
    econ,
    filings: w.closed ? [] : filingItems(d),
    headlines: w.closed ? null : headlinesProps(d.headlines),
    premarket,
    levels: w.closed ? [] : d.levels.map(levelPhrase),
    active: w.closed
      ? []
      : d.active.map((a) => ({
          ticker: a.display,
          status: a.status.toLowerCase(),
          since: `${plural(a.daysActive, 'day')} active, since ${dayOfDate(a.firstFiredOn).split(', ')[1]}`,
          message: a.message,
        })),
    upcoming,
    lastWeek:
      w.recap && d.lastWeek
        ? {
            rows: d.lastWeek.map((r) => ({ symbol: r.symbol, changePct: r.changePct })),
            alerts: (d.pastWeekAlerts ?? []).map(
              (a) => `${dayTime(a.createdAt)} — ${a.subject.replace(/^.*?\[AIA\] /, '')}`,
            ),
          }
        : null,
    footer: [
      health,
      `Covers ${dayTime(w.start)} → ${dayTime(w.end)} PT${w.recap ? ' (weekend recap)' : ''} · generated ${dayTime(d.generatedAt)} PT`,
    ],
  };
}

/** Subject, HTML and plain text for the morning email. */
export async function renderMorning(d: MorningData) {
  const props = morningEmailProps(d);
  return { props, ...(await renderMorningEmail(props)) };
}
