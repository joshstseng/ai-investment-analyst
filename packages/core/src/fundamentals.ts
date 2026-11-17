/**
 * Fundamentals from SEC XBRL company facts (pure): concept selection, TTM figures, the quality
 * scorecard and the quality filter. Inputs are facts as SEC returns them (one entry per filing
 * that reported the value); everything here is deterministic and unit-tested.
 */
import { addDays } from './time';

export interface XbrlFact {
  start?: string;
  end: string;
  val: number;
  fy?: number | null;
  fp?: string | null;
  form: string;
  filed: string;
}

export type Metric =
  | 'revenue'
  | 'grossProfit'
  | 'costOfRevenue'
  | 'operatingIncome'
  | 'netIncome'
  | 'ocf'
  | 'capex'
  | 'cash'
  | 'shortTermInvestments'
  | 'longTermInvestments'
  | 'longTermDebt'
  | 'longTermDebtCurrent'
  | 'longTermDebtNoncurrent'
  | 'shortTermBorrowings'
  | 'dilutedShares';

/** Candidate concepts per metric, preferred first (companies switch concepts over the years). */
export const CONCEPTS: Record<'us-gaap' | 'ifrs-full', Partial<Record<Metric, string[]>>> = {
  'us-gaap': {
    revenue: [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      'SalesRevenueNet',
      'RevenuesNetOfInterestExpense',
      'RegulatedAndUnregulatedOperatingRevenue',
      'ElectricUtilityRevenue',
    ],
    grossProfit: ['GrossProfit'],
    costOfRevenue: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold'],
    operatingIncome: ['OperatingIncomeLoss'],
    netIncome: ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'],
    ocf: [
      'NetCashProvidedByUsedInOperatingActivities',
      'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
    ],
    capex: [
      'PaymentsToAcquirePropertyPlantAndEquipment',
      'PaymentsToAcquireProductiveAssets',
      'PaymentsToAcquireOtherPropertyPlantAndEquipment',
    ],
    cash: [
      'CashAndCashEquivalentsAtCarryingValue',
      'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
    ],
    shortTermInvestments: [
      'ShortTermInvestments',
      'MarketableSecuritiesCurrent',
      'AvailableForSaleSecuritiesDebtSecuritiesCurrent',
    ],
    /** Marketable securities held long-term (e.g. Apple's); equity stakes are not included. */
    longTermInvestments: [
      'MarketableSecuritiesNoncurrent',
      'AvailableForSaleSecuritiesDebtSecuritiesNoncurrent',
    ],
    longTermDebt: ['LongTermDebt'],
    longTermDebtCurrent: ['LongTermDebtCurrent'],
    longTermDebtNoncurrent: ['LongTermDebtNoncurrent'],
    shortTermBorrowings: ['ShortTermBorrowings', 'CommercialPaper'],
    dilutedShares: [
      'WeightedAverageNumberOfDilutedSharesOutstanding',
      'WeightedAverageNumberOfShareOutstandingBasicAndDiluted',
      // Last resort (a few companies report basic only; diluted is nearly the same for them).
      'WeightedAverageNumberOfSharesOutstandingBasic',
    ],
  },
  'ifrs-full': {
    revenue: ['Revenue', 'RevenueFromContractsWithCustomers'],
    grossProfit: ['GrossProfit'],
    costOfRevenue: ['CostOfSales'],
    operatingIncome: ['ProfitLossFromOperatingActivities'],
    netIncome: ['ProfitLossAttributableToOwnersOfParent', 'ProfitLoss'],
    ocf: ['CashFlowsFromUsedInOperatingActivities'],
    capex: [
      'PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities',
      'PurchaseOfPropertyPlantAndEquipment',
    ],
    cash: ['CashAndCashEquivalents'],
    longTermDebtNoncurrent: ['NoncurrentPortionOfNoncurrentBorrowings', 'LongtermBorrowings'],
    longTermDebtCurrent: ['CurrentPortionOfNoncurrentBorrowings'],
    shortTermBorrowings: ['ShorttermBorrowings', 'CurrentBorrowings'],
    dilutedShares: ['AdjustedWeightedAverageShares'],
  },
};

