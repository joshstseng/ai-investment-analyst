/**
 * Shared output for external research agents: the qualifying names from the latest pullback
 * check (tier, check name, timestamps, price with source, metrics, episode state, scorecard),
 * as JSON or CSV. Served by `pnpm collect pullback-export` and GET /pullbacks.json|csv.
 */
import { pullbackObservations, pullbackState, type Db } from '@aia/db';
import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import { INTRADAY_LABEL } from './prices';

export interface PullbackExportItem {
  symbol: string;
  date: string;
  check: string;
  checkedAt: string;
  price: number;
  priceAt: string;
  priceSource: string;
  intraday: boolean;
  prevClose: number;
  high52: number;
  high52Date: string;
  low52: number;
  belowHighPct: number;
  d1Pct: number;
  d5Pct: number | null;
  worstDropPct: number;
  worstDropDays: number;
  atr14: number | null;
  tier: number | null;
  reasons: string[];
  gapDown: boolean;
  qualityPass: boolean | null;
  alertKinds: string[];
  qualifiedSince: string | null;
  lastAlertedTier: number | null;
  scorecard: Record<string, unknown> | null;
}

export interface PullbackExport {
  generatedAt: string;
  date: string | null;
  check: string | null;
  note: string;
  items: PullbackExportItem[];
}

const n = (v: string | null) => (v === null ? null : Number(v));

/** Qualifying names at the latest check on or before `date` (default: the latest check). */
export async function buildPullbackExport(
  db: Db,
  opts: { date?: string } = {},
): Promise<PullbackExport> {
  const [last] = await db
    .select({ date: pullbackObservations.date, check: pullbackObservations.check })
    .from(pullbackObservations)
    .where(opts.date ? lte(pullbackObservations.date, opts.date) : undefined)
    .orderBy(desc(pullbackObservations.checkedAt))
    .limit(1);
  const base = {
    generatedAt: new Date().toISOString(),
    note: `Research only, not an order. Intraday prices are ${INTRADAY_LABEL}; EOD prices are official closes. Story check (cause of drop, guidance, thesis) pending.`,
  };
  if (!last) return { ...base, date: null, check: null, items: [] };
  const rows = await db
    .select()
    .from(pullbackObservations)
    .where(
      and(
        eq(pullbackObservations.date, last.date),
        eq(pullbackObservations.check, last.check),
        eq(pullbackObservations.qualifies, true),
      ),
    )
    .orderBy(desc(pullbackObservations.belowHighPct));
  const states = rows.length
    ? await db
        .select()
        .from(pullbackState)
        .where(
          inArray(
            pullbackState.symbol,
            rows.map((r) => r.symbol),
          ),
        )
    : [];
  const stateBy = new Map(states.map((s) => [s.symbol, s]));
  return {
    ...base,
    date: last.date,
    check: last.check,
    items: rows.map((r) => ({
      symbol: r.symbol,
      date: r.date,
      check: r.check,
      checkedAt: r.checkedAt.toISOString(),
      price: Number(r.price),
      priceAt: r.priceAt.toISOString(),
      priceSource: r.priceSource,
      intraday: r.intraday,
      prevClose: Number(r.prevClose),
      high52: Number(r.high52),
      high52Date: r.high52Date,
      low52: Number(r.low52),
      belowHighPct: Number(r.belowHighPct),
      d1Pct: Number(r.d1Pct),
      d5Pct: n(r.d5Pct),
      worstDropPct: Number(r.worstDropPct),
      worstDropDays: r.worstDropDays,
      atr14: n(r.atr14),
      tier: r.tier,
      reasons: r.reasons,
      gapDown: r.gapDown,
      qualityPass: r.qualityPass,
      alertKinds: r.alertKinds,
      qualifiedSince: stateBy.get(r.symbol)?.qualifiedSince ?? null,
      lastAlertedTier: stateBy.get(r.symbol)?.lastAlertedTier ?? null,
      scorecard: r.scorecard,
    })),
  };
}

const CSV_COLUMNS = [
  'symbol',
  'date',
  'check',
  'checkedAt',
  'price',
  'priceAt',
  'priceSource',
  'intraday',
  'prevClose',
  'high52',
  'high52Date',
  'low52',
  'belowHighPct',
  'd1Pct',
  'd5Pct',
  'worstDropPct',
  'worstDropDays',
  'atr14',
  'tier',
  'reasons',
  'gapDown',
  'qualityPass',
  'alertKinds',
  'qualifiedSince',
  'lastAlertedTier',
] as const;
const SCORECARD_COLUMNS = [
  'revenueTtm',
  'revenueYoYPct',
  'revenueCagr3yPct',
  'grossMarginPct',
  'operatingMarginPct',
  'netMarginPct',
  'fcfTtm',
  'fcfMarginPct',
  'netCash',
  'dilutionYoYPct',
  'epsTtm',
  'peMedian',
  'pfcfMedian',
  'currency',
] as const;

const esc = (v: unknown) => {
  const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('|') : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Flat CSV: one row per name, key scorecard fields as columns (pure). */
export function pullbackExportCsv(e: PullbackExport): string {
  const header = [...CSV_COLUMNS, ...SCORECARD_COLUMNS.map((c) => `sc_${c}`)];
  const lines = e.items.map((it) =>
    [
      ...CSV_COLUMNS.map((c) => esc(it[c])),
      ...SCORECARD_COLUMNS.map((c) => esc(it.scorecard?.[c])),
    ].join(','),
  );
  return [header.join(','), ...lines].join('\n');
}
