/**
 * Close check: evaluates every machine-checkable rule for one completed session with the pure
 * engine in @aia/core and stores one rule_evaluations row per rule per day (re-runs overwrite).
 * Judgment-only rules are stored in exit_rules but never evaluated. Alerts are milestone 8.
 */
import {
  addDays,
  evaluateRule,
  ruleAlertLabel,
  type DailyBar,
  type Outcome,
  type RuleType,
} from '@aia/core';
import {
  exitRules,
  instruments,
  marketCalendar,
  pricesDaily,
  ruleEvaluations,
  symbolDataStatus,
  type Db,
} from '@aia/db';
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm';
import type { JobResult } from '../lib/jobs';
import { log } from '../lib/log';
import { BAR_SETTLE_MS } from '../market/bars';

const LOOKBACK_DAYS = 400;

/** The most recent session whose close (plus the bar settle margin) has passed. */
export async function latestCompletedSession(db: Db, now = new Date()): Promise<string | null> {
  const [row] = await db
    .select({ date: marketCalendar.date })
    .from(marketCalendar)
    .where(lte(marketCalendar.closeAt, new Date(now.getTime() - BAR_SETTLE_MS)))
    .orderBy(desc(marketCalendar.date))
    .limit(1);
  return row?.date ?? null;
}

export interface CheckResult {
  ruleId: number;
  externalKey: string | null;
  symbol: string;
  evaluatedSymbol: string;
  status: 'CONFIRMED' | 'DRAFT' | 'PLACEHOLDER';
  ruleType: RuleType;
  outcome: Outcome;
}

