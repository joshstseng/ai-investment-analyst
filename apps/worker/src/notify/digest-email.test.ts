import { MAX_HTML_BYTES } from '@aia/emails';
import { describe, expect, it } from 'vitest';
import { composeDigest, digestEmailProps, digestPreviewText, digestSubject } from './digest-email';
import { sampleDigest } from './digest-fixture';

const opts = { barsFeed: 'sip' };

describe('digest subject and inbox preview', () => {
  it('formats the subject with the emoji, date, portfolio % and alert count', () => {
    expect(digestSubject(sampleDigest())).toBe('📊 [AIA] DIGEST Nov 16 · −3.0% · 4 alerts');
    const quiet = {
      ...sampleDigest(),
      alertsToday: ['x'],
      portfolio: { change: 0, pct: null, value: 0, excluded: [] },
    };
    expect(digestSubject(quiet)).toBe('📊 [AIA] DIGEST Nov 16 · 1 alert');
  });

  it('previews the top attention items and an earnings 8-K', () => {
    expect(digestPreviewText(sampleDigest())).toBe(
      'CNFX at warning level · ETFX 17.5% off high · IDXQ 13.2% off high · ACMX results 8-K',
    );
    const calm = { ...sampleDigest(), attention: [], filingList: [] };
    expect(digestPreviewText(calm)).toBe('No alerts or active conditions · portfolio −3.0%');
  });
});

describe('digest props', () => {
  const p = digestEmailProps(sampleDigest(), opts);

  it('KPI tiles: portfolio day change, alerts with severity mix, active conditions, filings', () => {
    expect(p.kpis.map((k) => [k.label, k.value, k.sub])).toEqual([
      ['Portfolio today', '−$1,203', '−3.0% · value $39,408'],
      ['Alerts', '4', '1 ⚠️ · 3 📝'],
      ['Active', '1', 'still active'],
      ['Filings', '7', '1 earnings 8-K'],
    ]);
  });

  it('cards: alerted today vs still active; full cards with range and position, compact one-liners', () => {
    expect(p.alerts.map((a) => a.ticker)).toEqual(['CNFX', 'ETFX', 'MOVX', 'SPCQ']);
    expect(p.active.map((a) => a.ticker)).toEqual(['IDXQ']);
    const [cnfx, etfx, movx, spcq] = p.alerts;
    const [idxq] = p.active;
    expect(cnfx).toMatchObject({
      severity: 'warning',
      body: 'Closed at $49.60, at or below the $50.00 warning level (stop $46.30).',
      range: { left: 'stop $46.30', right: 'take-profit $64.00', markerPct: 19 },
      pills: [{ label: 'confirmed', tone: 'neutral' }],
    });
    expect(etfx).toMatchObject({
      body: '17.5% below the 52-week high ($120.00), crossing the 15% tier. Next tier (20%) at $96.00.',
      pills: [
        { label: 'placeholder', tone: 'neutral' },
        { label: 'escalated', tone: 'escalated' },
      ],
      position: {
        lead: 'Your position: 140 sh across 3 lots',
        pl: { dollars: -742, pct: -5.08 },
        tail: '36% of portfolio',
      },
    });
    expect(idxq!.pills).toContainEqual({ label: 'active since Nov 13', tone: 'neutral' });
    expect(movx).toMatchObject({
      compact: true,
      body: 'one-day move past ±7%',
      position: { lead: 'position' },
    });
    expect(spcq!.body).toBe('new 52-week closing low (was $4.50)');
  });

  it('positions table: stocks/ETFs only, by day %; options and untracked go to the gray box', () => {
    expect(p.positions.map((r) => r.ticker)).toEqual([
      'GAINX',
      'LOTX',
      'CNFX',
      'IDXQ',
      'ETFX',
      'SPCQ',
      'MOVX',
    ]);
    expect(p.positions.find((r) => r.ticker === 'GAINX')!.next).toEqual({
      text: 'warning $39.40 · 6.2%',
      pill: 'draft',
      near: true,
    });
    expect(p.positions.find((r) => r.ticker === 'ETFX')!.next!.text).toBe('20% tier $96.00 · 3.0%');
    expect(p.positions.find((r) => r.ticker === 'LOTX')!.next).toMatchObject({ near: false });
    expect(p.positions.find((r) => r.ticker === 'SPCQ')!.next).toEqual({
      text: 'at 52w low',
      near: true,
    });
    expect(p.positions.find((r) => r.ticker === 'MOVX')!.next).toBeNull();
    expect(p.optionsBox).toEqual([
      'OPTX Jan-21-2028 $40 call · OPTX $48.00 +0.4%, 20.0% above strike',
      'OTCQ · no data source · 💡 Dec 15: Tax checkpoint: decide sell-for-loss; no rebuy…',
    ]);
  });

  it('filings, headlines and footer', () => {
    expect(p.filings[0]).toMatchObject({
      title: '8-K · results',
      strong: true,
      detail: '(Item 2.02) · Mon 1:06 PM',
    });
    expect(p.filings[2]!.lines).toEqual([
      'Jane Q Doe (CFO) sold 5,000 sh @ $51.10 avg ($255,500) · 10b5-1 plan',
    ]);
    expect(p.filings[3]!.tickers).toEqual(['GAINX', 'MOVX', 'OPTX ×3']);
    expect(p.headlines.items[1]).toMatchObject({
      source: 'news.example.org',
      day: 'Mon',
      extra: '+3 more MOVX stories',
    });
    expect(p.headlines.notes).toEqual([
      '+ 12 more holding headlines',
      '5 filtered as noise (e.g. "Top Stocks to Watch After Weekend Chaos")',
    ]);
    expect(p.headlines.watchlist).toBe(
      'WTCH 16 · WTCQ 2 · top: Chipmakers fail to dismiss price-fixing suit',
    );
    expect(p.footer).toEqual([
      '🩺 Feeds OK · prices: Alpaca SIP daily bars · filings: SEC EDGAR · news: Benzinga',
      'Not checked: OTCQ day move, OPTX280121C00040000 option value (no data source) · CNFX trailing stop (not started yet)',
      'Close of Mon, Nov 16 · news & filings since Fri 2:15 PM PT · generated Mon 2:15 PM PT',
    ]);
    expect(p.weekly).toBeNull();
  });

  it('adds rules to write and missing input on the last session of the week', () => {
    expect(digestEmailProps(sampleDigest(true), opts).weekly).toEqual({
      rulesToWrite: ['MOVX (risk stop, take profit)'],
      needsInput: ['GAINX: why i own it'],
    });
  });
});

