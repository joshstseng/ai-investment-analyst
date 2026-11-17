import { decidePullback, type PriceMetrics, type PullbackState, type Scorecard } from '@aia/core';
import { MAX_HTML_BYTES, renderPullbackEmail } from '@aia/emails';
import { describe, expect, it } from 'vitest';
import type { PullbackResult } from './check';
import { loadPullbackConfig } from './config';
import {
  labelFor,
  pullbackBlock,
  pullbackEmails,
  pullbackSubject,
  startingListEmail,
  type AlertContext,
} from './email';
import { changeText } from './summary';

const cfg = loadPullbackConfig();
const date = '2026-11-17';

const sc: Scorecard = {
  currency: 'USD',
  periodEnd: '2026-09-30',
  annualOnly: false,
  revenueTtm: 4e10,
  revenueYoYPct: 18,
  revenueCagr3yPct: 15,
  grossMarginPct: 70,
  operatingMarginPct: 30,
  netMarginPct: 25,
  netIncomeTtm: 1e10,
  netIncomeAnnual: [
    { end: '2023-12-31', value: 6e9 },
    { end: '2024-12-31', value: 8e9 },
    { end: '2025-12-31', value: 9e9 },
  ],
  ocfTtm: 1.4e10,
  capexTtm: 2e9,
  fcfTtm: 1.2e10,
  fcfMarginPct: 30,
  cash: 2e10,
  debt: 5e9,
  netCash: 1.5e10,
  dilutedShares: 1e9,
  dilutionYoYPct: -1.5,
  epsTtm: 10,
  fcfPerShare: 12,
  peMedian: 27,
  pfcfMedian: 24,
  valuationPoints: 20,
  notes: [],
};

function metrics(price: number, over: Partial<PriceMetrics> = {}): PriceMetrics {
  const high52 = 250;
  return {
    asOfDate: date,
    price,
    intraday: true,
    prevClose: 205,
    high52,
    high52Date: '2026-07-15',
    low52: 150,
    low52Date: '2026-01-20',
    belowHighPct: Math.round((1 - price / high52) * 10000) / 100,
    d1Pct: Math.round(((price - 205) / 205) * 10000) / 100,
    d5Pct: -9.1,
    worstDropPct: -9.1,
    worstDropDays: 5,
    atr14: 6,
    ...over,
  };
}

const qualified = (tier: number): PullbackState => ({
  currentTier: tier,
  lastAlertedTier: tier,
  lastAlertedAt: '2026-11-10T21:20:00Z',
  lastAlertedCheck: 'eod',
  qualifiedSince: '2026-11-10',
  alertedOneDayDropDate: null,
});

function result(
  symbol: string,
  price: number,
  prev: PullbackState | null,
  over: Partial<PullbackResult> = {},
  check: 'open' | 'midday' = 'midday',
): PullbackResult {
  const m = metrics(price, over.metrics);
  return {
    symbol,
    sources: ['nasdaq100'],
    metrics: m,
    price: { value: price, at: new Date('2026-11-17T17:31:00Z'), source: 'alpaca:iex' },
    decision: decidePullback(prev, m, {
      check,
      date,
      now: new Date('2026-11-17T17:31:00Z'),
      rules: cfg,
    }),
    qualityPass: true,
    qualityReasons: [],
    scorecard: sc,
    marketCapUsd: 1.9e11,
    windowStart: null,
    ...over,
  };
}

const ctx: AlertContext = {
  names: new Map([['SFTX', 'Softex Corp']]),
  holdingsBy: new Map([['SFTX', ['Roth IRA 10 sh']]]),
  heldEtfs: ['ETFA', 'ETFB'],
  nextEarnings: new Map([
    [
      'SFTX',
      { date: '2027-01-28', timeOfDay: 'after_close', estimated: false, source: 'alphavantage' },
    ],
  ]),
  lastRelease: new Map([['SFTX', '2026-11-13']]),
  sessions: ['2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17'],
  headlines: new Map([
    [
      'SFTX',
      [
        {
          headline: 'Softex cuts outlook',
          url: 'https://news.example.com/1',
          publishedAt: new Date('2026-11-17T12:00:00Z'),
        },
      ],
    ],
  ]),
  cfg,
};

describe('pullback subjects', () => {
  it('pullback opportunity, with the check name', () => {
    const r = result('SFTX', 187.5, qualified(20)); // 25% below the high: deeper tier
    expect(pullbackSubject(r, 'midday')).toBe(
      '📝 [AIA] REVIEW Pullback opportunity – SFTX (−25% from high, Midday)',
    );
  });
  it('gap-down at the open', () => {
    const r = result('SFTX', 187.5, qualified(20), {}, 'open');
    expect(r.decision.alert?.gapDown).toBe(true); // 187.5 vs 205 = −8.5%
    expect(pullbackSubject(r, 'open')).toBe(
      '📝 [AIA] REVIEW Gap-down – SFTX −8.5% at open (−25% from high)',
    );
  });
});

