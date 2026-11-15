import type { Context } from '../context';
import { recordFeedStatus } from '../health/feed-status';
import { runJob } from '../lib/jobs';
import { log } from '../lib/log';
import { loadUniverse } from '../market/universe';
import { collectNews } from './backfill';
import { insertNews, toNewsRow } from './store';
import { NewsStream, type StreamStatusEvent } from './stream';

/** Raw connection state written by the stream; the health job writes the assessed 'alpaca_news_stream'. */
export const NEWS_STREAM_CONNECTION_FEED = 'alpaca_news_stream:connection';
/** Heartbeats arrive every ~30 s; write at most one per minute. */
const HEARTBEAT_WRITE_MS = 60_000;

/**
 * Owns the news websocket: REST backfill first, then the stream; every reconnect triggers a
 * REST gap fill; connection state is written to feed_status. refreshSymbols() restarts the
 * stream when holdings or the watchlist change.
 */
export class NewsStreamManager {
  private stream: NewsStream | null = null;
  private symbols: string[] = [];
  private lastHeartbeatWrite = 0;

  constructor(private readonly ctx: Context) {}

  get state() {
    return this.stream?.state ?? 'idle';
  }

  get reconnects() {
    return this.stream?.reconnects ?? 0;
  }

  async start() {
    const { db, alpaca } = this.ctx;
    this.symbols = (await loadUniverse(db)).newsSymbols;
    await runJob(db, 'news_backfill', () =>
      collectNews(db, alpaca, { symbols: this.symbols, days: 7 }),
    );
    this.open();
  }

  /** Restarts the stream if the news universe changed. Returns true if it restarted. */
  async refreshSymbols(): Promise<boolean> {
    const next = (await loadUniverse(this.ctx.db)).newsSymbols;
    if (next.join(',') === this.symbols.join(',')) return false;
    const added = next.filter((s) => !this.symbols.includes(s));
    log.info('news universe changed; restarting stream', { added, count: next.length });
    this.stream?.stop();
    this.symbols = next;
    if (added.length) {
      const { db, alpaca } = this.ctx;
      await runJob(db, 'news_backfill', () =>
        collectNews(db, alpaca, {
          symbols: added,
          days: 7,
          since: new Date(Date.now() - 7 * 86_400_000),
        }),
      );
    }
    this.open();
    return true;
  }

  /** Resolves true once subscribed, or false after `timeoutMs` (startup waits on this). */
  async waitUntilConnected(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.stream?.state === 'subscribed') return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return this.stream?.state === 'subscribed';
  }

  stop() {
    this.stream?.stop();
    this.stream = null;
  }

  private open() {
    const { db, alpaca, env } = this.ctx;
    const symbols = this.symbols;
    this.stream = new NewsStream({
      url: env.ALPACA_NEWS_WS_URL,
      key: env.ALPACA_KEY_ID,
      secret: env.ALPACA_SECRET,
      symbols,
      onNews: async (items, receivedAt) => {
        const res = await insertNews(
          db,
          items.map((i) => toNewsRow(i, receivedAt, 'stream')),
        );
        log.info('news received', {
          ...res,
          headlines: items.map((i) => `[${i.symbols.join(',')}] ${i.headline.slice(0, 60)}`),
        });
      },
      onGap: async (since) => {
        await runJob(db, 'news_gap_fill', () =>
          collectNews(db, alpaca, { symbols, days: 7, since }),
        );
      },
      onStatus: (e) => this.onStatus(e),
    });
    this.stream.start();
  }

  private onStatus(e: StreamStatusEvent) {
    const now = Date.now();
    if (e.type === 'heartbeat') {
      if (now - this.lastHeartbeatWrite < HEARTBEAT_WRITE_MS) return;
      this.lastHeartbeatWrite = now;
    }
    const row =
      e.type === 'disconnected'
        ? { status: 'degraded' as const, detail: e.detail, okNow: false }
        : {
            status: 'ok' as const,
            detail: `subscribed to ${this.symbols.length} symbols`,
            okNow: true,
          };
    recordFeedStatus(this.ctx.db, {
      feed: NEWS_STREAM_CONNECTION_FEED,
      ...row,
      meta: { reconnects: this.reconnects, symbols: this.symbols.length },
    }).catch((error: unknown) => log.warn('feed status write failed', { error: String(error) }));
  }
}
