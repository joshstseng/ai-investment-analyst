/**
 * Feed health assessment (pure). Inputs are a snapshot of what's in the database; the output is
 * one status per feed. Milestone 8 turns non-ok statuses into feed-outage alerts.
 */
export type FeedState = 'ok' | 'degraded' | 'down' | 'disabled';

export interface FeedAssessment {
  feed: string;
  status: FeedState;
  detail: string;
  /** Set when this check saw the feed healthy. */
  okNow: boolean;
}

export interface HealthSnapshot {
  now: Date;
  marketOpen: boolean;
  /** When the current session opened (if open). */
  openedAt: Date | null;
  news: {
    enabled: boolean;
    /** Row the stream writes about itself, if any. */
    status: { status: FeedState; since: Date; lastOkAt: Date | null; detail: string | null } | null;
  };
  quotes: { latestReceivedAt: Date | null };
  bars: {
    /** Latest session whose close check time has passed. */
    expectedDate: string | null;
    /** Symbols with bar data (not no_data_source) lacking a bar for expectedDate. */
    missing: string[];
    tracked: number;
  };
  edgar: {
    enabled: boolean;
    inWindow: boolean;
    lastSuccessAt: Date | null;
    erroring: string[];
  };
  jobErrors: { job: string; at: Date; error: string }[];
}

const MIN = 60_000;
export const THRESHOLDS = {
  /** No pong/message from the stream for this long → degraded. */
  streamHeartbeatMs: 5 * MIN,
  /** Stream down for this long → down (short blips are reconnects). */
  streamDownMs: 10 * MIN,
  /** Quotes older than this while the market is open → down (polled every 5 min). */
  quotesMs: 15 * MIN,
  /** Grace after the open before quotes are expected. */
  quotesOpenGraceMs: 10 * MIN,
  /** No successful EDGAR poll for this long inside the window → down (polled every 10 min). */
  edgarMs: 30 * MIN,
} as const;

const ago = (now: Date, d: Date) => `${Math.round((now.getTime() - d.getTime()) / MIN)} min ago`;

export function assessFeeds(s: HealthSnapshot): FeedAssessment[] {
  const out: FeedAssessment[] = [];
  const add = (feed: string, status: FeedState, detail: string) =>
    out.push({ feed, status, detail, okNow: status === 'ok' });

  // News websocket (the stream records its own state).
  if (!s.news.enabled) {
    add('alpaca_news_stream', 'disabled', 'NEWS_STREAM_ENABLED=false on this worker');
  } else if (!s.news.status) {
    add('alpaca_news_stream', 'down', 'stream has never reported a connection');
  } else {
    const st = s.news.status;
    const downFor = s.now.getTime() - st.since.getTime();
    if (st.status !== 'ok') {
      add(
        'alpaca_news_stream',
        downFor >= THRESHOLDS.streamDownMs ? 'down' : 'degraded',
        `disconnected since ${st.since.toISOString()}${st.detail ? ` (${st.detail})` : ''}`,
      );
    } else if (
      !st.lastOkAt ||
      s.now.getTime() - st.lastOkAt.getTime() > THRESHOLDS.streamHeartbeatMs
    ) {
      add(
        'alpaca_news_stream',
        'degraded',
        `connected but no heartbeat since ${st.lastOkAt ? ago(s.now, st.lastOkAt) : 'never'}`,
      );
    } else {
      add('alpaca_news_stream', 'ok', `connected since ${st.since.toISOString()}`);
    }
  }

  // Quotes: only expected while the market is open.
  if (!s.marketOpen) {
    add('alpaca_quotes', 'ok', 'market closed');
  } else if (s.openedAt && s.now.getTime() - s.openedAt.getTime() < THRESHOLDS.quotesOpenGraceMs) {
    add('alpaca_quotes', 'ok', 'market just opened');
  } else if (
    !s.quotes.latestReceivedAt ||
    s.now.getTime() - s.quotes.latestReceivedAt.getTime() > THRESHOLDS.quotesMs
  ) {
    add(
      'alpaca_quotes',
      'down',
      `no quotes ${s.quotes.latestReceivedAt ? `since ${ago(s.now, s.quotes.latestReceivedAt)}` : 'stored'} during market hours`,
    );
  } else {
    add('alpaca_quotes', 'ok', `latest ${ago(s.now, s.quotes.latestReceivedAt)}`);
  }

  // Daily bars for the latest checked session.
  if (!s.bars.expectedDate) {
    add('alpaca_bars', 'ok', 'no completed session yet');
  } else if (s.bars.missing.length === 0) {
    add('alpaca_bars', 'ok', `all ${s.bars.tracked} symbols have ${s.bars.expectedDate}`);
  } else {
    add(
      'alpaca_bars',
      s.bars.missing.length === s.bars.tracked ? 'down' : 'degraded',
      `missing ${s.bars.expectedDate} bar for ${s.bars.missing.join(', ')}`,
    );
  }

  // EDGAR.
  if (!s.edgar.enabled) {
    add('sec_edgar', 'disabled', 'SEC_USER_AGENT not set');
  } else if (
    s.edgar.inWindow &&
    (!s.edgar.lastSuccessAt ||
      s.now.getTime() - s.edgar.lastSuccessAt.getTime() > THRESHOLDS.edgarMs)
  ) {
    add(
      'sec_edgar',
      'down',
      `no successful poll ${s.edgar.lastSuccessAt ? `since ${ago(s.now, s.edgar.lastSuccessAt)}` : 'yet'}`,
    );
  } else if (s.edgar.erroring.length) {
    add('sec_edgar', 'degraded', `errors for ${s.edgar.erroring.join(', ')}`);
  } else {
    add('sec_edgar', 'ok', s.edgar.inWindow ? 'polling' : 'outside the 5 AM–9 PM PT window');
  }

  // Scheduler: any failed job in the last hour.
  if (s.jobErrors.length) {
    const jobs = [...new Set(s.jobErrors.map((e) => e.job))];
    add('scheduler', 'degraded', `failed in the last hour: ${jobs.join(', ')}`);
  } else {
    add('scheduler', 'ok', 'no failed jobs in the last hour');
  }
  return out;
}
