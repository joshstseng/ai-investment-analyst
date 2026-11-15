import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from './env';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  ALPACA_KEY_ID: 'k',
  ALPACA_SECRET: 's',
};

describe('loadEnv', () => {
  afterEach(() => vi.unstubAllEnvs());

  function stub(vars: Record<string, string>) {
    for (const [k, v] of Object.entries({ ...base, ...vars })) vi.stubEnv(k, v);
  }

  it.each([
    ['true', true],
    ['false', false],
    ['0', false],
    ['1', true],
  ])('NEWS_STREAM_ENABLED=%s → %s', (value, expected) => {
    stub({ NEWS_STREAM_ENABLED: value, SEC_USER_AGENT: '' });
    expect(loadEnv().NEWS_STREAM_ENABLED).toBe(expected);
  });

  it('treats an empty SEC_USER_AGENT as unset and rejects one without an email', () => {
    stub({ SEC_USER_AGENT: '', NEWS_STREAM_ENABLED: 'true' });
    expect(loadEnv().SEC_USER_AGENT).toBeUndefined();
    stub({ SEC_USER_AGENT: 'just a name' });
    expect(() => loadEnv()).toThrow(/SEC_USER_AGENT/);
  });

  it('strips quotes pasted around values (dashboards and docker keep them literally)', () => {
    stub({
      NEWS_STREAM_ENABLED: '"false"',
      SEC_USER_AGENT: '"AIA test contact@example.com"',
      GMAIL_USER: "'me@example.com'",
      ALERT_EMAIL_TO: '"me@example.com"',
    });
    const env = loadEnv();
    expect(env.NEWS_STREAM_ENABLED).toBe(false);
    expect(env.SEC_USER_AGENT).toBe('AIA test contact@example.com');
    expect(env.GMAIL_USER).toBe('me@example.com');
    expect(env.ALERT_EMAIL_TO).toEqual(['me@example.com']);
  });

  it('reports variable names, not values', () => {
    stub({ ALPACA_SECRET: '', NEWS_STREAM_ENABLED: 'true', SEC_USER_AGENT: '' });
    vi.stubEnv('ALPACA_KEY_ID', 'super-secret-key-value');
    let message = '';
    try {
      loadEnv();
    } catch (e) {
      message = String(e);
    }
    expect(message).toMatch(/ALPACA_SECRET/);
    expect(message).not.toContain('super-secret-key-value');
  });
});
