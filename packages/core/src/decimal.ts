/**
 * Exact decimal helpers for money and share quantities. Values travel as decimal strings
 * (the form Postgres numeric uses) so nothing is rounded through floating point.
 */

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const SCALE = 6;
const UNIT = 10n ** BigInt(SCALE);

/** Parses "$1,234.56" / "1234.56" / "12.345" into a canonical decimal string, or null. */
export function parseDecimal(input: string): string | null {
  const cleaned = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!DECIMAL_RE.test(cleaned)) return null;
  return canonical(cleaned);
}

/** Converts a decimal string to an integer count of 10^-6 units. Throws if it has more precision. */
export function toMicros(value: string): bigint {
  if (!DECIMAL_RE.test(value)) throw new Error(`not a decimal: ${value}`);
  const negative = value.startsWith('-');
  const [int = '0', frac = ''] = value.replace('-', '').split('.');
  const trimmed = frac.replace(/0+$/, '');
  if (trimmed.length > SCALE) throw new Error(`more than ${SCALE} decimal places: ${value}`);
  const micros = BigInt(int) * UNIT + BigInt(trimmed.padEnd(SCALE, '0'));
  return negative ? -micros : micros;
}

export function fromMicros(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const frac = (abs % UNIT).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${abs / UNIT}${frac ? `.${frac}` : ''}`;
}

/** Strips trailing zeros: "12.345000" → "12.345", "9.000000" → "9". */
export function canonical(value: string): string {
  return fromMicros(toMicros(value));
}

export function decimalEquals(a: string, b: string): boolean {
  return toMicros(a) === toMicros(b);
}

export function sumDecimals(values: readonly string[]): string {
  return fromMicros(values.reduce((acc, v) => acc + toMicros(v), 0n));
}
