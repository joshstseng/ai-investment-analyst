/** Plain-English descriptions of SEC filings for emails (pure). */

/** 8-K item numbers → plain English. */
export const EIGHT_K_ITEMS: Record<string, string> = {
  '1.01': 'material agreement',
  '1.02': 'agreement terminated',
  '1.03': 'bankruptcy or receivership',
  '1.05': 'cybersecurity incident',
  '2.01': 'acquisition or sale of assets completed',
  '2.02': 'results of operations',
  '2.03': 'new debt or obligation',
  '2.04': 'debt acceleration',
  '2.05': 'restructuring / exit costs',
  '2.06': 'impairment',
  '3.01': 'delisting notice',
  '3.02': 'unregistered share sale (possible dilution)',
  '3.03': 'change to shareholder rights',
  '4.01': 'auditor change',
  '4.02': 'past financials no longer reliable (restatement)',
  '5.01': 'change in control',
  '5.02': 'management or board change',
  '5.03': 'charter/bylaw or fiscal-year change',
  '5.07': 'shareholder vote results',
  '5.08': 'shareholder nominations',
  '7.01': 'Reg FD disclosure',
  '8.01': 'other events',
  '9.01': 'financial statements and exhibits',
};

export interface FilingDescription {
  /** e.g. "8-K: results of operations, management or board change" */
  label: string;
  /** True for forms/items that can mean new shares (S-1, S-3, 424B, 8-K 3.02). */
  dilution: boolean;
  /** True for material items worth highlighting (results, management change, agreement, …). */
  notable: boolean;
}

const NOTABLE_ITEMS = new Set([
  '1.01',
  '1.02',
  '1.03',
  '1.05',
  '2.01',
  '2.02',
  '2.03',
  '2.04',
  '2.05',
  '2.06',
  '3.01',
  '3.02',
  '4.01',
  '4.02',
  '5.01',
  '5.02',
]);

export function describeFiling(form: string, items: readonly string[] = []): FilingDescription {
  const base = form.replace(/\/A$/, '');
  const amended = form.endsWith('/A') ? ' (amended)' : '';
  if (base === '8-K') {
    // 9.01 (exhibits) is attached to almost every 8-K; mention it only when it's alone.
    const meaningful = items.filter((i) => i !== '9.01');
    const shown = (meaningful.length ? meaningful : items).map(
      (i) => EIGHT_K_ITEMS[i] ?? `item ${i}`,
    );
    return {
      label: `8-K${amended}: ${shown.length ? shown.join(', ') : 'current report'}`,
      dilution: items.includes('3.02'),
      notable: items.some((i) => NOTABLE_ITEMS.has(i)),
    };
  }
  if (base === '10-Q')
    return { label: `10-Q${amended}: quarterly report`, dilution: false, notable: false };
  if (base === '10-K')
    return { label: `10-K${amended}: annual report`, dilution: false, notable: false };
  if (base === 'S-1') {
    return {
      label: `S-1${amended}: registration of new shares (possible dilution)`,
      dilution: true,
      notable: true,
    };
  }
  if (base === 'S-3' || base === 'S-3ASR') {
    return {
      label: `${base}${amended}: shelf registration (possible future share or debt issuance)`,
      dilution: true,
      notable: true,
    };
  }
  if (/^424B\d$/.test(base)) {
    return {
      label: `${base}: prospectus for an offering (new shares = dilution; often debt/notes for large caps)`,
      dilution: true,
      notable: true,
    };
  }
  if (base === '4')
    return { label: `Form 4${amended}: insider transaction`, dilution: false, notable: false };
  return { label: form, dilution: false, notable: false };
}

/** Form 4 transaction codes → plain English. */
export const FORM4_CODES: Record<string, string> = {
  P: 'open-market buy',
  S: 'open-market sale',
  A: 'grant/award',
  M: 'option exercise/conversion',
  F: 'shares withheld for tax',
  G: 'gift',
  C: 'conversion',
  D: 'disposition to issuer',
  J: 'other',
  X: 'option exercise',
  W: 'acquired/disposed by will',
};
