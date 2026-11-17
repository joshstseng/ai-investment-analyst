/**
 * Portfolio math for emails (pure): day change, value and P/L, account tags,
 * lot lines and the order of "Needs attention" cards.
 */

export interface LotInput {
  account: string;
  quantity: number;
  avgCost: number;
  /** Broker total when known (more exact than quantity × avgCost). */
  costBasisTotal?: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---- Account tag and lot line -------------------------------------------------------------------

const ACCOUNT_TAG: Record<string, string> = { roth_ira: 'R', individual_taxable: 'I' };

/** "R", "I" or "R+I" (Roth first). */
export function accountTag(accounts: readonly string[]): string {
  const tags = [...new Set(accounts.map((a) => ACCOUNT_TAG[a] ?? a))];
  return tags.sort((a, b) => (a === 'R' ? -1 : b === 'R' ? 1 : a.localeCompare(b))).join('+');
}

const qty = (n: number) => (Number.isInteger(n) ? String(n) : String(round2(n)));

/**
 * Gray line under a multi-lot ticker: up to 2 lots in detail ("12 @ 70.10 · 9 @ 84.40"),
 * more as a summary ("3 lots · 140 sh"); null for a single lot.
 */
export function lotLine(lots: readonly Pick<LotInput, 'quantity' | 'avgCost'>[]): string | null {
  if (lots.length < 2) return null;
  if (lots.length === 2) {
    return lots.map((l) => `${qty(l.quantity)} @ ${l.avgCost.toFixed(2)}`).join(' · ');
  }
  const shares = lots.reduce((a, l) => a + l.quantity, 0);
  return `${lots.length} lots · ${qty(shares)} sh`;
}

// ---- Value and P/L ------------------------------------------------------------------------------

export interface PositionPL {
  shares: number;
  value: number;
  cost: number;
  plDollars: number;
  plPct: number | null;
}

/** Value at `close` and P/L vs cost basis, summed over lots (stocks/ETFs; multiplier 1). */
export function positionPL(lots: readonly LotInput[], close: number): PositionPL {
  const shares = lots.reduce((a, l) => a + l.quantity, 0);
  const cost = lots.reduce((a, l) => a + (l.costBasisTotal ?? l.quantity * l.avgCost), 0);
  const value = shares * close;
  return {
    shares,
    value: round2(value),
    cost: round2(cost),
    plDollars: round2(value - cost),
    plPct: cost > 0 ? round2(((value - cost) / cost) * 100) : null,
  };
}

export interface PortfolioLine {
  display: string;
  isOption: boolean;
  shares: number;
  close: number | null;
  prevClose: number | null;
}

export interface PortfolioDay {
  /** Sum of shares × (close − previous close) over stocks/ETFs with both closes. */
  change: number;
  /** change / previous value × 100. */
  pct: number | null;
  /** Value at today's close of the positions counted. */
  value: number;
  /** Options (no option prices) and positions without both closes. */
  excluded: { display: string; reason: 'option' | 'no price' }[];
}

/** Portfolio day change in $ and %: stocks and ETFs only, options excluded and listed. */
export function portfolioDay(lines: readonly PortfolioLine[]): PortfolioDay {
  let change = 0;
  let prevValue = 0;
  let value = 0;
  const excluded: PortfolioDay['excluded'] = [];
  for (const l of lines) {
    if (l.isOption) {
      excluded.push({ display: l.display, reason: 'option' });
      continue;
    }
    if (l.close === null || l.prevClose === null) {
      excluded.push({ display: l.display, reason: 'no price' });
      continue;
    }
    change += l.shares * (l.close - l.prevClose);
    prevValue += l.shares * l.prevClose;
    value += l.shares * l.close;
  }
  return {
    change: round2(change),
    pct: prevValue > 0 ? round2((change / prevValue) * 100) : null,
    value: round2(value),
    excluded,
  };
}

// ---- Needs-attention order ----------------------------------------------------------------------

export type AttentionTag = 'ACTION' | 'WARNING' | 'REVIEW' | 'REMINDER';

const TAG_RANK: Record<AttentionTag, number> = { ACTION: 0, WARNING: 1, REVIEW: 2, REMINDER: 3 };

export interface AttentionSortKey {
  tag: AttentionTag;
  /** Alerted today on an escalation (new tier, warning → stop, a further 2% move). */
  escalated: boolean;
  /** Alerted today at all (first alert or escalation); still-active-only conditions come after. */
  alertedToday: boolean;
  /** Full cards (levels) before one-line cards (day moves, new lows). */
  compact: boolean;
  dayPct: number | null;
  display: string;
}

/**
 * Most severe first: ACTION > WARNING > REVIEW > REMINDER; then escalated, then alerted today,
 * then full cards before compact ones, then the bigger day move, then alphabetical.
 */
export function byAttention(a: AttentionSortKey, b: AttentionSortKey): number {
  return (
    TAG_RANK[a.tag] - TAG_RANK[b.tag] ||
    Number(b.escalated) - Number(a.escalated) ||
    Number(b.alertedToday) - Number(a.alertedToday) ||
    Number(a.compact) - Number(b.compact) ||
    Math.abs(b.dayPct ?? 0) - Math.abs(a.dayPct ?? 0) ||
    a.display.localeCompare(b.display)
  );
}

// ---- Attention cards: compact vs full, range bar ------------------------------------------------

/** Rule types shown as one-line cards; everything else gets a full card. */
export const COMPACT_RULE_TYPES: ReadonlySet<string> = new Set([
  'day_move_pct',
  'new_52w_low',
  'close_below_cost',
  'date_reminder',
]);

export interface RangeEnd {
  label: string;
  value: number;
}

export interface AttentionRange {
  left: RangeEnd;
  right: RangeEnd;
  /** Where the close sits between left (0) and right (100), clamped. */
  markerPct: number;
}

export interface AttentionRangeInput {
  ruleType: string;
  /** The evaluation's observed values (high, tiers, level, triggerLevel, …). */
  observed: Record<string, unknown>;
  close: number;
  /** Other levels on the instrument, for the far end of the bar. */
  stops: readonly number[];
  takeProfits: readonly number[];
  /** Average cost per share (stocks/ETFs), if held. */
  avgCost: number | null;
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Range bar for a full card: stop ↔ take-profit (or cost), deepest drawdown tier ↔ 52-week high,
 * 52-week low ↔ cost. Null when the rule has no meaningful range.
 */
export function attentionRange(i: AttentionRangeInput): AttentionRange | null {
  const o = i.observed;
  let left: RangeEnd | null;
  let right: RangeEnd | null;
  const tpAbove = i.takeProfits.filter((t) => t > i.close).sort((a, b) => a - b)[0];
  const farEnd = (from: number): RangeEnd | null =>
    tpAbove !== undefined
      ? { label: 'take-profit', value: tpAbove }
      : i.avgCost !== null && i.avgCost > from
        ? { label: 'cost', value: i.avgCost }
        : null;

  switch (i.ruleType) {
    case 'etf_drawdown_from_52w_high': {
      const high = n(o.high);
      const tiers = Array.isArray(o.tiers)
        ? (o.tiers as unknown[]).map(n).filter((t) => t !== null)
        : [];
      if (high === null || tiers.length === 0) return null;
      const deepest = Math.max(...(tiers as number[]));
      left = { label: `${deepest}%`, value: round2(high * (1 - deepest / 100)) };
      right = { label: 'high', value: high };
      break;
    }
    case 'stop_close_below':
    case 'trailing_close_pct_from_high': {
      const level = n(o.level) ?? n(o.triggerLevel);
      if (level === null) return null;
      left = {
        label: i.ruleType === 'stop_close_below' ? 'stop' : 'trailing stop',
        value: round2(level),
      };
      right = farEnd(level);
      break;
    }
    case 'take_profit_at_or_above': {
      const level = n(o.level);
      if (level === null) return null;
      const stop = i.stops.filter((s) => s < i.close).sort((a, b) => b - a)[0];
      left =
        stop !== undefined
          ? { label: 'stop', value: stop }
          : i.avgCost !== null && i.avgCost < level
            ? { label: 'cost', value: i.avgCost }
            : null;
      right = { label: 'take-profit', value: level };
      break;
    }
    case 'new_52w_low': {
      left = { label: 'low', value: i.close };
      right =
        i.avgCost !== null && i.avgCost > i.close ? { label: 'cost', value: i.avgCost } : null;
      break;
    }
    default:
      return null;
  }
  if (!left || !right || right.value <= left.value) return null;
  const markerPct = ((i.close - left.value) / (right.value - left.value)) * 100;
  return { left, right, markerPct: Math.round(Math.min(100, Math.max(0, markerPct))) };
}
