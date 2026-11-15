import { canonical, parseDecimal, toMicros } from './decimal';
import { isIsoDate } from './time';

export type OptionRight = 'call' | 'put';

export interface OptionSpec {
  underlying: string;
  right: OptionRight;
  /** Decimal string, e.g. "4" or "55". */
  strike: string;
  /** YYYY-MM-DD */
  expiry: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const pad2 = (n: number) => String(n).padStart(2, '0');

const HUMAN_RE =
  /^([A-Z][A-Z0-9.]*)\s+([A-Za-z]{3})-(\d{1,2})-(\d{4})\s+\$(\d+(?:\.\d+)?)\s+(call|put)$/i;
const COMPACT_RE = /^([A-Z][A-Z0-9.]*)\s+(\d{4}-\d{2}-\d{2})\s+(\d+(?:\.\d+)?)([CP])$/i;

/**
 * Parses the option descriptors used in the seed files:
 *  - holdings.md:   "OPTY Mar-19-2027 $6 call"
 *  - positions.csv: "OPTY 2027-03-19 6C"
 * Returns null when the text is not an option descriptor.
 */
export function parseOptionDescriptor(text: string): OptionSpec | null {
  const s = text.trim();

  const human = HUMAN_RE.exec(s);
  if (human) {
    const [, underlying, mon, day, year, strike, right] = human as unknown as string[];
    const month = MONTHS.indexOf(mon!.toLowerCase()) + 1;
    if (month === 0) return null;
    return build(
      underlying!,
      right!.toLowerCase() as OptionRight,
      strike!,
      `${year}-${pad2(month)}-${pad2(Number(day))}`,
    );
  }

  const compact = COMPACT_RE.exec(s);
  if (compact) {
    const [, underlying, expiry, strike, cp] = compact as unknown as string[];
    return build(underlying!, cp!.toUpperCase() === 'C' ? 'call' : 'put', strike!, expiry!);
  }
  return null;
}

function build(
  underlying: string,
  right: OptionRight,
  strike: string,
  expiry: string,
): OptionSpec | null {
  const k = parseDecimal(strike);
  if (!k || !isIsoDate(expiry)) return null;
  return { underlying: underlying.toUpperCase(), right, strike: canonical(k), expiry };
}

/** OCC option symbol: ROOT + YYMMDD + C/P + strike × 1000 padded to 8 digits. */
export function occSymbol(o: OptionSpec): string {
  const micros = toMicros(o.strike);
  if (micros % 1000n !== 0n) throw new Error(`strike has sub-0.001 precision: ${o.strike}`);
  const yymmdd = o.expiry.slice(2).replace(/-/g, '');
  const strike = (micros / 1000n).toString().padStart(8, '0');
  return `${o.underlying}${yymmdd}${o.right === 'call' ? 'C' : 'P'}${strike}`;
}

/** Human label, e.g. "OPTX Jun-16-2028 $45 call". */
export function optionLabel(o: OptionSpec): string {
  const [y, m, d] = o.expiry.split('-');
  const mon = MONTHS[Number(m) - 1]!;
  return `${o.underlying} ${mon[0]!.toUpperCase()}${mon.slice(1)}-${d}-${y} $${o.strike} ${o.right}`;
}