const FORMS = /^(10-K|10-Q|20-F|40-F|10-KT)(\/A)?$/;
const DAY = 86_400_000;
export const durationDays = (f: Pick<XbrlFact, 'start' | 'end'>) =>
  f.start ? Math.round((Date.parse(f.end) - Date.parse(f.start)) / DAY) + 1 : 0;
const isAnnual = (f: XbrlFact) => durationDays(f) >= 350 && durationDays(f) <= 380;
const isQuarter = (f: XbrlFact) => durationDays(f) >= 80 && durationDays(f) <= 100;

/**
 * One value per period: facts from periodic reports only, the latest filing winning (amendments
 * and later restatements). Sorted by end date, then start.
 */
export function dedupeFacts(facts: readonly XbrlFact[]): XbrlFact[] {
  const by = new Map<string, XbrlFact>();
  for (const f of facts) {
    if (!FORMS.test(f.form) || !Number.isFinite(f.val)) continue;
    const key = `${f.start ?? ''}|${f.end}`;
    const prev = by.get(key);
    if (!prev || f.filed > prev.filed) by.set(key, f);
  }
  return [...by.values()].sort(
    (a, b) => a.end.localeCompare(b.end) || (a.start ?? '').localeCompare(b.start ?? ''),
  );
}

/** Merges candidate concepts' facts; on the same period the earlier-listed concept wins. */
export function mergeConcepts(
  seriesInPreferenceOrder: readonly (readonly XbrlFact[])[],
): XbrlFact[] {
  const by = new Map<string, XbrlFact>();
  for (const series of seriesInPreferenceOrder) {
    for (const f of dedupeFacts(series)) {
      const key = `${f.start ?? ''}|${f.end}`;
      if (!by.has(key)) by.set(key, f);
    }
  }
  return [...by.values()].sort(
    (a, b) => a.end.localeCompare(b.end) || (a.start ?? '').localeCompare(b.start ?? ''),
  );
}

const near = (a: string, b: string, days: number) =>
  Math.abs(Date.parse(a) - Date.parse(b)) <= days * DAY;

export interface Ttm {
  value: number;
  end: string;
  method: 'annual' | 'ytd' | 'quarters';
}

/**
 * Trailing twelve months of a duration metric ending at the latest period on or before `asOf`:
 * the annual figure if that period is a fiscal year end; else last annual + this year-to-date −
 * last year's same year-to-date; else the sum of the last 4 discrete quarters.
 */
export function ttm(series: readonly XbrlFact[], asOf?: string): Ttm | null {
  const facts = series.filter((f) => f.start && (!asOf || f.end <= asOf));
  if (!facts.length) return null;
  const end = facts.reduce((m, f) => (f.end > m ? f.end : m), facts[0]!.end);
  const atEnd = facts.filter((f) => f.end === end);
  const annual = atEnd.find(isAnnual);
  if (annual) return { value: annual.val, end, method: 'annual' };

  // Year-to-date at `end`: the longest sub-annual period ending there.
  const ytd = atEnd
    .filter((f) => durationDays(f) < 350)
    .sort((a, b) => durationDays(b) - durationDays(a))[0];
  if (ytd) {
    const len = durationDays(ytd);
    const lastAnnual = facts
      .filter((f) => isAnnual(f) && f.end < end)
      .sort((a, b) => b.end.localeCompare(a.end))[0];
    const priorYtd = facts.find(
      (f) => near(f.end, addDays(end, -365), 10) && Math.abs(durationDays(f) - len) <= 15,
    );
    if (lastAnnual && priorYtd && near(lastAnnual.end, ytd.start!, 10)) {
      return { value: lastAnnual.val + ytd.val - priorYtd.val, end, method: 'ytd' };
    }
  }

  // Four discrete quarters ending at `end`.
  const quarters: XbrlFact[] = [];
  let cursor = end;
  for (let i = 0; i < 4; i++) {
    const q = facts.find((f) => isQuarter(f) && f.end === cursor);
    if (!q) break;
    quarters.push(q);
    cursor = addDays(q.start!, -1);
  }
  if (quarters.length === 4) {
    return { value: quarters.reduce((a, q) => a + q.val, 0), end, method: 'quarters' };
  }
  return null;
}

