/**
 * Pullback alert content derived only from numbers (pure): current valuation vs the company's
 * own medians, "Bull evidence" bullets, and whether a drop follows an earnings report.
 * Bullets state facts that favour the company; no adjectives beyond the data.
 */
import type { Scorecard } from './fundamentals';

export interface ValuationNow {
  pe: number | null;
  pfcf: number | null;
}

/** P/E and P/FCF at `price` from TTM per-share figures (positive earnings/FCF only). */
export function valuationNow(sc: Scorecard | null, price: number): ValuationNow {
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return {
    pe: sc?.epsTtm && sc.epsTtm > 0 ? r1(price / sc.epsTtm) : null,
    pfcf: sc?.fcfPerShare && sc.fcfPerShare > 0 ? r1(price / sc.fcfPerShare) : null,
  };
}

const fmtMoney = (n: number) => {
  const a = Math.abs(n);
  const s =
    a >= 1e12
      ? `${(a / 1e12).toFixed(1)}T`
      : a >= 1e9
        ? `${(a / 1e9).toFixed(1)}B`
        : `${(a / 1e6).toFixed(0)}M`;
  return `$${s}`;
};
const pctStr = (n: number) => `${n > 0 ? '+' : ''}${Number(n.toFixed(1))}%`;

/** Bull evidence bullets, built only from the scorecard and valuation. */
export function bullEvidence(sc: Scorecard | null, v: ValuationNow, historyYears = 5): string[] {
  if (!sc) return [];
  const out: string[] = [];
  if (sc.revenueYoYPct !== null && sc.revenueYoYPct > 0)
    out.push(`Revenue ${pctStr(sc.revenueYoYPct)} y/y`);
  if (sc.revenueCagr3yPct !== null && sc.revenueCagr3yPct > 0) {
    out.push(`3-year revenue CAGR ${Number(sc.revenueCagr3yPct.toFixed(1))}%`);
  }
  if (sc.grossMarginPct !== null && sc.grossMarginPct >= 50)
    out.push(`Gross margin ${Math.round(sc.grossMarginPct)}%`);
  if (sc.operatingMarginPct !== null && sc.operatingMarginPct >= 20) {
    out.push(`Operating margin ${Math.round(sc.operatingMarginPct)}%`);
  }
  if (sc.fcfMarginPct !== null && sc.fcfMarginPct > 0)
    out.push(`FCF margin ${Math.round(sc.fcfMarginPct)}%`);
  if (sc.netCash !== null && sc.netCash > 0 && sc.currency === 'USD')
    out.push(`Net cash ${fmtMoney(sc.netCash)}`);
  if (sc.dilutionYoYPct !== null && sc.dilutionYoYPct < 0) {
    out.push(`Diluted share count ${pctStr(sc.dilutionYoYPct)} y/y (buybacks)`);
  }
  if (v.pe !== null && sc.peMedian !== null && v.pe < sc.peMedian) {
    out.push(`P/E ${Math.round(v.pe)} vs ${historyYears}-yr median ${Math.round(sc.peMedian)}`);
  }
  if (v.pfcf !== null && sc.pfcfMedian !== null && v.pfcf < sc.pfcfMedian) {
    out.push(
      `P/FCF ${Math.round(v.pfcf)} vs ${historyYears}-yr median ${Math.round(sc.pfcfMedian)}`,
    );
  }
  const years = sc.netIncomeAnnual.slice(-3);
  if (years.length === 3 && years.every((y) => y.value > 0))
    out.push('Profitable in each of the last 3 fiscal years');
  return out;
}

/**
 * Trading days from the earnings release to `date` (0 = same day), or null if the release isn't
 * among `sessions` (sorted trading dates) or comes after `date`.
 */
export function tradingDaysSince(
  release: string | null,
  date: string,
  sessions: readonly string[],
): number | null {
  if (!release || release > date) return null;
  const from = sessions.findIndex((s) => s >= release);
  const to = sessions.indexOf(date);
  if (from < 0 || to < 0) return null;
  return to - from;
}