export async function checkRules(
  db: Db,
  p: { asOfDate?: string; now?: Date } = {},
): Promise<JobResult & { results: CheckResult[] }> {
  const asOfDate = p.asOfDate ?? (await latestCompletedSession(db, p.now));
  if (!asOfDate) throw new Error('no completed session in market_calendar; run the calendar sync');
  const from = addDays(asOfDate, -LOOKBACK_DAYS);

  const rules = await db
    .select({
      id: exitRules.id,
      externalKey: exitRules.externalKey,
      ruleType: exitRules.ruleType,
      params: exitRules.params,
      status: exitRules.status,
      symbol: instruments.symbol,
      underlying: instruments.underlyingSymbol,
    })
    .from(exitRules)
    .innerJoin(instruments, eq(exitRules.instrumentId, instruments.id))
    .where(isNotNull(exitRules.ruleType))
    .orderBy(asc(instruments.symbol), asc(exitRules.id));

  const evaluated = [...new Set(rules.map((r) => r.underlying ?? r.symbol))];
  const [barRows, sessionRows, noData, history] = await Promise.all([
    evaluated.length
      ? db
          .select()
          .from(pricesDaily)
          .where(
            and(
              inArray(pricesDaily.symbol, evaluated),
              gte(pricesDaily.date, from),
              lte(pricesDaily.date, asOfDate),
            ),
          )
          .orderBy(asc(pricesDaily.date))
      : [],
    db
      .select({ date: marketCalendar.date })
      .from(marketCalendar)
      .where(and(gte(marketCalendar.date, from), lte(marketCalendar.date, asOfDate)))
      .orderBy(asc(marketCalendar.date)),
    db
      .select({ symbol: symbolDataStatus.symbol })
      .from(symbolDataStatus)
      .where(
        and(
          eq(symbolDataStatus.dataset, 'daily_bars'),
          eq(symbolDataStatus.status, 'no_data_source'),
        ),
      ),
    db
      .select({
        ruleId: ruleEvaluations.exitRuleId,
        first: sql<string>`min(${ruleEvaluations.asOfDate})`,
      })
      .from(ruleEvaluations)
      .where(and(eq(ruleEvaluations.fired, true), lt(ruleEvaluations.asOfDate, asOfDate)))
      .groupBy(ruleEvaluations.exitRuleId),
  ]);

  const bars = new Map<string, DailyBar[]>();
  for (const b of barRows) {
    const list = bars.get(b.symbol) ?? [];
    list.push({
      date: b.date,
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
    });
    bars.set(b.symbol, list);
  }
  const sessions = sessionRows.map((s) => s.date);
  const noDataSymbols = new Set(noData.map((n) => n.symbol));
  const firstFired = new Map(history.map((h) => [h.ruleId, h.first]));
  const idByKey = new Map(rules.map((r) => [r.externalKey, r.id]));

  // Trailing rules may start on a trigger that fires in this same run: evaluate them last.
  const ordered = [
    ...rules.filter((r) => r.ruleType !== 'trailing_close_pct_from_high'),
    ...rules.filter((r) => r.ruleType === 'trailing_close_pct_from_high'),
  ];
  const results: CheckResult[] = [];
  const errors: string[] = [];
  for (const r of ordered) {
    const evaluatedSymbol = r.underlying ?? r.symbol;
    const params = r.params as Record<string, unknown>;
    let triggerFiredOn: string | null = null;
    if (typeof params.start_after_rule === 'string') {
      const triggerId = idByKey.get(params.start_after_rule);
      const today = results.find((x) => x.ruleId === triggerId && x.outcome.kind === 'fired');
      triggerFiredOn =
        (triggerId !== undefined && firstFired.get(triggerId)) || (today ? asOfDate : null);
    }
    try {
      const outcome = evaluateRule(
        { ruleType: r.ruleType, params: r.params },
        {
          asOfDate,
          sessions,
          bars: bars.get(evaluatedSymbol) ?? [],
          dataAvailable: !noDataSymbols.has(evaluatedSymbol),
          firedBefore: firstFired.has(r.id),
          triggerFiredOn,
          instrumentSymbol: r.symbol,
          evaluatedSymbol,
        },
      );
      results.push({
        ruleId: r.id,
        externalKey: r.externalKey,
        symbol: r.symbol,
        evaluatedSymbol,
        status: r.status,
        ruleType: r.ruleType!,
        outcome,
      });
    } catch (error) {
      errors.push(`${r.externalKey ?? r.id}: ${String(error)}`);
      log.error('rule evaluation failed', { rule: r.externalKey ?? r.id, error: String(error) });
    }
  }

  if (results.length) {
    await db
      .insert(ruleEvaluations)
      .values(
        results.map((x) => ({
          exitRuleId: x.ruleId,
          asOfDate,
          evaluatedSymbol: x.evaluatedSymbol,
          outcome: x.outcome.kind,
          reason: x.outcome.kind === 'not_checked' ? x.outcome.reason : null,
          fired: x.outcome.kind === 'fired',
          severity: x.outcome.kind === 'fired' ? x.outcome.severity : null,
          observed: {
            ...x.outcome.observed,
            ...(x.outcome.kind === 'fired' ? { level: x.outcome.level } : {}),
            label: ruleAlertLabel(x.status),
          },
          message: x.outcome.message,
          evaluatedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: [ruleEvaluations.exitRuleId, ruleEvaluations.asOfDate],
        set: {
          evaluatedSymbol: sql`excluded.evaluated_symbol`,
          outcome: sql`excluded.outcome`,
          reason: sql`excluded.reason`,
          fired: sql`excluded.fired`,
          severity: sql`excluded.severity`,
          observed: sql`excluded.observed`,
          message: sql`excluded.message`,
          evaluatedAt: sql`excluded.evaluated_at`,
        },
      });
  }

  const count = (k: Outcome['kind']) => results.filter((x) => x.outcome.kind === k).length;
  const notChecked: Record<string, string[]> = {};
  for (const x of results) {
    if (x.outcome.kind === 'not_checked') {
      (notChecked[x.outcome.reason] ??= []).push(x.externalKey ?? String(x.ruleId));
    }
  }
  if (errors.length && results.length === 0)
    throw new Error(`all rule evaluations failed: ${errors[0]}`);
  return {
    items: results.length,
    meta: {
      asOfDate,
      evaluated: results.length,
      fired: results
        .filter((x) => x.outcome.kind === 'fired')
        .map((x) => `${x.symbol} ${x.ruleType}`),
      notFired: count('not_fired'),
      notChecked,
      errors,
    },
    results,
  };
}
