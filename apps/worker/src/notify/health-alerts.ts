/** Feed-health emails: only when a feed fails (ok → degraded/down) and when it recovers. */
import type { FeedAssessment, FeedState } from '../health/assess';
import { escapeHtml, htmlDoc, ptTime } from './format';

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

const FEED_NAMES: Record<string, string> = {
  alpaca_news_stream: 'News stream (Alpaca)',
  alpaca_quotes: 'Quotes (Alpaca)',
  alpaca_bars: 'Daily bars (Alpaca)',
  sec_edgar: 'SEC EDGAR filings',
  scheduler: 'Scheduler',
};

export function composeHealthAlert(t: FeedTransition, now: Date) {
  const name = FEED_NAMES[t.feed] ?? t.feed;
  const subject =
    t.kind === 'failure' ? `[AIA] HEALTH ${name}: ${t.to}` : `[AIA] HEALTH ${name}: recovered`;
  const lead =
    t.kind === 'failure'
      ? `${name} is ${t.to}. Rules that depend on it may be reported as "not checked" until it recovers.`
      : `${name} has recovered (was ${t.from}).`;
  const text = `${lead}\n\nDetail: ${t.detail}\nChecked ${ptTime(now)}.`;
  const html = htmlDoc(
    subject,
    `<p><strong>${escapeHtml(lead)}</strong></p><p>Detail: ${escapeHtml(t.detail)}</p><p style="color:#555">Checked ${escapeHtml(ptTime(now))}.</p>`,
  );
  return { subject, text, html };
}
