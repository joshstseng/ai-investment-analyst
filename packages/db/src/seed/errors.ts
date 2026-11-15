export class SeedParseError extends Error {
  constructor(
    readonly file: string,
    readonly line: number | null,
    message: string,
  ) {
    super(`${file}${line === null ? '' : `:${line}`}: ${message}`);
    this.name = 'SeedParseError';
  }
}

/** "NEEDS USER INPUT" (any case) marks a value the user still has to provide. */
export function isNeedsInput(value: string): boolean {
  return /^needs user input$/i.test(value.trim());
}

export const TICKER_RE = /^[A-Z][A-Z0-9.]{0,9}$/;
