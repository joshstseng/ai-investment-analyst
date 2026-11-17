import { color } from './tokens';

const MINUS = '−';

/** $1,234.56 (or $1,235 with digits=0); negatives as −$1,234.56. */
export function money(n: number, digits = 2): string {
  const s = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${n < 0 ? MINUS : ''}$${s}`;
}

/** +$1,234 / −$1,234 (always signed). */
export function signedMoney(n: number, digits = 0): string {
  return `${n > 0 ? '+' : n < 0 ? MINUS : ''}${money(Math.abs(n), digits)}`;
}

/** +2.9% / −1.0% / 0.0% (always signed except zero). */
export function signedPct(n: number, digits = 1): string {
  const r = Number(n.toFixed(digits));
  if (r === 0) return `${(0).toFixed(digits)}%`;
  return `${r > 0 ? '+' : MINUS}${Math.abs(r).toFixed(digits)}%`;
}

/** 17.5% (unsigned). */
export function pct(n: number, digits = 1): string {
  return `${Math.abs(n).toFixed(digits)}%`;
}

/** Gain/loss color for a signed number (muted for zero / null). */
export function toneColor(n: number | null | undefined): string {
  if (n === null || n === undefined || Number(n.toFixed(2)) === 0) return color.muted;
  return n > 0 ? color.gain : color.loss;
}
