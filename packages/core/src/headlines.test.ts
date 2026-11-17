import { describe, expect, it } from 'vitest';
import {
  dedupeStories,
  noiseReason,
  normalizeTitle,
  selectHeadlines,
  similarTitles,
  sourceDomain,
  type StoryInput,
} from './headlines';

const t0 = new Date('2026-11-16T15:00:00Z');
const at = (hours: number) => new Date(t0.getTime() + hours * 3_600_000);
const story = (
  headline: string,
  symbols: string[],
  hours = 0,
  url: string | null = null,
): StoryInput => ({
  headline,
  url,
  source: 'alpaca:benzinga',
  symbols,
  publishedAt: at(hours),
});

describe('noise filter', () => {
  it.each<[string, string[], string | null]>([
    ['Famous actor named as new James Bond', ['ACMX'], 'entertainment'],
    ['Consumer Tech (Nov 9-13): earnings recap', ['ACMX'], 'weekly roundup'],
    ['5 stocks to watch this week', ['ACMX'], 'roundup'],
    ["What's Going On With Acme Stock?", ['ACMX'], 'price chatter'],
    ['Why Acme shares are trading lower today', ['ACMX'], 'price chatter'],
    ['Market movers', ['A', 'B', 'C', 'D', 'E'], 'roundup (5 tickers)'],
    ['Acme signs supply agreement with Widget Co', ['ACMX', 'WDGT'], null],
    ['Acme reports third-quarter results', ['ACMX'], null],
  ])('%s → %s', (headline, symbols, reason) => {
    expect(noiseReason({ headline, symbols })).toBe(reason);
  });
});

describe('dedupe', () => {
  it('normalizes titles (case, punctuation, trailing source)', () => {
    expect(normalizeTitle('Acme Wins $1.2B Contract — Reuters')).toBe('acme wins $1.2b contract');
    expect(similarTitles('Acme wins $1.2B Army contract', 'ACME WINS $1.2B ARMY CONTRACT!')).toBe(
      true,
    );
    expect(similarTitles('Acme wins contract', 'Acme loses contract')).toBe(false);
  });

  it('merges same URL or near-identical titles within 24 h, keeping every ticker', () => {
    const out = dedupeStories([
      story(
        'Regulators propose new export rules for widget makers',
        ['ACMX'],
        0,
        'https://a.example/1',
      ),
      story('Regulators propose new export rules for widget makers', ['BKX'], 3),
      story('Different headline, same link', ['ETFX'], 5, 'https://a.example/1'),
      story('Regulators propose new export rules for widget makers', ['LATE'], 30),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ symbols: ['ACMX', 'BKX', 'ETFX'], duplicates: 2 });
    expect(out[0]!.lastPublishedAt).toEqual(at(5));
    expect(out[1]!.symbols).toEqual(['LATE']); // 30 h after the last copy → a new story
  });
});

describe('selectHeadlines', () => {
  const holdings = ['ACMX', 'BKX', 'ETFX', 'SPCQ'];
  const watchlist = ['WTCH', 'WTCQ'];

  it('ranks by holdings mentioned, then recency; each shown story covers a new holding', () => {
    const sel = selectHeadlines(
      [
        story('Export rules hit widget makers', ['ACMX', 'BKX', 'WTCH'], 1),
        story('Launch vehicle investigation continues', ['SPCQ'], 4),
        story('Launch company hires new CFO', ['SPCQ'], 3),
        story('Launch company schedules next test', ['SPCQ'], 2),
        story('Acme opens new plant', ['ACMX'], 5), // ACMX already covered → skipped
        story('Watchlist chipmaker sued', ['WTCH'], 6),
        story('Second watchlist story', ['WTCH', 'WTCQ'], 2),
        story('Famous actor named as new James Bond', ['BKX'], 1),
        story('Unrelated company news', ['ZZZ'], 1),
      ],
      { holdings, watchlist, max: 6 },
    );
    expect(
      sel.shown.map((s) => [s.story.headline, s.holdings, s.watchlist, s.moreForTicker]),
    ).toEqual([
      ['Export rules hit widget makers', ['ACMX', 'BKX'], ['WTCH'], 0],
      ['Launch vehicle investigation continues', ['SPCQ'], [], 2],
    ]);
    expect(sel.more).toBe(3);
    expect(sel.filtered).toEqual({ count: 1, example: 'Famous actor named as new James Bond' });
    expect(sel.watchlist.counts).toEqual([
      { ticker: 'WTCH', stories: 3 },
      { ticker: 'WTCQ', stories: 1 },
    ]);
    expect(sel.watchlist.top!.headline).toBe('Second watchlist story'); // 2 watchlist tickers
  });

  it('caps the holdings list at max', () => {
    const many = Array.from({ length: 10 }, (_, i) => story(`Story number ${i}`, [`H${i}`], i));
    const sel = selectHeadlines(many, {
      holdings: many.map((s) => s.symbols[0]!),
      watchlist: [],
      max: 6,
    });
    expect(sel.shown).toHaveLength(6);
    expect(sel.shown[0]!.story.headline).toBe('Story number 9'); // most recent first
    expect(sel.more).toBe(4);
  });

  it('extracts the source domain', () => {
    expect(sourceDomain('https://www.benzinga.com/news/1')).toBe('benzinga.com');
    expect(sourceDomain(null)).toBeNull();
    expect(sourceDomain('not a url')).toBeNull();
  });
});