/** Fiscal-year values (one per year end), oldest first. */
export function annuals(series: readonly XbrlFact[]): { end: string; value: number }[] {
  return series.filter(isAnnual).map((f) => ({ end: f.end, value: f.val }));
}

/** Latest instant value (balance sheet) on or before `asOf`. */
export function latestInstant(
  series: readonly XbrlFact[],
  asOf?: string,
): { end: string; value: number } | null {
  const xs = series.filter((f) => !f.start && (!asOf || f.end <= asOf));
  const last = xs.at(-1);
  return last ? { end: last.end, value: last.val } : null;
}

/** Diluted weighted-average shares for the latest quarter (or year) on or before `asOf`. */
export function latestShares(series: readonly XbrlFact[], asOf?: string) {
  const xs = series.filter(
    (f) => f.start && (!asOf || f.end <= asOf) && (isQuarter(f) || isAnnual(f)),
  );
  if (!xs.length) return null;
  const end = xs.at(-1)!.end;
  const atEnd = xs.filter((f) => f.end === end);
  const pick = atEnd.find(isQuarter) ?? atEnd[0]!;
  return { end, value: pick.val, quarterly: isQuarter(pick) };
}

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// ---- Scorecard ----------------------------------------------------------------------------------

export interface CompanyFacts {
  taxonomy: 'us-gaap' | 'ifrs-full';
  /** Reporting currency of the monetary series, e.g. "USD", "TWD". */
  currency: string;
  series: Partial<Record<Metric, XbrlFact[]>>;
}

export interface Scorecard {
  currency: string;
  /** End of the latest reported period used for TTM. */
  periodEnd: string | null;
  annualOnly: boolean;
  revenueTtm: number | null;
  revenueYoYPct: number | null;
  revenueCagr3yPct: number | null;
  grossMarginPct: number | null;
  operatingMarginPct: number | null;
  netMarginPct: number | null;
  netIncomeTtm: number | null;
  /** Last fiscal years' net income, oldest first. */
  netIncomeAnnual: { end: string; value: number }[];
  ocfTtm: number | null;
  capexTtm: number | null;
  fcfTtm: number | null;
  fcfMarginPct: number | null;
  cash: number | null;
  debt: number | null;
  netCash: number | null;
  dilutedShares: number | null;
  dilutionYoYPct: number | null;
  /** TTM per diluted share (valuation inputs; USD filers only). */
  epsTtm: number | null;
  fcfPerShare: number | null;
  /** Median P/E and P/FCF at quarter ends over the history window (positive values only). */
  peMedian: number | null;
  pfcfMedian: number | null;
  valuationPoints: number;
  notes: string[];
}

const pct = (a: number | null, b: number | null) =>
  a === null || b === null || b === 0 ? null : Math.round((a / b) * 1000) / 10;
const growth = (now: number | null, then: number | null) =>
  now === null || then === null || then <= 0 ? null : Math.round(((now - then) / then) * 1000) / 10;
const val = (t: Ttm | null) => t?.value ?? null;

/** Quarter ends (Mar/Jun/Sep/Dec 31-ish) from `from` to `to`: the periods we have facts for. */
function periodEnds(series: readonly XbrlFact[], from: string, to: string): string[] {
  return [
    ...new Set(series.filter((f) => f.start && f.end >= from && f.end <= to).map((f) => f.end)),
  ].sort();
}

/**
 * Builds the scorecard. `closeOnOrBefore(date)` returns the official close on or before a date
 * (null if unknown); valuation medians use quarter ends over `historyYears`.
 */
