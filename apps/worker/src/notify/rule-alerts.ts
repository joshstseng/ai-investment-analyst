/**
 * Turns close-check results into alerts using the escalation policy (decideAlert in @aia/core):
 * first fire, then only escalations; reset when the condition clears.
 */
import {
  decideAlert,
  ruleAlertLabel,
  ruleAlertTag,
  type AlertReason,
  type AlertState,
  type Outcome,
  type RuleStatus,
  type RuleType,
  type SubjectTag,
} from '@aia/core';
import {
  accounts,
  alertStates,
  exitRules,
  holdings,
  instruments,
  ruleEvaluations,
  type Db,
} from '@aia/db';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { CheckResult } from '../rules/check';
import { ACCOUNT_LABEL, escapeHtml, htmlDoc, money, ptTime } from './format';
import { enqueueAlert } from './outbox';

type Fired = Extract<Outcome, { kind: 'fired' }>;

export interface RuleAlertInput {
  tag: SubjectTag;
  display: string;
  instrumentSymbol: string;
  evaluatedSymbol: string;
  ruleType: RuleType;
  status: RuleStatus;
  purpose: string;
  outcome: Fired;
  reason: AlertReason;
  detail?: string;
  alertNote: string | null;
  judgment: string | null;
  lots: { account: string; quantity: string; avgCost: string; needsConfirmation: boolean }[];
  asOfDate: string;
  now: Date;
}

const TITLES: Record<string, string> = {
  stop: 'closed below stop',
  warning: 'at warning level',
  take_profit: 'take-profit reached',
  trailing_stop: 'trailing stop hit',
  move_up: 'big up day',
  move_down: 'big down day',
  new_low: 'new closing low',
  below_cost: 'closed below cost',
  time_stop: 'time-stop review due',
  reminder: 'reminder',
};

function title(i: RuleAlertInput) {
  if (i.outcome.level === 'reminder' && i.alertNote) return i.alertNote;
  const tier = /^drawdown_(\d+)$/.exec(i.outcome.level);
  if (tier) return `down ${tier[1]}%+ from 52-week high`;
  if (i.outcome.level === 'move_up' || i.outcome.level === 'move_down') {
    const m = (i.outcome.observed as { movePct?: number }).movePct;
    return m === undefined
      ? TITLES[i.outcome.level]!
      : `${m > 0 ? 'up' : 'down'} ${Math.abs(m).toFixed(1)}% today`;
  }
  return TITLES[i.outcome.level] ?? i.outcome.level;
}

const WHY: Record<AlertReason, (d?: string) => string> = {
  first: () => 'first alert for this condition',
  escalation_level: (d) => `escalated (${d})`,
  escalation_move: (d) => `moved a further 2%+ since the last alert (${d})`,
  event: () => 'new event',
};

/** Builds subject, plain text and HTML for one rule alert (pure). */
export function composeRuleAlert(i: RuleAlertInput) {
  const suffix =
    i.reason === 'escalation_level'
      ? ' (escalated)'
      : i.reason === 'escalation_move'
        ? ' (further move)'
        : '';
  const subject = `[AIA] ${i.tag} ${i.display}: ${title(i)}${suffix}`;
  const position = i.lots.length
    ? i.lots
        .map(
          (l) =>
            `${ACCOUNT_LABEL[l.account] ?? l.account} ${Number(l.quantity)} @ ${money(Number(l.avgCost))}${l.needsConfirmation ? ' (fill not yet confirmed)' : ''}`,
        )
        .join('; ')
    : null;
  const lines: [string, string | null][] = [
    ['Plan', i.alertNote],
    ['Why now', WHY[i.reason](i.detail)],
    [
      'Rule',
      `${i.status} (${ruleAlertLabel(i.status)}) · ${i.purpose.replace('_', ' ')} · ${i.ruleType}`,
    ],
    ['Also check (judgment)', i.judgment],
    ['Your position', position],
    [
      'Prices',
      i.evaluatedSymbol !== i.instrumentSymbol
        ? `evaluated on the underlying ${i.evaluatedSymbol} (no option prices)`
        : null,
    ],
  ];
  const kept = lines.filter((l): l is [string, string] => !!l[1]);
  const footer = `As of the ${i.asOfDate} close. Sent ${ptTime(i.now)}.`;
  const text = [i.outcome.message, '', ...kept.map(([k, v]) => `${k}: ${v}`), '', footer].join(
    '\n',
  );
  const html = htmlDoc(
    subject,
    `<p style="font-size:16px"><strong>${escapeHtml(i.outcome.message)}</strong></p>
<table cellpadding="4" style="border-collapse:collapse">${kept
      .map(
        ([k, v]) =>
          `<tr><td style="color:#555;vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`,
      )
      .join('')}</table>
