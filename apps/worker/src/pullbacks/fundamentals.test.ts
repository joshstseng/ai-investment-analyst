import { describe, expect, it } from 'vitest';
import type { CompanyFactsJson, Submissions } from '../sec/client';
import { extractCompanyFacts, lastEarningsRelease, mergeFacts } from './fundamentals';

const fact = (end: string, val: number, extra: Record<string, unknown> = {}) => ({
  start: `${end.slice(0, 4)}-01-01`,
  end,
  val,
  form: '10-K',
  filed: `${Number(end.slice(0, 4)) + 1}-02-01`,
  ...extra,
});

describe('extractCompanyFacts', () => {
  const json: CompanyFactsJson = {
    cik: 1,
    entityName: 'Acme Corp',
    facts: {
      'us-gaap': {
        Revenues: { units: { USD: [fact('2024-12-31', 90), fact('2025-12-31', 100)] } },
        // Newer concept for the same periods: preferred.
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          units: { USD: [fact('2025-12-31', 101)] },
        },
        NetIncomeLoss: {
          units: { USD: [fact('2025-12-31', 10), fact('2015-12-31', 1)] }, // 2015: too old, dropped
        },
        WeightedAverageNumberOfDilutedSharesOutstanding: {
          units: { shares: [fact('2025-12-31', 5)] },
        },
      },
    },
  };

  it('picks US GAAP, the reporting currency, merges concepts and trims old history', () => {
    const f = extractCompanyFacts(json, '2026-11-17')!;
    expect(f.taxonomy).toBe('us-gaap');
    expect(f.currency).toBe('USD');
    expect(f.series.revenue!.map((x) => [x.end, x.val])).toEqual([
      ['2024-12-31', 90],
      ['2025-12-31', 101],
    ]);
    expect(f.series.netIncome!.map((x) => x.val)).toEqual([10]);
    expect(f.series.dilutedShares!.map((x) => x.val)).toEqual([5]);
  });

  it('uses IFRS (and its currency) when there is no US GAAP', () => {
    const ifrs: CompanyFactsJson = {
      cik: 2,
      facts: {
        'ifrs-full': {
          ProfitLossAttributableToOwnersOfParent: {
            units: {
              TWD: [
                fact('2024-12-31', 50, { form: '20-F' }),
                fact('2023-12-31', 40, { form: '20-F' }),
              ],
              USD: [fact('2024-12-31', 2, { form: '20-F' })],
            },
          },
        },
      },
    };
    expect(extractCompanyFacts(ifrs, '2026-11-17')).toMatchObject({
      taxonomy: 'ifrs-full',
      currency: 'TWD',
    });
    expect(extractCompanyFacts({ cik: 3, facts: { dei: {} } }, '2026-11-17')).toBeNull();
  });
});

describe('mergeFacts (predecessor registrant)', () => {
  it('fills history from the earlier CIK; the current one wins on the same period', () => {
    const cur = {
      taxonomy: 'us-gaap' as const,
      currency: 'USD',
      series: { netIncome: [fact('2026-12-31', 7)] },
    };
    const old = {
      taxonomy: 'us-gaap' as const,
      currency: 'USD',
      series: {
        netIncome: [fact('2025-12-31', 6), fact('2026-12-31', 999)],
        revenue: [fact('2025-12-31', 60)],
      },
    };
    const m = mergeFacts(cur, old);
    expect(m.series.netIncome!.map((x) => [x.end, x.val])).toEqual([
      ['2025-12-31', 6],
      ['2026-12-31', 7],
    ]);
    expect(m.series.revenue).toHaveLength(1);
  });
});

describe('lastEarningsRelease', () => {
  it('latest 8-K with item 2.02', () => {
    const s: Submissions = {
      cik: '1',
      filings: {
        recent: {
          accessionNumber: ['a', 'b', 'c', 'd'],
          filingDate: ['2026-10-28', '2026-10-27', '2026-07-29', '2026-09-01'],
          acceptanceDateTime: ['', '', '', ''],
          form: ['10-Q', '8-K', '8-K', '8-K'],
          items: ['', '2.02,9.01', '2.02', '5.02'],
          primaryDocument: ['', '', '', ''],
        },
      },
    };
    expect(lastEarningsRelease(s)).toBe('2026-10-27');
  });
});
