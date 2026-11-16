/**
 * Pre-market prices. Alpaca's free plan serves SIP (all exchanges) 15+ minutes late, which has
 * the full 4:00 AM ET pre-market; IEX is real-time but sparse before the open. We use the last
 * SIP 1-minute bar up to now − 16 min, falling back to IEX if SIP is refused. Symbols with no
 * pre-market trades yet show only the last close.
 */
import type { AlpacaBar } from '../alpaca/schemas';
import { isSubscriptionError, type AlpacaClient, type Feed } from '../alpaca/client';
import { BAR_SETTLE_MS } from '../market/bars';

export interface PremarketQuote {
  symbol: string;
  lastClose: number | null;
  /** Last pre-market trade price, or null if there were no pre-market trades. */
  price: number | null;
  /** Time of that bar (UTC). */
  at: Date | null;
  changePct: number | null;
  volume: number;
  feed: Feed | null;
}

/** Last bar strictly before the regular open (pure). */
export function premarketQuote(
  symbol: string,
  bars: readonly AlpacaBar[],
  lastClose: number | null,
  openAt: Date,
  feed: Feed,
): PremarketQuote {
  const pre = bars.filter((b) => new Date(b.t) < openAt);
  const last = pre.at(-1);
  const price = last ? last.c : null;
  return {
    symbol,
    lastClose,
    price,
    at: last ? new Date(last.t) : null,
    changePct:
      price !== null && lastClose
        ? Math.round(((price - lastClose) / lastClose) * 10000) / 100
        : null,
    volume: pre.reduce((a, b) => a + b.v, 0),
    feed: last ? feed : null,
  };
}

export async function fetchPremarket(
  client: AlpacaClient,
  p: {
    symbols: readonly string[];
    lastCloses: ReadonlyMap<string, number>;
    /** Today's extended session start (4:00 AM ET) and regular open (9:30 AM ET). */
    sessionOpenAt: Date;
    openAt: Date;
    now: Date;
  },
): Promise<{ quotes: PremarketQuote[]; feed: Feed; asOf: Date }> {
  const sipEnd = new Date(Math.min(p.now.getTime() - BAR_SETTLE_MS, p.openAt.getTime() - 1));
  let feed: Feed = 'sip';
  let end = sipEnd;
  let bars: Map<string, AlpacaBar[]>;
  try {
    bars = await client.minuteBars({
      symbols: p.symbols,
      start: p.sessionOpenAt.toISOString(),
      end: end.toISOString(),
      feed,
    });
  } catch (error) {
    if (!isSubscriptionError(error)) throw error;
    feed = 'iex';
    end = new Date(Math.min(p.now.getTime(), p.openAt.getTime() - 1));
    bars = await client.minuteBars({
      symbols: p.symbols,
      start: p.sessionOpenAt.toISOString(),
      end: end.toISOString(),
      feed,
    });
  }
  return {
    feed,
    asOf: end,
    quotes: p.symbols.map((s) =>
      premarketQuote(s, bars.get(s) ?? [], p.lastCloses.get(s) ?? null, p.openAt, feed),
    ),
  };
}