describe('digest email (rendered)', () => {
  it('matches the HTML and text snapshots and stays email-safe', async () => {
    const msg = await composeDigest(sampleDigest(true), opts);
    expect(msg.trimmed).toBe(false);
    expect(msg.html).toContain('CNFX at warning level · ETFX 17.5% off high');
    expect(msg.html).not.toMatch(/<img|<svg|<script|<link[^>]+stylesheet/i);
    expect(Buffer.byteLength(msg.html)).toBeLessThan(MAX_HTML_BYTES);
    await expect(msg.html).toMatchFileSnapshot('./__snapshots__/digest.html');
    await expect(msg.text).toMatchFileSnapshot('./__snapshots__/digest.txt');
    // The same props are the dev server's sample (pnpm email:preview without local data).
    await expect(`${JSON.stringify(msg.props, null, 2)}\n`).toMatchFileSnapshot(
      '../../../../packages/emails/preview/digest-sample.json',
    );
  });

  it('stays under the Gmail clipping guard on a very busy day', async () => {
    const d = sampleDigest(true);
    const many = <T>(xs: T[], n: number) => Array.from({ length: n }, (_, i) => xs[i % xs.length]!);
    const busy = {
      ...d,
      positions: many(d.positions, 40).map((p, i) => ({
        ...p,
        display: `${p.display}${i}`,
        symbol: `${p.symbol}${i}`,
      })),
      attention: many(d.attention, 25),
      filingList: many(d.filingList, 30),
      levelsToWatch: many(d.levelsToWatch, 15),
    };
    const msg = await composeDigest(busy, opts);
    expect(msg.trimmed).toBe(true); // the full layout would be clipped → one-line cards, capped lists
    expect(Buffer.byteLength(msg.html)).toBeLessThan(MAX_HTML_BYTES);
    expect(msg.html).toContain('+ 18 more filings (see EDGAR)');
  });
});
