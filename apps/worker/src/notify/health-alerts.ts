/** Feed-health emails: only when a feed fails (ok → degraded/down) and when it recovers. */
import { renderHealthEmail, type HealthEmailProps } from '@aia/emails';
import type { FeedAssessment, FeedState } from '../health/assess';
import { ptTime } from './format';

export interface FeedTransition {
  feed: string;
  kind: 'failure' | 'recovery';
  from: FeedState;
  to: FeedState;
  detail: string;
}

const bad = (s: FeedState) => s === 'degraded' || s === 'down';

/** Compares the previous stored statuses with a new assessment (pure). Missing previous = ok. */
export function feedTransitions(
  previous: ReadonlyMap<string, FeedState>,
  next: readonly FeedAssessment[],
): FeedTransition[] {
  const out: FeedTransition[] = [];
  for (const n of next) {
    const from = previous.get(n.feed) ?? 'ok';
    if (!bad(from) && bad(n.status)) {
      out.push({ feed: n.feed, kind: 'failure', from, to: n.status, detail: n.detail });
    } else if (bad(from) && n.status === 'ok') {
      out.push({ feed: n.feed, kind: 'recovery', from, to: n.status, detail: n.detail });
    }
  }
  return out;
}

export const FEED_NAMES: Record<string, string> = {
  alpaca_news_stream: 'News stream (Alpaca)',
  alpaca_quotes: 'Quotes (Alpaca)',
  alpaca_bars: 'Daily bars (Alpaca)',
  sec_edgar: 'SEC EDGAR filings',
  scheduler: 'Scheduler',
  alphavantage_calendar: 'Earnings calendar (Alpha Vantage)',
};

/** What a broken feed affects. */
const IMPACT: Record<string, string> = {
  alpaca_news_stream:
    'Real-time headlines. News still arrives through the regular REST polls, just later.',
  alpaca_quotes: 'Intraday quotes. Rules use daily closes, so exit checks are not affected.',
  alpaca_bars:
    'Daily closes. Rules that need today\'s close are reported as "not checked" until bars arrive.',
  sec_edgar: 'New SEC filings will not appear in alerts, the digest or the morning email.',
  scheduler: 'Scheduled jobs (close check, digest, morning email) may run late or be skipped.',
  alphavantage_calendar:
    'Earnings dates. The morning email shows "calendar unavailable" and dates may be stale.',
};

const feedName = (feed: string) => FEED_NAMES[feed] ?? feed;

/** "2h 15m" */
export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export interface HealthContext {
  /** Recoveries: when the outage started. */
  since?: Date | null;
  /** Other feeds' current statuses ("still working"). */
  others?: { feed: string; status: FeedState }[];
  /** Overrides the default lead sentence. */
  lead?: string;
}

/** Builds the HEALTH email's props (pure). */
export function healthAlertProps(
  t: FeedTransition,
  now: Date,
  c: HealthContext = {},
): HealthEmailProps {
  const name = feedName(t.feed);
  const failure = t.kind === 'failure';
  const statusLabel = failure ? t.to : 'recovered';
  const lead =
    c.lead ??
    (failure
      ? `${name} is ${t.to}.`
      : `${name} is working again${c.since ? ` after ${duration(now.getTime() - c.since.getTime())}` : ''}.`);
  const facts: HealthEmailProps['facts'] = [];
  if (failure) facts.push({ label: 'Since', value: ptTime(c.since ?? now) });
  else if (c.since) {
    facts.push({ label: 'Down from', value: ptTime(c.since) });
    facts.push({ label: 'Down for', value: duration(now.getTime() - c.since.getTime()) });
  }
  facts.push({ label: 'Detail', value: t.detail });
  facts.push({ label: 'Checked', value: ptTime(now) });
  const working = (c.others ?? [])
    .filter((o) => o.feed !== t.feed && o.status === 'ok')
    .map((o) => feedName(o.feed));
  const preview = failure
    ? `${statusLabel} since ${ptTime(c.since ?? now)} · ${IMPACT[t.feed]?.split('.')[0] ?? t.detail}`
    : `back${c.since ? ` after ${duration(now.getTime() - c.since.getTime())}` : ''} · ${t.detail}`;
  return {
    subject: `🩺 [AIA] HEALTH ${name}: ${statusLabel}`,
    preview,
    feedName: name,
    kind: t.kind,
    statusLabel,
    lead,
    facts,
    impact: failure
      ? (IMPACT[t.feed] ?? null)
      : IMPACT[t.feed]
        ? `${IMPACT[t.feed]!.split('.')[0]} is current again.`
        : null,
    stillWorks: failure && working.length ? working.join(', ') : null,
    next: failure
      ? "You'll get one more email when it recovers. No repeat emails while it stays down."
      : 'No action needed.',
    footer: [`Feed: ${t.feed} · ${t.from} → ${t.to}`],
  };
}

export async function composeHealthAlert(t: FeedTransition, now: Date, c: HealthContext = {}) {
  const props = healthAlertProps(t, now, c);
  return { props, ...(await renderHealthEmail(props)) };
}
