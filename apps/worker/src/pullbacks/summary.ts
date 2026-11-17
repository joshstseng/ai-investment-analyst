/**
 * Pullback screen summary for the digest (EOD summary: today's changes at each check) and the
 * morning email (changes during the previous session): every ticker in a pullback episode with
 * its tier, plus resets.
 */
import { pullbackObservations, pullbackState, type Db } from '@aia/db';
import type { PullbackRow } from '@aia/emails';
import { and, desc, inArray, isNotNull, lte } from 'drizzle-orm';

const LABEL: Record<string, string> = { open: 'Open', midday: 'Midday', eod: 'Close' };
const ORDER: Record<string, number> = { open: 0, midday: 1, eod: 2 };
/** Keeps the digest and morning email well under Gmail's size limit. */
const MAX_ROWS = 25;

export interface PullbackSummary {
  rows: PullbackRow[];
  /** Tickers in an episode (after the date). */
  total: number;
  changed: number;
  /** Rows left out (beyond MAX_ROWS). */
  more: number;
}

type Obs = typeof pullbackObservations.$inferSelect;

/** What changed at one check, in words (pure). */
export function changeText(
  o: Pick<Obs, 'check' | 'alertKinds' | 'reversedTier' | 'reset' | 'tier' | 'd1Pct'>,
): string | null {
  const parts: string[] = [];
  for (const k of o.alertKinds) {
    if (k === 'first') parts.push('newly qualifies');
    else if (k === 'deeper_tier') parts.push(`deeper tier −${o.tier}%`);
    else if (k === 'one_day_drop') parts.push(`one-day drop ${Number(o.d1Pct).toFixed(1)}%`);
    else if (k === 'baseline') parts.push('starting list');
  }
  if (o.reversedTier !== null) parts.push(`back above −${o.reversedTier}% by the close`);
  if (o.reset) parts.push('reset (closed less than 15% below the high)');
  return parts.length ? `${LABEL[o.check] ?? o.check}: ${parts.join(', ')}` : null;
}

const day = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  });

export async function loadPullbackSummary(db: Db, date: string): Promise<PullbackSummary | null> {
  const states = await db
    .select()
    .from(pullbackState)
    .where(isNotNull(pullbackState.qualifiedSince));
  const todays = await db
    .select()
    .from(pullbackObservations)
    .where(and(inArray(pullbackObservations.date, [date])));
  const resetToday = new Set(todays.filter((o) => o.reset).map((o) => o.symbol));
  const symbols = [...new Set([...states.map((s) => s.symbol), ...resetToday])];
  if (!symbols.length) return null;

  // Latest observation on or before the date, per symbol.
  const recent = await db
    .select()
    .from(pullbackObservations)
    .where(and(inArray(pullbackObservations.symbol, symbols), lte(pullbackObservations.date, date)))
    .orderBy(desc(pullbackObservations.date), desc(pullbackObservations.checkedAt))
    .limit(symbols.length * 6);
  const latest = new Map<string, Obs>();
  for (const o of recent) if (!latest.has(o.symbol)) latest.set(o.symbol, o);

  const byState = new Map(states.map((s) => [s.symbol, s]));
  const rows: (PullbackRow & { changed: boolean; tierNum: number; below: number })[] = [];
  for (const symbol of symbols) {
    const o = latest.get(symbol);
    if (!o) continue;
    const changes = todays
      .filter((x) => x.symbol === symbol)
      .sort((a, b) => (ORDER[a.check] ?? 9) - (ORDER[b.check] ?? 9))
      .map(changeText)
      .filter((x): x is string => !!x);
    const st = byState.get(symbol);
    rows.push({
      ticker: symbol,
      tier: o.tier === null ? '—' : `−${o.tier}%`,
      belowHigh: `${Number(Number(o.belowHighPct).toFixed(1))}%`,
      d1Pct: Number(o.d1Pct),
      note: changes.length
        ? changes.join(' · ')
        : st?.qualifiedSince
          ? `in the screen since ${day(st.qualifiedSince)}`
          : '',
      quality: o.qualityPass === null ? 'n/a' : o.qualityPass ? 'pass' : 'fail',
      changed: changes.length > 0,
      tierNum: o.tier ?? 0,
      below: Number(o.belowHighPct),
    });
  }
  // Changed today first, then names that pass quality (the opportunities), then the deepest.
  const qRank = (q: PullbackRow['quality']) => (q === 'pass' ? 0 : q === 'n/a' ? 1 : 2);
  rows.sort(
    (a, b) =>
      Number(b.changed) - Number(a.changed) ||
      qRank(a.quality) - qRank(b.quality) ||
      b.tierNum - a.tierNum ||
      b.below - a.below,
  );
  return {
    rows: rows.slice(0, MAX_ROWS).map(({ changed: _c, tierNum: _t, below: _b, ...r }) => r),
    total: states.length,
    changed: rows.filter((r) => r.changed).length,
    more: Math.max(0, rows.length - MAX_ROWS),
  };
}
