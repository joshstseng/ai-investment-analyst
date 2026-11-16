import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseEventsCsv } from './events-csv';
import { parseHoldingsMd } from './holdings-md';
import { EMPTY_OVERRIDES, seedOverridesSchema } from './overrides';
import { buildSeedPlan, type SeedPlan } from './plan';
import { parsePositionsCsv } from './positions-csv';
import { parseWatchlistCsv } from './watchlist-csv';

export * from './apply';
export * from './events-csv';
export * from './errors';
export * from './holdings-md';
export * from './overrides';
export * from './plan';
export * from './positions-csv';
export * from './verify';
export * from './watchlist-csv';

/** Reads and parses the seed directory. holdings.md is required; the rest are optional. */
export function loadSeedDir(dir: string) {
  const read = (name: string) => {
    const path = join(dir, name);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  };
  const holdingsText = read('holdings.md');
  if (holdingsText === null) throw new Error(`${join(dir, 'holdings.md')} not found`);
  const positionsText = read('positions.csv');
  const watchlistText = read('watchlist.csv');
  const overridesText = read('seed-overrides.json');
  const eventsText = read('events.csv');

  const input = {
    holdingsMd: parseHoldingsMd(holdingsText),
    positions: positionsText ? parsePositionsCsv(positionsText) : [],
    watchlist: watchlistText ? parseWatchlistCsv(watchlistText) : [],
    overrides: overridesText
      ? seedOverridesSchema.parse(JSON.parse(overridesText))
      : EMPTY_OVERRIDES,
    events: eventsText ? parseEventsCsv(eventsText) : [],
  };
  const plan: SeedPlan = buildSeedPlan(input);
  const missingFiles = [
    !positionsText && 'positions.csv',
    !watchlistText && 'watchlist.csv',
    !overridesText && 'seed-overrides.json',
    !eventsText && 'events.csv',
  ].filter(Boolean) as string[];
  if (missingFiles.length) plan.warnings.unshift(`not found (skipped): ${missingFiles.join(', ')}`);
  return { input, plan };
}
