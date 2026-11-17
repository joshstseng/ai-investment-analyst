/**
 * Pullback screen, price side (pure). Inputs are completed daily sessions (official closes),
 * oldest first. Intraday checks pass a live price for today's still-open session; the EOD check
 * passes none and uses the last close.
 */
import { addDays } from './time';

export interface PriceBar {
  date: string;
  high: number;
  low: number;
  close: number;
}

export interface PriceMetrics {
  /** Today (intraday checks) or the last session's date (EOD). */
  asOfDate: string;
  price: number;
  /** True when `price` is a live intraday trade rather than an official close. */
  intraday: boolean;
  prevClose: number;
  /** 52-week intraday high/low (including the live price when intraday). */
  high52: number;
  high52Date: string;
  low52: number;
  low52Date: string;
  /** How far below the 52-week high, as a positive % (0 at a new high). */
  belowHighPct: number;
  /** Change vs the previous close (%). */
  d1Pct: number;
  /** Change vs the close 5 sessions earlier (%), null with too little history. */
  d5Pct: number | null;
  /** Worst change vs any close 1..window sessions earlier (%), and how many sessions back. */
  worstDropPct: number;
  worstDropDays: number;
  /** Wilder ATR(14) on completed sessions; null with fewer than 15 bars. */
  atr14: number | null;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const pctChange = (from: number, to: number) => ((to - from) / from) * 100;

/** Wilder's average true range over completed bars (oldest first). */
export function atr(bars: readonly PriceBar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const pc = bars[i - 1]!.close;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }
  let value = tr.slice(0, period).reduce((a, x) => a + x, 0) / period;
  for (let i = period; i < tr.length; i++) value = (value * (period - 1) + tr[i]!) / period;
  return round(value, 4);
}

/**
 * Price metrics for one symbol. `live` (intraday checks) is today's latest trade; without it
 * the last bar is "today". Returns null with fewer than 2 sessions of history.
 */
export function priceMetrics(
  bars: readonly PriceBar[],
  opts: {
    live?: { price: number; date: string } | null;
    dropWindowDays?: number;
    /** The 52-week window starts no earlier than this date (e.g. a spin-off's ex-date). */
    windowStart?: string | null;
  } = {},
): PriceMetrics | null {
  const window = opts.dropWindowDays ?? 5;
  const live = opts.live ?? null;
  // Sessions strictly before "today", and today's price.
  const history = live ? bars.filter((b) => b.date < live.date) : bars.slice(0, -1);
  const todayBar = live ? null : bars.at(-1);
  if (history.length < 1 || (!live && !todayBar)) return null;
  const price = live ? live.price : todayBar!.close;
  const asOfDate = live ? live.date : todayBar!.date;
  const prevClose = history.at(-1)!.close;

  const yearAgo = addDays(asOfDate, -365);
  // After a spin-off, pre-spin prices aren't comparable: the window starts at the ex-date.
  const since =
    opts.windowStart && opts.windowStart > yearAgo ? addDays(opts.windowStart, -1) : yearAgo;
  const inWindow = [...history, ...(todayBar ? [todayBar] : [])].filter((b) => b.date > since);
  let high52 = -Infinity;
  let high52Date = asOfDate;
  let low52 = Infinity;
  let low52Date = asOfDate;
  for (const b of inWindow) {
    if (b.high > high52) [high52, high52Date] = [b.high, b.date];
    if (b.low < low52) [low52, low52Date] = [b.low, b.date];
  }
  if (live) {
    if (price > high52) [high52, high52Date] = [price, asOfDate];
    if (price < low52) [low52, low52Date] = [price, asOfDate];
  }

  let worstDropPct = Infinity;
  let worstDropDays = 1;
  for (let k = 1; k <= window && k <= history.length; k++) {
    const change = pctChange(history[history.length - k]!.close, price);
    if (change < worstDropPct) [worstDropPct, worstDropDays] = [change, k];
  }
  const d5Base = history.length >= 5 ? history[history.length - 5]!.close : null;

  return {
    asOfDate,
    price,
    intraday: !!live,
    prevClose,
    high52,
    high52Date,
    low52,
    low52Date,
    belowHighPct: round(Math.max(0, (1 - price / high52) * 100)),
    d1Pct: round(pctChange(prevClose, price)),
    d5Pct: d5Base === null ? null : round(pctChange(d5Base, price)),
    worstDropPct: round(worstDropPct),
    worstDropDays,
    atr14: atr([...history, ...(todayBar ? [todayBar] : [])]),
  };
}
