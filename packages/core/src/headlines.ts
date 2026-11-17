/**
 * Headline selection for emails, code rules only (pure; no AI until Step 2):
 * 1. noise filter: blocked keyword patterns, plus stories tagged with 5+ tickers (roundups);
 * 2. dedupe: same URL, or a near-identical normalized title within 24 h — one story, every ticker;
 * 3. holdings: ranked by how many holdings a story mentions, then recency; at most `max`, each
 *    shown story covers at least one holding not covered yet ("+ n more X stories" for the rest);
 * 4. watchlist: story counts per ticker plus one top headline.
 */

export interface StoryInput {
  headline: string;
  url: string | null;
  /** Feed source, e.g. "alpaca:benzinga". */
  source: string;
  symbols: readonly string[];
  publishedAt: Date;
}

export interface Story {
  headline: string;
  url: string | null;
  source: string;
  symbols: string[];
  publishedAt: Date;
  /** Latest time any duplicate was published (recency ranking). */
  lastPublishedAt: Date;
  duplicates: number;
}

/** Blocked patterns (case-insensitive). Edit this list to tune the filter. */
export const NOISE_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  {
    label: 'entertainment',
    pattern:
      /\b(james bond|box office|oscars?|grammys?|emmys?|golden globes?|red carpet|celebrity|actor|actress|movie trailer|tv series|season finale|album|concert tour|taylor swift)\b/i,
  },
  { label: 'sports', pattern: /\b(nfl|nba|mlb|nhl|super bowl|world series|playoffs?)\b/i },
  {
    label: 'weekly roundup',
    pattern:
      /\((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\w* \d{1,2}\s*[-–]\s*(?:\w+ )?\d{1,2}\)/i,
  },
  {
    label: 'roundup',
    pattern:
      /\b(stocks? to watch|stocks? moving (?:in|after)|top (?:gainers|losers|movers)|(?:pre-?market|after-?hours|mid-?day) movers|biggest (?:movers|gainers|losers)|week in review|weekly recap|market wrap|morning brief(?:ing)?|earnings (?:preview|calendar|scheduled))\b/i,
  },
  {
    label: 'price chatter',
    pattern:
      /\b(what'?s going on with|why (?:is )?.{1,40} (?:stock|shares) (?:is |are )?(?:trading|moving|falling|rising|up|down|higher|lower)|unusual options activity|options? (?:alert|activity)|whale (?:alert|activity)|shares? (?:are )?trading (?:higher|lower))\b/i,
  },
];

export const ROUNDUP_MIN_TICKERS = 5;

/** Why a story is noise, or null. */
export function noiseReason(s: Pick<StoryInput, 'headline' | 'symbols'>): string | null {
  if (s.symbols.length >= ROUNDUP_MIN_TICKERS) return `roundup (${s.symbols.length} tickers)`;
  return NOISE_PATTERNS.find((p) => p.pattern.test(s.headline))?.label ?? null;
}

/** Lowercase, drop a trailing " - Source"/" | Source", punctuation and extra spaces. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+[-|–—]\s+[^-|–—]{1,40}$/, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9$%. ]+/g, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same normalized title, or ≥ 85% word overlap (Jaccard) for titles of 5+ words. */
export function similarTitles(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return true;
  const wa = new Set(na.split(' '));
  const wb = new Set(nb.split(' '));
  if (wa.size < 5 || wb.size < 5) return false;
  const inter = [...wa].filter((w) => wb.has(w)).length;
  return inter / (wa.size + wb.size - inter) >= 0.85;
}

const DAY_MS = 86_400_000;

/** Merges duplicates (same URL, or similar title within 24 h); the earliest copy is kept. */
export function dedupeStories(stories: readonly StoryInput[]): Story[] {
  const sorted = [...stories].sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
  const out: Story[] = [];
  for (const s of sorted) {
    const dup = out.find(
      (o) =>
        (s.url !== null && o.url === s.url) ||
        (Math.abs(s.publishedAt.getTime() - o.lastPublishedAt.getTime()) <= DAY_MS &&
          similarTitles(o.headline, s.headline)),
    );
    if (dup) {
      dup.symbols = [...new Set([...dup.symbols, ...s.symbols])];
      if (s.publishedAt > dup.lastPublishedAt) dup.lastPublishedAt = s.publishedAt;
      dup.duplicates += 1;
      continue;
    }
    out.push({
      headline: s.headline,
      url: s.url,
      source: s.source,
      symbols: [...new Set(s.symbols)],
      publishedAt: s.publishedAt,
      lastPublishedAt: s.publishedAt,
      duplicates: 0,
    });
  }
  return out;
}

export interface ShownStory {
  story: Story;
  /** Holdings it mentions, in the order given. */
  holdings: string[];
  /** Watchlist tickers it also mentions. */
  watchlist: string[];
  /** Single-holding stories: how many more stories only about that holding were left out. */
  moreForTicker: number;
}

export interface HeadlineSelection {
  shown: ShownStory[];
  /** Holding stories not shown. */
  more: number;
  filtered: { count: number; example: string | null };
  watchlist: { counts: { ticker: string; stories: number }[]; top: Story | null };
}

/** Picks the stories for an email (see the module comment for the rules). */
export function selectHeadlines(
  stories: readonly StoryInput[],
  opts: { holdings: readonly string[]; watchlist: readonly string[]; max?: number },
): HeadlineSelection {
  const max = opts.max ?? 6;
  const held = new Set(opts.holdings);
  const watched = new Set(opts.watchlist.filter((t) => !held.has(t)));
  const relevant = stories.filter((s) => s.symbols.some((t) => held.has(t) || watched.has(t)));

  const noise = relevant.filter((s) => noiseReason(s) !== null);
  const kept = dedupeStories(relevant.filter((s) => noiseReason(s) === null));

  const holdingsOf = (s: Story) => opts.holdings.filter((t) => s.symbols.includes(t));
  const ranked = kept
    .filter((s) => holdingsOf(s).length > 0)
    .sort(
      (a, b) =>
        holdingsOf(b).length - holdingsOf(a).length ||
        b.lastPublishedAt.getTime() - a.lastPublishedAt.getTime(),
    );

  const covered = new Set<string>();
  const shown: ShownStory[] = [];
  const skipped: Story[] = [];
  for (const s of ranked) {
    const h = holdingsOf(s);
    if (shown.length < max && h.some((t) => !covered.has(t))) {
      h.forEach((t) => covered.add(t));
      shown.push({
        story: s,
        holdings: h,
        watchlist: s.symbols.filter((t) => watched.has(t)),
        moreForTicker: 0,
      });
    } else {
      skipped.push(s);
    }
  }
  for (const sh of shown) {
    if (sh.holdings.length !== 1) continue;
    const [t] = sh.holdings;
    sh.moreForTicker = skipped.filter((s) => {
      const h = holdingsOf(s);
      return h.length === 1 && h[0] === t;
    }).length;
  }

  const counts = [...watched]
    .map((ticker) => ({ ticker, stories: kept.filter((s) => s.symbols.includes(ticker)).length }))
    .filter((c) => c.stories > 0)
    .sort((a, b) => b.stories - a.stories || a.ticker.localeCompare(b.ticker));
  const watchOnly = kept
    .filter((s) => holdingsOf(s).length === 0)
    .sort(
      (a, b) =>
        b.symbols.filter((t) => watched.has(t)).length -
          a.symbols.filter((t) => watched.has(t)).length ||
        b.lastPublishedAt.getTime() - a.lastPublishedAt.getTime(),
    );

  return {
    shown,
    more: ranked.length - shown.length,
    filtered: {
      count: noise.length,
      example:
        noise.find((s) => !noiseReason(s)!.startsWith('roundup ('))?.headline ??
        noise[0]?.headline ??
        null,
    },
    watchlist: { counts, top: watchOnly[0] ?? null },
  };
}

/** "benzinga.com" from a URL (null if none or unparsable). */
export function sourceDomain(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
