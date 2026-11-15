/**
 * Alpaca news websocket with reconnect and backoff.
 *
 * Protocol: server sends [{T:"success",msg:"connected"}] → we send auth → [{T:"success",
 * msg:"authenticated"}] → we subscribe → [{T:"subscription",news:[...]}] → news frames
 * [{T:"n",...}]. Every frame is a JSON array.
 *
 * Reliability:
 * - Any close or error schedules a reconnect with exponential backoff and jitter (capped).
 * - A ping every `heartbeatMs`; if the pong hasn't arrived by the next tick, the socket is
 *   considered dead and is terminated (this catches silent half-open connections).
 * - After every successful re-subscribe, `onGap(since)` is called so the caller can fill the
 *   outage window from the REST API.
 */
import WebSocket from 'ws';
import { backoffDelay } from '../lib/http';
import { log } from '../lib/log';
import { newsItemSchema, streamMessageSchema, type AlpacaNewsItem } from '../alpaca/schemas';

/** The subset of the `ws` WebSocket API we use (lets tests inject a fake). */
export interface SocketLike {
  on(event: 'message', cb: (data: WebSocket.RawData) => void): unknown;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'open' | 'pong', cb: () => void): unknown;
  send(data: string): void;
  ping(): void;
  terminate(): void;
  close(): void;
}

export type StreamStatusEvent =
  | { type: 'connected'; reconnects: number }
  | { type: 'disconnected'; detail: string }
  | { type: 'heartbeat' };

export type StreamState =
  'idle' | 'connecting' | 'authenticating' | 'subscribed' | 'waiting' | 'stopped';

export interface NewsStreamOptions {
  url: string;
  key: string;
  secret: string;
  symbols: readonly string[];
  onNews: (items: AlpacaNewsItem[], receivedAt: Date) => Promise<void> | void;
  /** Called after a reconnect with the time the previous connection was last known healthy. */
  onGap?: (since: Date) => Promise<void> | void;
  /** Connection lifecycle and heartbeats, for feed health. Must not throw. */
  onStatus?: (event: StreamStatusEvent) => void;
  createSocket?: (url: string) => SocketLike;
  heartbeatMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: () => Date;
  random?: () => number;
}

export class NewsStream {
  state: StreamState = 'idle';
  /** Consecutive failed attempts; reset once subscribed. */
  attempts = 0;
  reconnects = 0;
  private socket: SocketLike | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private awaitingPong = false;
  /** Last moment we knew the stream was healthy (subscribed, message or pong). */
  private lastHealthyAt: Date | null = null;
  private hadConnection = false;

  constructor(private readonly o: NewsStreamOptions) {}

  start() {
    if (this.state !== 'idle' && this.state !== 'stopped') return;
    this.connect();
  }

  stop() {
    this.state = 'stopped';
    this.clearTimers();
    this.socket?.close();
    this.socket = null;
  }

  private now() {
    return this.o.now?.() ?? new Date();
  }

  private connect() {
    this.state = 'connecting';
    const socket = (this.o.createSocket ?? ((url) => new WebSocket(url)))(this.o.url);
    this.socket = socket;

    socket.on('message', (data) => {
      if (socket !== this.socket) return;
      void this.handleFrame(data.toString());
    });
    socket.on('pong', () => {
      this.awaitingPong = false;
      if (this.state === 'subscribed') {
        this.lastHealthyAt = this.now();
        this.o.onStatus?.({ type: 'heartbeat' });
      }
    });
    socket.on('error', (err) => log.warn('news stream socket error', { error: err.message }));
    socket.on('close', (code, reason) => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.clearTimers();
      if (this.state === 'stopped') return;
      log.warn('news stream closed', { code, reason: reason.toString() });
      this.o.onStatus?.({ type: 'disconnected', detail: `closed with code ${code}` });
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    this.state = 'waiting';
    const delay = backoffDelay(
      this.attempts,
      this.o.baseDelayMs ?? 1_000,
      this.o.maxDelayMs ?? 60_000,
      this.o.random,
    );
    this.attempts++;
    log.info('news stream reconnecting', { inMs: delay, attempt: this.attempts });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.state === 'waiting') this.connect();
    }, delay);
  }

  private async handleFrame(text: string) {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      log.warn('news stream: non-JSON frame', { text: text.slice(0, 200) });
      return;
    }
    const news: AlpacaNewsItem[] = [];
    for (const raw of Array.isArray(frame) ? frame : [frame]) {
      const parsed = streamMessageSchema.safeParse(raw);
      if (!parsed.success) {
        log.warn('news stream: unrecognised message', { raw: JSON.stringify(raw).slice(0, 200) });
        continue;
      }
      const m = parsed.data;
      if (m.T === 'success' && m.msg === 'connected') {
        this.state = 'authenticating';
        this.socket?.send(
          JSON.stringify({ action: 'auth', key: this.o.key, secret: this.o.secret }),
        );
      } else if (m.T === 'success' && m.msg === 'authenticated') {
        this.socket?.send(JSON.stringify({ action: 'subscribe', news: this.o.symbols }));
      } else if (m.T === 'subscription') {
        await this.onSubscribed(m.news ?? []);
      } else if (m.T === 'error') {
        // e.g. 402 auth failed, 406 connection limit exceeded. Close; backoff handles the retry.
        log.error('news stream error message', { code: m.code, msg: m.msg });
        this.socket?.close();
      } else if (m.T === 'n') {
        news.push(newsItemSchema.parse(m));
      }
    }
    if (news.length) {
      this.lastHealthyAt = this.now();
      this.o.onStatus?.({ type: 'heartbeat' });
      await this.o.onNews(news, this.now());
    }
  }

  private async onSubscribed(symbols: string[]) {
    const gapSince = this.hadConnection ? this.lastHealthyAt : null;
    this.state = 'subscribed';
    this.attempts = 0;
    this.lastHealthyAt = this.now();
    if (this.hadConnection) this.reconnects++;
    this.hadConnection = true;
    this.startHeartbeat();
    log.info('news stream subscribed', { symbols: symbols.length, reconnects: this.reconnects });
    this.o.onStatus?.({ type: 'connected', reconnects: this.reconnects });
    if (gapSince && this.o.onGap) {
      try {
        await this.o.onGap(gapSince);
      } catch (error) {
        log.error('news gap fill failed', { error: String(error) });
      }
    }
  }

  private startHeartbeat() {
    this.clearHeartbeat();
    this.awaitingPong = false;
    this.heartbeat = setInterval(() => {
      if (!this.socket) return;
      if (this.awaitingPong) {
        log.warn('news stream heartbeat missed; terminating socket');
        this.socket.terminate();
        return;
      }
      this.awaitingPong = true;
      this.socket.ping();
    }, this.o.heartbeatMs ?? 30_000);
  }

  private clearHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private clearTimers() {
    this.clearHeartbeat();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