describe('pullback alert block', () => {
  const b = pullbackBlock(
    result('SFTX', 187.5, qualified(20), { sources: ['nasdaq100', 'holding'] }),
    'midday',
    ctx,
  );

  it('headline, pills, price line with source and the intraday label', () => {
    expect(b.headline).toBe('25% below the 52-week high · crossed the −25% tier · down 8.5% today');
    expect(b.pills.map((p) => p.label)).toEqual([
      'deeper tier −25%',
      'one-day drop',
      'you hold it',
    ]);
    expect(b.priceLine).toBe(
      '12:31 PM ET · Alpaca IEX · Midday check · intraday, single venue, may differ from the close',
    );
  });

  it('holding, ETF exposure, earnings proximity and next earnings', () => {
    expect(b.holding).toBe('you hold it: Roth IRA 10 sh');
    expect(b.exposureNote).toContain('You already hold ETFA, ETFB');
    expect(b.earnings).toEqual([
      'Next earnings: Thu, Jan 28 after close (confirmed, Alpha Vantage)',
      '⚠️ The drop is 2 trading days after the earnings release filed Fri, Nov 13 (8-K item 2.02).',
    ]);
  });

  it('scorecard, bull evidence and exit levels with their basis', () => {
    expect(b.scorecard.find((s) => s.label === 'P/E')!.value).toBe('18.8 vs 5-yr median 27');
    expect(b.bull).toContain('P/E 19 vs 5-yr median 27');
    expect(b.bull).toContain('Net cash $15.0B');
    expect(b.exits).toEqual([
      {
        label: 'Risk stop',
        value: '$175.50',
        basis: 'price − 2×ATR14 (ATR14 $6.00; higher than the 52-week low $150.00)',
      },
      {
        label: 'Valuation trim',
        value: '$270.00',
        basis: 'P/E back to its own median 27.0 × TTM EPS $10.00',
      },
      { label: 'Re-underwrite', value: 'Thu, Jan 28', basis: 'next earnings report' },
    ]);
  });
});

describe('separate vs combined emails', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => result(`T${i}X`, 200 - i * 4, null));

  it('one email per ticker up to the limit', () => {
    const e = pullbackEmails(many(5), 'midday', date, ctx);
    expect(e).toHaveLength(5);
    expect(e[0]!.dedupeKey).toBe('pullback:2026-11-17:midday:T4X'); // most severe first
  });

  it('one combined email above it: full blocks for the most severe, a table for the rest', () => {
    const [e] = pullbackEmails(many(8), 'midday', date, ctx);
    expect(e!.dedupeKey).toBe('pullback:2026-11-17:midday:combined');
    expect(e!.props.subject).toBe(
      '📝 [AIA] REVIEW Pullback opportunities – 8 names (Midday): T7X, T6X, T5X, T4X, …',
    );
    expect(e!.props.blocks).toHaveLength(5);
    expect(e!.props.table!.rows.map((r) => r.ticker)).toEqual(['T2X', 'T1X', 'T0X']);
  });

  it('labels: passed, or which names failed quality', () => {
    const ok = result('AAAX', 180, null);
    const bad = result('BBBX', 180, null, { qualityPass: false, qualityReasons: ['TTM net loss'] });
    expect(labelFor([ok])).toMatch(
      /^Numbers check: passed\. Story check .* Research only, not an order\.$/,
    );
    expect(labelFor([ok, bad])).toMatch(/^Numbers check: passed, except BBBX/);
  });

  it('renders under the Gmail size limit (snapshot)', async () => {
    const [combined] = pullbackEmails(many(8), 'midday', date, ctx);
    const msg = await renderPullbackEmail(combined!.props);
    expect(Buffer.byteLength(msg.html)).toBeLessThan(MAX_HTML_BYTES);
    const single = await renderPullbackEmail(
      pullbackEmails(
        [result('SFTX', 187.5, qualified(20), { sources: ['nasdaq100', 'holding'] })],
        'midday',
        date,
        ctx,
      )[0]!.props,
    );
    await expect(single.html).toMatchFileSnapshot('./__snapshots__/pullback-single.html');
    await expect(single.text).toMatchFileSnapshot('./__snapshots__/pullback-single.txt');
    await expect(
      `${JSON.stringify(pullbackEmails([result('SFTX', 187.5, qualified(20))], 'midday', date, ctx)[0]!.props, null, 2)}\n`,
    ).toMatchFileSnapshot('../../../../packages/emails/preview/pullback-sample.json');
  });
});

describe('starting list (after the silent baseline)', () => {
  it('one compact email with everything that qualifies', () => {
    const rs = [result('AAAX', 150, null), result('BBBX', 240, null), result('CCCX', 190, null)];
    const e = startingListEmail(rs, '2026-11-16');
    expect(e.props.subject).toBe('📝 [AIA] REVIEW Pullback screen – starting list: 2 names');
    expect(e.props.blocks).toEqual([]);
    expect(e.props.table!.rows.map((r) => r.ticker)).toEqual(['AAAX', 'CCCX']);
  });
});

describe('summary wording', () => {
  it('describes what changed at a check', () => {
    expect(
      changeText({
        check: 'midday',
        alertKinds: ['deeper_tier', 'one_day_drop'],
        reversedTier: null,
        reset: false,
        tier: 25,
        d1Pct: '-7.40',
      }),
    ).toBe('Midday: deeper tier −25%, one-day drop -7.4%');
    expect(
      changeText({
        check: 'eod',
        alertKinds: [],
        reversedTier: 25,
        reset: false,
        tier: 20,
        d1Pct: '-1',
      }),
    ).toBe('Close: back above −25% by the close');
    expect(
      changeText({
        check: 'open',
        alertKinds: [],
        reversedTier: null,
        reset: false,
        tier: 20,
        d1Pct: '0',
      }),
    ).toBeNull();
  });
});