export function buildScorecard(
  facts: CompanyFacts,
  p: { today: string; historyYears: number; closeOnOrBefore: (date: string) => number | null },
): Scorecard {
  const s = facts.series;
  const notes: string[] = [];
  const rev = s.revenue ?? [];
  const ni = s.netIncome ?? [];
  const revT = ttm(rev);
  const niT = ttm(ni);
  const ocfT = ttm(s.ocf ?? []);
  const capexT = ttm(s.capex ?? []);
  const periodEnd = niT?.end ?? revT?.end ?? null;
  const annualOnly = [revT, niT].every((t) => !t || t.method === 'annual');
  if (periodEnd && periodEnd < addDays(p.today, -456)) {
    notes.push(`latest reported period ends ${periodEnd} (more than 15 months ago)`);
  }

  let gross = val(ttm(s.grossProfit ?? []));
  if (gross === null && revT) {
    const cost = val(ttm(s.costOfRevenue ?? []));
    if (cost !== null) gross = revT.value - cost;
  }
  const revPrev = revT ? val(ttm(rev, addDays(revT.end, -350))) : null;
  const revAnnual = annuals(rev);
  const lastA = revAnnual.at(-1);
  const threeBack = lastA
    ? revAnnual.find((a) => near(a.end, addDays(lastA.end, -3 * 365), 15))
    : undefined;
  const cagr =
    lastA && threeBack && threeBack.value > 0
      ? Math.round(((lastA.value / threeBack.value) ** (1 / 3) - 1) * 1000) / 10
      : null;

  const fcf =
    ocfT && capexT
      ? ocfT.value - Math.abs(capexT.value)
      : ocfT && !s.capex?.length
        ? ocfT.value
        : null;
  if (ocfT && !capexT && s.capex?.length) notes.push('capex not reported for the latest period');

  // Balance sheet.
  const cash = latestInstant(s.cash ?? [])?.value ?? null;
  const sti = latestInstant(s.shortTermInvestments ?? [])?.value ?? 0;
  const lti = latestInstant(s.longTermInvestments ?? [])?.value ?? 0;
  const ltd = latestInstant(s.longTermDebt ?? [])?.value;
  const ltdParts =
    (latestInstant(s.longTermDebtNoncurrent ?? [])?.value ?? 0) +
    (latestInstant(s.longTermDebtCurrent ?? [])?.value ?? 0);
  const stb = latestInstant(s.shortTermBorrowings ?? [])?.value ?? 0;
  const anyDebt =
    ltd !== undefined ||
    s.longTermDebtNoncurrent?.length ||
    s.longTermDebtCurrent?.length ||
    s.shortTermBorrowings?.length;
  const debt = anyDebt ? (ltd ?? ltdParts) + stb : null;
  // Net cash = cash + marketable securities (short- and long-term) − debt.
  const netCash = cash !== null ? cash + sti + lti - (debt ?? 0) : null;
  if (cash !== null && debt === null)
    notes.push('no debt reported (net cash = cash + short-term investments)');

  // Shares and dilution.
  const sh = latestShares(s.dilutedShares ?? []);
  const shPrev = sh
    ? latestShares(
        (s.dilutedShares ?? []).filter(
          (f) =>
            near(f.end, addDays(sh.end, -365), 15) && (sh.quarterly ? isQuarter(f) : isAnnual(f)),
        ),
      )
    : null;
  const dilution = sh && shPrev ? growth(sh.value, shPrev.value) : null;

  const usd = facts.currency === 'USD';
  if (!usd) notes.push(`reported in ${facts.currency}: valuation multiples not computed`);
  const epsTtm = usd && niT && sh ? niT.value / sh.value : null;
  const fcfPerShare = usd && fcf !== null && sh ? fcf / sh.value : null;

  // Valuation history: P/E and P/FCF at each reported period end.
  const pes: number[] = [];
  const pfcfs: number[] = [];
  if (usd) {
    const from = addDays(p.today, -Math.round(p.historyYears * 365.25));
    for (const end of periodEnds(ni, from, p.today)) {
      const close = p.closeOnOrBefore(end);
      const n = val(ttm(ni, end));
      const shares = latestShares(s.dilutedShares ?? [], end);
      if (close === null || n === null || !shares) continue;
      const cap = close * shares.value;
      if (n > 0) pes.push(cap / n);
      const o = val(ttm(s.ocf ?? [], end));
      const c = val(ttm(s.capex ?? [], end));
      if (o !== null && c !== null && o - Math.abs(c) > 0) pfcfs.push(cap / (o - Math.abs(c)));
    }
  }
  const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

  return {
    currency: facts.currency,
    periodEnd,
    annualOnly,
    revenueTtm: val(revT),
    revenueYoYPct: growth(val(revT), revPrev),
    revenueCagr3yPct: cagr,
    grossMarginPct: pct(gross, val(revT)),
    operatingMarginPct: pct(val(ttm(s.operatingIncome ?? [])), val(revT)),
    netMarginPct: pct(val(niT), val(revT)),
    netIncomeTtm: val(niT),
    netIncomeAnnual: annuals(ni).slice(-5),
    ocfTtm: val(ocfT),
    capexTtm: capexT ? Math.abs(capexT.value) : null,
    fcfTtm: fcf,
    fcfMarginPct: pct(fcf, val(revT)),
    cash,
    debt,
    netCash,
    dilutedShares: sh?.value ?? null,
    dilutionYoYPct: dilution,
    epsTtm,
    fcfPerShare,
    peMedian: r1(median(pes)),
    pfcfMedian: r1(median(pfcfs)),
    valuationPoints: pes.length,
    notes,
  };
}

