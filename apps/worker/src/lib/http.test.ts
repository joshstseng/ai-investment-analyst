import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { backoffDelay, HttpError, RateLimiter, requestJson } from './http';

const schema = z.object({ ok: z.boolean() });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const noWait = vi.fn(async () => {});

describe('backoffDelay', () => {
  it('grows exponentially, caps, and jitters within [exp/2, exp]', () => {
    expect(backoffDelay(0, 1000, 60_000, () => 0)).toBe(500);
    expect(backoffDelay(0, 1000, 60_000, () => 1)).toBe(1000);
    expect(backoffDelay(3, 1000, 60_000, () => 1)).toBe(8000);
    expect(backoffDelay(20, 1000, 60_000, () => 1)).toBe(60_000);
  });
});

describe('requestJson', () => {
  it('returns parsed JSON', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true }));
    await expect(requestJson('https://x/a', { schema, fetchImpl, wait: noWait })).resolves.toEqual({
      ok: true,
    });
  });

  it('retries 429 and 5xx, honouring Retry-After', async () => {
    const wait = vi.fn(async () => {});
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '7' }))
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ ok: true }));
    await expect(requestJson('https://x/a', { schema, fetchImpl, wait })).resolves.toEqual({
      ok: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect((wait.mock.calls[0] as unknown as [number])[0]).toBeGreaterThanOrEqual(7000);
  });

  it('retries network errors and timeouts, then gives up', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      requestJson('https://x/a', { schema, fetchImpl, wait: noWait, retries: 2 }),
    ).rejects.toThrow('fetch failed');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry 4xx or schema errors', async () => {
    const forbidden = vi.fn(async () => json({ message: 'subscription does not permit' }, 403));
    const err = await requestJson('https://x/a?k=v', {
      schema,
      fetchImpl: forbidden,
      wait: noWait,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect((err as HttpError).message).not.toContain('k=v');
    expect(forbidden).toHaveBeenCalledTimes(1);

    const badShape = vi.fn(async () => json({ ok: 'yes' }));
    await expect(
      requestJson('https://x/a', { schema, fetchImpl: badShape, wait: noWait }),
    ).rejects.toThrow();
    expect(badShape).toHaveBeenCalledTimes(1);
  });

  it('passes a timeout signal to fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ ok: true }));
    await requestJson('https://x/a', { schema, fetchImpl, wait: noWait, timeoutMs: 1234 });
    expect(fetchImpl.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('RateLimiter', () => {
  it('allows a burst, then spaces requests at the sustained rate', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(
      60,
      2,
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );
    await limiter.take();
    await limiter.take();
    expect(waits).toEqual([]);
    await limiter.take(); // 60/min = 1 token per second
    expect(waits).toEqual([1000]);
    now += 5000; // refills, but never above the burst size
    await limiter.take();
    await limiter.take();
    await limiter.take();
    expect(waits).toEqual([1000, 1000]);
  });
});
