import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlpacaNewsItem } from '../alpaca/schemas';
import { newsHash, toNewsRow } from './store';
import { NewsStream, type SocketLike } from './stream';

const item = (over: Partial<AlpacaNewsItem> = {}): AlpacaNewsItem => ({
  id: 1,
  headline: 'Watx CEO Steps Down, Board Names Interim Chief',
  summary: 's',
  author: 'a',
  created_at: '2026-11-08T15:00:00Z',
  url: 'https://example.com/1',
  symbols: ['WATX'],
  source: 'benzinga',
  ...over,
});

describe('news normalization', () => {
  it('hashes the same story identically across ids, punctuation and symbol order', () => {
    expect(newsHash('Hello, World!', ['B', 'A'])).toBe(newsHash('hello world', ['a', 'b']));
    expect(toNewsRow(item({ id: 2 }), new Date(), 'rest').hash).toBe(
      toNewsRow(item({ id: 1 }), new Date(), 'stream').hash,
    );
  });

  it('keeps generic headlines about different tickers distinct', () => {
    expect(newsHash('Earnings Scheduled For November 17', ['WATX'])).not.toBe(
      newsHash('Earnings Scheduled For November 17', ['AMX']),
    );
  });

  it('maps fields, keeps tickers, and records how it arrived', () => {
    const received = new Date('2026-11-08T15:00:04Z');
    expect(toNewsRow(item({ symbols: ['watx', 'AMD', 'WATX'] }), received, 'stream')).toMatchObject(
      {
        source: 'alpaca:benzinga',
        sourceId: '1',
        symbols: ['AMD', 'WATX'],
        publishedAt: new Date('2026-11-08T15:00:00Z'),
        receivedAt: received,
        via: 'stream',
      },
    );
  });
});

class FakeSocket extends EventEmitter implements SocketLike {
  sent: unknown[] = [];
  pings = 0;
  terminated = false;
  closed = false;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  ping() {
    this.pings++;
  }
  terminate() {
    this.terminated = true;
    this.emit('close', 1006, Buffer.from(''));
  }
  close() {
    this.closed = true;
    this.emit('close', 1000, Buffer.from(''));
  }
  server(...msgs: unknown[]) {
    this.emit('message', Buffer.from(JSON.stringify(msgs)));
  }
  handshake(symbols = ['WATX']) {
    this.server({ T: 'success', msg: 'connected' });
    this.server({ T: 'success', msg: 'authenticated' });
    this.server({ T: 'subscription', news: symbols });
  }
}

describe('NewsStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-16T15:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  function setup() {
    const sockets: FakeSocket[] = [];
    const onNews = vi.fn();
    const onGap = vi.fn();
    const stream = new NewsStream({
      url: 'wss://x',
      key: 'k',
      secret: 's',
      symbols: ['WATX'],
      onNews,
      onGap,
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      heartbeatMs: 30_000,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      random: () => 1,
    });
    return { stream, sockets, onNews, onGap };
  }
  const flush = () => vi.advanceTimersByTimeAsync(0);

  it('authenticates, subscribes and delivers news with tickers', async () => {
    const { stream, sockets, onNews } = setup();
    stream.start();
    const s = sockets[0]!;
    s.handshake();
    await flush();
    expect(s.sent).toEqual([
      { action: 'auth', key: 'k', secret: 's' },
      { action: 'subscribe', news: ['WATX'] },
    ]);
    expect(stream.state).toBe('subscribed');

    s.server({ T: 'n', ...item() });
    await flush();
    expect(onNews).toHaveBeenCalledTimes(1);
    const [items] = onNews.mock.calls[0] as [AlpacaNewsItem[]];
    expect(items[0]).toMatchObject({ id: 1, symbols: ['WATX'] });
    expect(items[0]).not.toHaveProperty('T');
  });

  it('reconnects with exponential backoff and fills the gap after recovering', async () => {
    const { stream, sockets, onGap } = setup();
    stream.start();
    sockets[0]!.handshake();
    await flush();
    const healthyAt = new Date();

    vi.advanceTimersByTime(5_000);
    sockets[0]!.terminate(); // dropped connection
    expect(stream.state).toBe('waiting');

    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2); // first retry after 1s

    sockets[1]!.close(); // fails again before subscribing
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(3); // second retry after 2s

    sockets[2]!.handshake();
    await flush();
    expect(stream.state).toBe('subscribed');
    expect(stream.reconnects).toBe(1);
    expect(stream.attempts).toBe(0);
    expect(onGap).toHaveBeenCalledTimes(1);
    expect((onGap.mock.calls[0] as [Date])[0].getTime()).toBe(healthyAt.getTime());
  });

  it('terminates a silent connection when a pong is missed', async () => {
    const { stream, sockets } = setup();
    stream.start();
    sockets[0]!.handshake();
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets[0]!.pings).toBe(1);
    sockets[0]!.emit('pong');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets[0]!.pings).toBe(2); // pong arrived: keep going
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets[0]!.terminated).toBe(true); // no pong: dead
    expect(stream.state).toBe('waiting');
  });

  it('closes on a server error message and retries', async () => {
    const { stream, sockets } = setup();
    stream.start();
    sockets[0]!.server({ T: 'success', msg: 'connected' });
    sockets[0]!.server({ T: 'error', code: 406, msg: 'connection limit exceeded' });
    await flush();
    expect(sockets[0]!.closed).toBe(true);
    expect(stream.state).toBe('waiting');
  });

  it('does not reconnect after stop()', async () => {
    const { stream, sockets } = setup();
    stream.start();
    sockets[0]!.handshake();
    await flush();
    stream.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
    expect(stream.state).toBe('stopped');
  });
});