<p style="color:#555">${escapeHtml(footer)}</p>`,
  );
  return { subject, text, html };
}

const toState = (r: typeof alertStates.$inferSelect): AlertState => ({
  active: r.active,
  rank: r.rank,
  price: Number(r.price),
  level: r.level,
  firstFiredOn: r.firstFiredOn,
  lastAlertedOn: r.lastAlertedOn,
});

/** Applies the policy to a close check's results; returns the ids of newly queued alerts. */
export async function processRuleAlerts(
  db: Db,
  results: readonly CheckResult[],
  asOfDate: string,
  now = new Date(),
) {
  const ids = results.map((r) => r.ruleId);
  if (ids.length === 0) return { queued: [] as number[], decisions: {} };

  const [states, details, evals] = await Promise.all([
    db.select().from(alertStates).where(inArray(alertStates.exitRuleId, ids)),
    db
      .select({
        id: exitRules.id,
        purpose: exitRules.purpose,
        alertNote: exitRules.alertNote,
        judgment: exitRules.thesisBreakTriggers,
        instrumentId: instruments.id,
        type: instruments.instrumentType,
        name: instruments.name,
      })
      .from(exitRules)
      .innerJoin(instruments, eq(exitRules.instrumentId, instruments.id))
      .where(inArray(exitRules.id, ids)),
    db
      .select({ id: ruleEvaluations.id, ruleId: ruleEvaluations.exitRuleId })
      .from(ruleEvaluations)
      .where(and(inArray(ruleEvaluations.exitRuleId, ids), eq(ruleEvaluations.asOfDate, asOfDate))),
  ]);
  const stateBy = new Map(states.map((s) => [s.exitRuleId, toState(s)]));
  const detailBy = new Map(details.map((d) => [d.id, d]));
  const evalBy = new Map(evals.map((e) => [e.ruleId, e.id]));
  const lots = await db
    .select({
      instrumentId: holdings.instrumentId,
      account: accounts.accountType,
      quantity: holdings.quantity,
      avgCost: holdings.avgCost,
      needsConfirmation: holdings.needsConfirmation,
    })
    .from(holdings)
    .innerJoin(accounts, eq(holdings.accountId, accounts.id))
    .where(
      and(
        inArray(holdings.instrumentId, [...new Set(details.map((d) => d.instrumentId))]),
        ne(holdings.status, 'closed'),
      ),
    );

  const queued: number[] = [];
  const decisions: Record<string, number> = {};
  await db.transaction(async (tx) => {
    for (const r of results) {
      const d = decideAlert(stateBy.get(r.ruleId) ?? null, r.outcome, asOfDate);
      decisions[d.reason] = (decisions[d.reason] ?? 0) + 1;

      if (d.next) {
        const row = {
          exitRuleId: r.ruleId,
          active: d.next.active,
          rank: d.next.rank,
          price: String(d.next.price),
          level: d.next.level,
          firstFiredOn: d.next.firstFiredOn,
          lastAlertedOn: d.next.lastAlertedOn,
        };
        await tx
          .insert(alertStates)
          .values(row)
          .onConflictDoUpdate({ target: alertStates.exitRuleId, set: row });
      }
      if (!d.send || r.outcome.kind !== 'fired') continue;

      const det = detailBy.get(r.ruleId)!;
      const msg = composeRuleAlert({
        tag: ruleAlertTag(r.status, r.ruleType, r.outcome),
        display: det.type === 'option' && det.name ? det.name : r.symbol,
        instrumentSymbol: r.symbol,
        evaluatedSymbol: r.evaluatedSymbol,
        ruleType: r.ruleType,
        status: r.status,
        purpose: det.purpose,
        outcome: r.outcome,
        reason: d.reason as AlertReason,
        detail: d.detail,
        alertNote: det.alertNote,
        judgment: det.judgment,
        lots: lots
          .filter((l) => l.instrumentId === det.instrumentId)
          .map((l) => ({
            account: l.account,
            quantity: l.quantity ?? '0',
            avgCost: l.avgCost ?? '0',
            needsConfirmation: l.needsConfirmation,
          })),
        asOfDate,
        now,
      });
      const id = await enqueueAlert(tx as unknown as Db, {
        dedupeKey: `rule:${r.ruleId}:${asOfDate}`,
        kind: 'rule',
        severity: r.outcome.severity,
        channel: 'email',
        subject: msg.subject,
        body: msg.text,
        html: msg.html,
        symbol: r.symbol,
        ruleEvaluationId: evalBy.get(r.ruleId) ?? null,
        asOfDate,
      });
      if (id !== null) queued.push(id);
    }
  });
  return { queued, decisions };
}
