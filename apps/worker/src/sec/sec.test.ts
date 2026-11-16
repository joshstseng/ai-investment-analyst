import { describe, expect, it, vi } from 'vitest';
import { secRateLimiter, SecClient, type Submissions } from './client';
import { resolveCiks } from './ciks';
import { isTrackedForm, toFilingRows } from './filings';

describe('isTrackedForm', () => {
  it.each([
    '8-K',
    '8-K/A',
    '10-Q',
    '10-K',
    '10-K/A',
    'S-1',
    'S-1/A',
    'S-3',
    'S-3ASR',
    '424B2',
    '424B5',
    '4',
    '4/A',
  ])('tracks %s', (f) => expect(isTrackedForm(f)).toBe(true));
  it.each(['3', '5', 'SC 13G', 'DEF 14A', '6-K', '424B9', 'S-8', '8-K12B', 'N-CSR'])(
    'ignores %s',
    (f) => expect(isTrackedForm(f)).toBe(false),
  );
});

describe('toFilingRows', () => {
  const sub: Submissions = {
    cik: '123456',
    filings: {
      recent: {
        accessionNumber: [
          '0009999999-26-000123',
          '0000123456-26-000001',
          '0001193125-26-000002',
          'x',
        ],
        filingDate: ['2026-11-09', '2026-11-09', '2026-10-01', '2026-11-10'],
        acceptanceDateTime: [
          '2026-11-09T21:16:37.000Z',
          '2026-11-09T22:00:00.000Z',
          '2026-10-01T12:00:00.000Z',
          '2026-11-10T12:00:00.000Z',
        ],
        form: ['8-K', '4', '10-Q', '424B5'],
        items: ['5.02,7.01,9.01', '', '', ''],
        primaryDocument: ['acme8k.htm', 'form4.xml', 'q3.htm', ''],
      },
    },
  };
  const now = new Date('2026-11-15T00:00:00Z');
  const rows = toFilingRows(sub, {
    cik: '0000123456',
    ticker: 'ACMX',
    since: new Date('2026-10-15T00:00:00Z'),
    receivedAt: now,
    via: 'poll',
  });

  it('keeps tracked forms since the cutoff, with ticker, items and URL', () => {
    expect(rows.map((r) => r.form)).toEqual(['8-K', '4', '424B5']);
    expect(rows[0]).toMatchObject({
      accession: '0009999999-26-000123',
      cik: '0000123456',
      ticker: 'ACMX',
      items: ['5.02', '7.01', '9.01'],
      filingDate: '2026-11-09',
      filedAt: new Date('2026-11-09T21:16:37.000Z'),
      url: 'https://www.sec.gov/Archives/edgar/data/123456/000999999926000123/acme8k.htm',
      via: 'poll',
    });
  });

  it('falls back to the filing index when there is no primary document', () => {
    expect(rows[2]!.url).toBe('https://www.sec.gov/Archives/edgar/data/123456/x/x-index.htm');
    expect(rows[2]!.items).toEqual([]);
  });
});

describe('resolveCiks', () => {
  it('maps companies, marks ETFs not applicable and non-registrants as no data source', () => {
    const { found, statuses } = resolveCiks(
      ['ACMX', 'ETFX', 'OTCX'],
      { '0': { cik_str: 123456, ticker: 'ACMX', title: 'ACME CORP' } },
      { fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [[52848, 'S1', 'C1', 'ETFX']] },
    );
    expect(found).toEqual([
      { ticker: 'ACMX', cik: '0000123456', title: 'ACME CORP', kind: 'company' },
      { ticker: 'ETFX', cik: '0000052848', title: null, kind: 'fund' },
    ]);
    expect(statuses.map((s) => [s.symbol, s.status])).toEqual([
      ['ETFX', 'not_applicable'],
      ['OTCX', 'no_data_source'],
    ]);
  });
});

describe('SEC fair access', () => {
  it('never exceeds 10 requests in any 1-second window', async () => {
    let now = 0;
    const limiter = secRateLimiter(
      () => now,
      async (ms) => {
        now += ms;
      },
    );
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      await limiter.take();
      times.push(now);
    }
    const maxInWindow = Math.max(
      ...times.map((t) => times.filter((u) => u >= t && u < t + 1000).length),
    );
    expect(maxInWindow).toBeLessThanOrEqual(10);
  });

  it('sends the declared User-Agent on every request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}'));
    const sec = new SecClient('AIA test contact@example.com', { fetchImpl });
    await sec.companyTickers();
    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('AIA test contact@example.com');
  });
});
