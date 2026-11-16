/** Loads holdings, their price rules and prices, and computes levels to watch (see @aia/core). */
import {
  addDays,
  levelsToWatch,
  type LevelInstrumentInput,
  type LevelToWatch,
  type RuleStatus,
} from '@aia/core';
import { exitRules, holdings, instruments, pricesDaily, ruleEvaluations, type Db } from '@aia/db';
import { and, desc, eq, gt, inArray, lte, max, ne } from 'drizzle-orm';

const LEVEL_RULE_TYPES = [
  'stop_close_below',
  'take_profit_at_or_above',
  'trailing_close_pct_from_high',
  'etf_drawdown_from_52w_high',
] as const;

export async function loadLevels(db: Db, asOfDate: string, withinPct = 5): Promise<LevelToWatch[]> {
  const held = await db
    .selectDistinct({
      id: instruments.id,
      symbol: instruments.symbol,
      name: instruments.name,
      type: instruments.instrumentType,
      underlying: instruments.underlyingSymbol,
    })
    .from(holdings)
    .innerJoin(instruments, eq(holdings.instrumentId, instruments.id))
    .where(ne(holdings.status, 'closed'));
  if (held.length === 0) return [];

  const rules = await db
    .select({
      id: exitRules.id,
      instrumentId: exitRules.instrumentId,
      ruleType: exitRules.ruleType,
      params: exitRules.params,
      status: exitRules.status,
    })
    .from(exitRules)
    .where(
      and(
        inArray(
          exitRules.instrumentId,
          held.map((h) => h.id),
        ),
        inArray(exitRules.ruleType, [...LEVEL_RULE_TYPES]),
      ),
    );

  const evaluated = [...new Set(held.map((h) => h.underlying ?? h.symbol))];
  const closes = new Map<string, number>();
  for (const sym of evaluated) {
    const [bar] = await db
      .select({ close: pricesDaily.close })
      .from(pricesDaily)
      .where(and(eq(pricesDaily.symbol, sym), lte(pricesDaily.date, asOfDate)))
      .orderBy(desc(pricesDaily.date))
      .limit(1);
    if (bar) closes.set(sym, Number(bar.close));
  }

  const highs = new Map<string, number>();
  const needHigh = held.filter((h) =>
    rules.some((r) => r.instrumentId === h.id && r.ruleType === 'etf_drawdown_from_52w_high'),
  );
  if (needHigh.length) {
    const rows = await db
      .select({ symbol: pricesDaily.symbol, high: max(pricesDaily.high) })
      .from(pricesDaily)
      .where(
        and(
          inArray(
            pricesDaily.symbol,
            needHigh.map((h) => h.underlying ?? h.symbol),
          ),
          gt(pricesDaily.date, addDays(asOfDate, -365)),
          lte(pricesDaily.date, asOfDate),
        ),
      )
      .groupBy(pricesDaily.symbol);
    for (const r of rows) if (r.high) highs.set(r.symbol, Number(r.high));
  }

  // Trailing stops: the trigger level from each rule's latest evaluation (null until started).
  const triggers = new Map<number, number>();
  const trailing = rules.filter((r) => r.ruleType === 'trailing_close_pct_from_high');
  for (const r of trailing) {
    const [ev] = await db
      .select({ observed: ruleEvaluations.observed })
      .from(ruleEvaluations)
      .where(and(eq(ruleEvaluations.exitRuleId, r.id), lte(ruleEvaluations.asOfDate, asOfDate)))
      .orderBy(desc(ruleEvaluations.asOfDate))
      .limit(1);
    const level = (ev?.observed as { triggerLevel?: unknown } | undefined)?.triggerLevel;
    if (typeof level === 'number') triggers.set(r.id, level);
  }

  const inputs: LevelInstrumentInput[] = held.map((h) => {
    const evaluatedSymbol = h.underlying ?? h.symbol;
    return {
      display: h.type === 'option' && h.name ? h.name : h.symbol,
      instrumentSymbol: h.symbol,
      evaluatedSymbol,
      close: closes.get(evaluatedSymbol) ?? null,
      high52w: highs.get(evaluatedSymbol) ?? null,
      rules: rules
        .filter((r) => r.instrumentId === h.id)
        .map((r) => ({
          status: r.status as RuleStatus,
          ruleType: r.ruleType!,
          params: r.params,
          triggerLevel: triggers.get(r.id) ?? null,
        })),
    };
  });
  return levelsToWatch(inputs, { withinPct, asOfDate });
}
