/** Which symbols we collect data for, derived from holdings and the watchlist. */
import { holdings, instruments, watchlist, type Db } from '@aia/db';
import { ne } from 'drizzle-orm';

export const BENCHMARKS = ['SPY', 'QQQ'] as const;

export interface UniverseInstrument {
  symbol: string;
  instrumentType: 'stock' | 'etf' | 'otc_stock' | 'option';
  underlyingSymbol: string | null;
  held: boolean;
  watched: boolean;
}

export interface Universe {
  /** Equity symbols to fetch bars and quotes for (option underlyings included, plus benchmarks). */
  priceSymbols: string[];
  /** Symbols to fetch news for (benchmarks only if held or watched). */
  newsSymbols: string[];
  /** Option contracts we hold; Step 1 collects no option prices for these. */
  optionContracts: { symbol: string; underlying: string }[];
}

export function buildUniverse(
  list: readonly UniverseInstrument[],
  benchmarks: readonly string[] = BENCHMARKS,
): Universe {
  const prices = new Set<string>(benchmarks);
  const news = new Set<string>();
  const optionContracts: Universe['optionContracts'] = [];
  for (const i of list) {
    if (!i.held && !i.watched) continue;
    if (i.instrumentType === 'option') {
      if (!i.underlyingSymbol) throw new Error(`option ${i.symbol} has no underlying`);
      prices.add(i.underlyingSymbol);
      news.add(i.underlyingSymbol);
      if (i.held) optionContracts.push({ symbol: i.symbol, underlying: i.underlyingSymbol });
    } else {
      prices.add(i.symbol);
      news.add(i.symbol);
    }
  }
  const sorted = (s: Set<string>) => [...s].sort();
  return { priceSymbols: sorted(prices), newsSymbols: sorted(news), optionContracts };
}

export async function loadUniverse(db: Db): Promise<Universe> {
  const [all, held, watched] = await Promise.all([
    db.select().from(instruments),
    db
      .selectDistinct({ id: holdings.instrumentId })
      .from(holdings)
      .where(ne(holdings.status, 'closed')),
    db.select({ id: watchlist.instrumentId }).from(watchlist),
  ]);
  const heldIds = new Set(held.map((h) => h.id));
  const watchedIds = new Set(watched.map((w) => w.id));
  return buildUniverse(
    all.map((i) => ({
      symbol: i.symbol,
      instrumentType: i.instrumentType,
      underlyingSymbol: i.underlyingSymbol,
      held: heldIds.has(i.id),
      watched: watchedIds.has(i.id),
    })),
  );
}