// ---- Quality filter -----------------------------------------------------------------------------

export interface QualityConfig {
  profitableYears: number;
  requirePositiveTtmNetIncome: boolean;
  requirePositiveTtmFcf: boolean;
  minRevenueGrowthPct: number;
  minMarketCapUsd: number | null;
}

export interface QualityResult {
  pass: boolean;
  /** Why it failed (empty when it passed). */
  reasons: string[];
  /** Checks that couldn't run for lack of data (each also counts as a fail). */
  missing: string[];
}

/** Proven profitability: net income > 0 each of the last N fiscal years and TTM, FCF > 0, growth. */
export function qualityCheck(
  sc: Scorecard,
  cfg: QualityConfig,
  marketCapUsd: number | null,
): QualityResult {
  const reasons: string[] = [];
  const missing: string[] = [];
  const years = sc.netIncomeAnnual.slice(-cfg.profitableYears);
  if (years.length < cfg.profitableYears)
    missing.push(`${cfg.profitableYears} fiscal years of net income`);
  else if (years.some((y) => y.value <= 0)) {
    reasons.push(
      `net loss in fiscal ${years
        .filter((y) => y.value <= 0)
        .map((y) => y.end.slice(0, 4))
        .join(', ')}`,
    );
  }
  if (cfg.requirePositiveTtmNetIncome) {
    if (sc.netIncomeTtm === null) missing.push('TTM net income');
    else if (sc.netIncomeTtm <= 0) reasons.push('TTM net loss');
  }
  if (cfg.requirePositiveTtmFcf) {
    if (sc.fcfTtm === null) missing.push('TTM free cash flow');
    else if (sc.fcfTtm <= 0) reasons.push('negative TTM free cash flow');
  }
  if (sc.revenueYoYPct === null) missing.push('revenue growth');
  else if (sc.revenueYoYPct < cfg.minRevenueGrowthPct) {
    reasons.push(`revenue ${sc.revenueYoYPct}% y/y`);
  }
  if (cfg.minMarketCapUsd !== null && marketCapUsd !== null && marketCapUsd < cfg.minMarketCapUsd) {
    reasons.push(
      `market cap $${(marketCapUsd / 1e9).toFixed(1)}B < $${(cfg.minMarketCapUsd / 1e9).toFixed(0)}B`,
    );
  }
  return {
    pass: reasons.length === 0 && missing.length === 0,
    reasons: [...reasons, ...missing.map((m) => `no data: ${m}`)],
    missing,
  };
}
