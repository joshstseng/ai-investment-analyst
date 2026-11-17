/**
 * Turns close-check results into alerts using the escalation policy (decideAlert in @aia/core):
 * first fire, then only escalations; reset when the condition clears. Each alert email follows
 * Mock 2: severity header, what happened and why now, range bar, position box and a Plan box.
 */
import {
  attentionRange,
  decideAlert,
  positionPL,
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
  pricesDaily,
  ruleEvaluations,
  type Db,
} from '@aia/db';
import {
  money,
  renderAlertEmail,
  signedMoney,
  signedPct,
  type AlertEmailProps,
  type Severity,
} from '@aia/emails';
import { and, desc, eq, inArray, lt, ne } from 'drizzle-orm';
import type { CheckResult } from '../rules/check';
import { ACCOUNT_LABEL, ptTime } from './format';
import { enqueueAlert } from './outbox';

type Fired = Extract<Outcome, { kind: 'fired' }>;

export interface RuleAlertInput {
  tag: SubjectTag;
  display: string;
  instrumentSymbol: string;
  evaluatedSymbol: string;
  /** Company name (stocks) when known. */
  name?: string | null;
  isOption?: boolean;
  ruleType: RuleType;
  status: RuleStatus;
  purpose: string;
  outcome: Fired;
  reason: AlertReason;
  detail?: string;
  alertNote: string | null;
  /** CONFIRMED rules: the planned action, e.g. "Sell 3 of 9 shares at $200-210." */
  planAction?: string | null;
  judgment: string | null;
  lots: { account: string; quantity: string; avgCost: string; needsConfirmation: boolean }[];
  /** Previous session's close of the evaluated symbol (day %). */
  prevClose?: number | null;
  /** Other price rules on the instrument (range bar ends; "no confirmed exit rules" note). */
  siblings?: { ruleType: string | null; status: string; params: Record<string, unknown> }[];
  asOfDate: string;
  now: Date;
}

export const TAG_EMOJI: Record<string, string> = {
  ACTION: '‼️',
  WARNING: '⚠️',
  REVIEW: '📝',
  REMINDER: '💡',
  HEALTH: '🩺',
};

const SEVERITY_OF: Record<string, Severity> = {
  ACTION: 'action',
  WARNING: 'warning',
  REVIEW: 'review',
  REMINDER: 'reminder',
};

const TITLES: Record<string, string> = {
  stop: 'closed below stop',
  warning: 'at warning level',
  take_profit: 'take-profit reached',
  trailing_stop: 'trailing stop hit',
  move_up: 'big up day',
  move_down: 'big down day',
  new_low: 'new 52-week closing low',
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
  first: () => '',
  escalation_level: (d) => `Escalated${d ? ` (${d})` : ''}.`,
  escalation_move: (d) => `A further 2%+ move since the last alert${d ? ` (${d})` : ''}.`,
  event: () => '',
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const price = (n: number) => money(n, n < 1 ? 4 : 2);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** "‼️ [AIA] ACTION BKX: closed below stop" (+ " (escalated)" / " (further move)"). */
export function ruleAlertSubject(i: RuleAlertInput): string {
  const suffix =
    i.reason === 'escalation_level'
      ? ' (escalated)'
      : i.reason === 'escalation_move'
        ? ' (further move)'
        : '';
  return `${TAG_EMOJI[i.tag] ?? ''} [AIA] ${i.tag} ${i.display}: ${title(i)}${suffix}`.trim();
}

/** The Plan box: planned action (CONFIRMED) or "review" (DRAFT/PLACEHOLDER), note, judgment. */
export function planLines(i: RuleAlertInput): { label: string; text: string }[] {
  const o = i.outcome.observed as Record<string, unknown>;
  const lines: { label: string; text: string }[] = [];
  let noteUsed = false;
  if (i.ruleType === 'date_reminder') {
    if (i.alertNote) {
      lines.push({ label: 'Plan', text: i.alertNote });
      noteUsed = true;
    }
  } else if (i.status === 'CONFIRMED') {
    const level = num(o.level);
    const generic: Record<string, string> = {
      stop: `Exit per plan: daily close below ${level === null ? 'the stop' : price(level)}.`,
      warning: `Warning only; the stop is ${level === null ? 'below' : price(level)}.`,
      take_profit: `Take profit per plan at ${level === null ? 'the target' : price(level)}.`,
      trailing_stop: 'Exit per plan: the trailing stop was hit.',
      time_stop: 'Review the position per plan (time stop).',
    };
    if (i.outcome.level === 'warning') {
      lines.push({
        label: 'Plan',
        text: `${generic.warning}${i.planAction ? ` At the stop: ${i.planAction}` : ''}`,
      });
    } else {
      lines.push({
        label: 'Plan',
        text: i.planAction ?? generic[i.outcome.level] ?? 'Act per plan.',
      });
    }
  } else {
    const confirmed = (i.siblings ?? []).some((s) => s.status === 'CONFIRMED');
    lines.push({
      label: 'Plan',
      text: `Review the position. This is a ${i.status} rule, so there's no confirmed exit plan yet.${
        confirmed ? '' : ` No exit rules are confirmed for ${i.display}; consider writing one.`
      }`,
    });
  }
  if (i.alertNote && !noteUsed) lines.push({ label: 'Note', text: i.alertNote });
  if (i.judgment) lines.push({ label: 'Also check', text: i.judgment });
  return lines;
}

/** Builds the alert's props (pure). */
export function ruleAlertProps(i: RuleAlertInput): AlertEmailProps {
  const o = i.outcome.observed as Record<string, unknown>;
  const close = num(o.close);
  const prev = i.prevClose ?? num(o.prevClose);
  const dayPct = close !== null && prev ? ((close - prev) / prev) * 100 : null;
  const isOption = i.isOption ?? i.evaluatedSymbol !== i.instrumentSymbol;
  const lots = i.lots.map((l) => ({
    account: l.account,
    quantity: Number(l.quantity),
    avgCost: Number(l.avgCost),
  }));
  const pl = !isOption && close !== null && lots.length ? positionPL(lots, close) : null;
  const avgCost = pl && pl.shares > 0 ? pl.cost / pl.shares : null;

  // Range bar: stop ↔ take-profit / cost, deepest tier ↔ 52w high, low ↔ cost.
  const siblings = i.siblings ?? [];
  const levelsOf = (type: string) =>
    siblings
      .filter((s) => s.ruleType === type)
      .map((s) => num(s.params.level))
      .filter((v): v is number => v !== null);
  const range =
    close === null
      ? null
      : attentionRange({
          ruleType: i.ruleType,
          observed: o,
          close,
          stops: levelsOf('stop_close_below'),
          takeProfits: levelsOf('take_profit_at_or_above'),
          avgCost,
        });

  const accountsLabel = [...new Set(i.lots.map((l) => ACCOUNT_LABEL[l.account] ?? l.account))].join(
    ' + ',
  );
  const subtitle = [i.name && i.name !== i.display ? i.name : null, accountsLabel || null]
    .filter(Boolean)
    .join(' · ');

  let position: AlertEmailProps['position'] = null;
  if (i.lots.length) {
    const unit = isOption ? 'contract' : 'sh';
    const qty = (n: number) => `${Number(n.toFixed(3))} ${unit}${isOption && n !== 1 ? 's' : ''}`;
    const single = lots.length === 1 ? lots[0]! : null;
    const cells: NonNullable<AlertEmailProps['position']>['cells'] = [
      {
        label: 'Position',
        value: single
          ? `${qty(single.quantity)} @ ${price(single.avgCost)}`
          : `${qty(lots.reduce((a, l) => a + l.quantity, 0))} · ${lots.length} lots`,
      },
    ];
    if (pl) {
      cells.push({ label: 'Value', value: money(pl.value, 0) });
      cells.push({
        label: 'P/L',
        value: `${signedMoney(pl.plDollars)}${pl.plPct === null ? '' : ` · ${signedPct(pl.plPct)}`}`,
        tone: pl.plDollars < 0 ? 'loss' : pl.plDollars > 0 ? 'gain' : undefined,
      });
    }
    position = {
      cells,
      lots:
        lots.length > 1
          ? lots.map((l) => {
              const vs =
                close !== null && !isOption && l.avgCost > 0
                  ? ((close - l.avgCost) / l.avgCost) * 100
                  : null;
              return `${ACCOUNT_LABEL[l.account] ?? l.account}: ${qty(l.quantity)} @ ${price(l.avgCost)}${vs === null ? '' : ` (${signedPct(vs)})`}`;
            })
          : [],
      note:
        [
          isOption ? 'Option value not shown (no option prices are collected).' : null,
          i.lots.some((l) => l.needsConfirmation) ? 'Fill not yet confirmed.' : null,
        ]
          .filter(Boolean)
          .join(' ') || null,
    };
  }

  const why = WHY[i.reason](i.detail);
  const preview = [
    close === null ? null : `${price(close)}${dayPct === null ? '' : ` ${signedPct(dayPct)}`}`,
    pl?.plPct != null ? `position ${signedPct(pl.plPct)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    subject: ruleAlertSubject(i),
    preview: i.ruleType === 'date_reminder' ? (i.alertNote ?? title(i)) : preview || title(i),
    severity: SEVERITY_OF[i.tag] ?? 'info',
    ticker: i.display,
    subtitle,
    price: close === null ? null : price(close),
    changePct: dayPct,
    priceNote: isOption ? i.evaluatedSymbol : null,
    title: capitalize(title(i)),
    body: `${i.outcome.message}${i.outcome.message.endsWith('.') ? '' : '.'}${why ? ` ${why}` : ''}`,
    range: range
      ? {
          left: `${range.left.label} ${price(range.left.value)}`,
          right: `${range.right.label} ${price(range.right.value)}`,
          markerPct: range.markerPct,
        }
      : null,
    position,
    plan: planLines(i),
    footer: [
      `Rule: ${i.ruleType} · ${i.status} · ${i.purpose.replace(/_/g, ' ')}`,
      `As of the ${new Date(`${i.asOfDate}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })} close · sent ${ptTime(i.now)}`,
      ...(isOption ? [`Prices are the underlying ${i.evaluatedSymbol} (no option prices).`] : []),
    ],
  };
}

/** Subject, plain text and HTML for one rule alert. */
export async function composeRuleAlert(i: RuleAlertInput) {
  const props = ruleAlertProps(i);
  return { props, ...(await renderAlertEmail(props)) };
}

const toState = (r: typeof alertStates.$inferSelect): AlertState => ({
  active: r.active,
  rank: r.rank,
  price: Number(r.price),
  level: r.level,
  firstFiredOn: r.firstFiredOn,
  lastAlertedOn: r.lastAlertedOn,
});

/** Previous close before `date` for each symbol (day % in alerts). */
export async function previousCloses(db: Db, symbols: string[], date: string) {
  const out = new Map<string, number>();
  for (const sym of new Set(symbols)) {
    const [bar] = await db
      .select({ close: pricesDaily.close })
      .from(pricesDaily)
      .where(and(eq(pricesDaily.symbol, sym), lt(pricesDaily.date, date)))
      .orderBy(desc(pricesDaily.date))
      .limit(1);
    if (bar) out.set(sym, Number(bar.close));
  }
  return out;
}

/** Everything composeRuleAlert needs beyond the check result, for a set of rules. */
export async function loadAlertContext(db: Db, ruleIds: number[]) {
  const details = await db
    .select({
      id: exitRules.id,
      purpose: exitRules.purpose,
      alertNote: exitRules.alertNote,
      planAction: exitRules.planAction,
      judgment: exitRules.thesisBreakTriggers,
      instrumentId: instruments.id,
      type: instruments.instrumentType,
      name: instruments.name,
    })
    .from(exitRules)
    .innerJoin(instruments, eq(exitRules.instrumentId, instruments.id))
    .where(inArray(exitRules.id, ruleIds));
  const instrumentIds = [...new Set(details.map((d) => d.instrumentId))];
  const [lots, siblings] = instrumentIds.length
    ? await Promise.all([
        db
          .select({
            instrumentId: holdings.instrumentId,
            account: accounts.accountType,
            quantity: holdings.quantity,
            avgCost: holdings.avgCost,
            needsConfirmation: holdings.needsConfirmation,
          })
          .from(holdings)
          .innerJoin(accounts, eq(holdings.accountId, accounts.id))
          .where(and(inArray(holdings.instrumentId, instrumentIds), ne(holdings.status, 'closed'))),
        db
          .select({
            instrumentId: exitRules.instrumentId,
            ruleType: exitRules.ruleType,
            status: exitRules.status,
            params: exitRules.params,
          })
          .from(exitRules)
          .where(inArray(exitRules.instrumentId, instrumentIds)),
      ])
    : [[], []];
  return {
    detailBy: new Map(details.map((d) => [d.id, d])),
    lotsFor: (instrumentId: number) =>
      lots
        .filter((l) => l.instrumentId === instrumentId)
        .map((l) => ({
          account: l.account,
          quantity: l.quantity ?? '0',
          avgCost: l.avgCost ?? '0',
          needsConfirmation: l.needsConfirmation,
        })),
    siblingsFor: (instrumentId: number) =>
      siblings
        .filter((s) => s.instrumentId === instrumentId)
        .map((s) => ({ ruleType: s.ruleType, status: s.status, params: s.params })),
  };
}

/** Applies the policy to a close check's results; returns the ids of newly queued alerts. */
export async function processRuleAlerts(
  db: Db,
  results: readonly CheckResult[],
  asOfDate: string,
  now = new Date(),
) {
  const ids = results.map((r) => r.ruleId);
  if (ids.length === 0) return { queued: [] as number[], decisions: {} };

  const [states, ctx, evals, prevCloses] = await Promise.all([
    db.select().from(alertStates).where(inArray(alertStates.exitRuleId, ids)),
    loadAlertContext(db, ids),
    db
      .select({ id: ruleEvaluations.id, ruleId: ruleEvaluations.exitRuleId })
      .from(ruleEvaluations)
      .where(and(inArray(ruleEvaluations.exitRuleId, ids), eq(ruleEvaluations.asOfDate, asOfDate))),
    previousCloses(
      db,
      results.filter((r) => r.outcome.kind === 'fired').map((r) => r.evaluatedSymbol),
      asOfDate,
    ),
  ]);
  const stateBy = new Map(states.map((s) => [s.exitRuleId, toState(s)]));
  const evalBy = new Map(evals.map((e) => [e.ruleId, e.id]));

  // Decide first; render outside the transaction (rendering is async and slow-ish).
  const toSend: { r: CheckResult; reason: AlertReason; detail?: string }[] = [];
  const decisions: Record<string, number> = {};
  const nextStates: (typeof alertStates.$inferInsert)[] = [];
  for (const r of results) {
    const d = decideAlert(stateBy.get(r.ruleId) ?? null, r.outcome, asOfDate);
    decisions[d.reason] = (decisions[d.reason] ?? 0) + 1;
    if (d.next) {
      nextStates.push({
        exitRuleId: r.ruleId,
        active: d.next.active,
        rank: d.next.rank,
        price: String(d.next.price),
        level: d.next.level,
        firstFiredOn: d.next.firstFiredOn,
        lastAlertedOn: d.next.lastAlertedOn,
      });
    }
    if (d.send && r.outcome.kind === 'fired') {
      toSend.push({ r, reason: d.reason as AlertReason, detail: d.detail });
    }
  }

  const messages = await Promise.all(
    toSend.map(async ({ r, reason, detail }) => {
      const det = ctx.detailBy.get(r.ruleId)!;
      const outcome = r.outcome as Fired;
      const msg = await composeRuleAlert({
        tag: ruleAlertTag(r.status, r.ruleType, outcome),
        display: det.type === 'option' && det.name ? det.name : r.symbol,
        instrumentSymbol: r.symbol,
        evaluatedSymbol: r.evaluatedSymbol,
        name: det.type === 'option' ? null : det.name,
        isOption: det.type === 'option',
        ruleType: r.ruleType,
        status: r.status,
        purpose: det.purpose,
        outcome,
        reason,
        detail,
        alertNote: det.alertNote,
        planAction: det.planAction,
        judgment: det.judgment,
        lots: ctx.lotsFor(det.instrumentId),
        prevClose: prevCloses.get(r.evaluatedSymbol) ?? null,
        siblings: ctx.siblingsFor(det.instrumentId),
        asOfDate,
        now,
      });
      return { r, outcome, msg };
    }),
  );

  const queued: number[] = [];
  await db.transaction(async (tx) => {
    for (const row of nextStates) {
      await tx
        .insert(alertStates)
        .values(row)
        .onConflictDoUpdate({ target: alertStates.exitRuleId, set: row });
    }
    for (const { r, outcome, msg } of messages) {
      const id = await enqueueAlert(tx as unknown as Db, {
        dedupeKey: `rule:${r.ruleId}:${asOfDate}`,
        kind: 'rule',
        severity: outcome.severity,
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

/**
 * Previews (CLI): the alert email a rule that fired on `asOfDate` would send, from stored data.
 * Returns the tickers that fired when `ticker` didn't.
 */
export async function previewRuleAlert(db: Db, ticker: string, asOfDate: string, now = new Date()) {
  const rows = await db
    .select({
      ruleId: ruleEvaluations.exitRuleId,
      observed: ruleEvaluations.observed,
      severity: ruleEvaluations.severity,
      message: ruleEvaluations.message,
      evaluatedSymbol: ruleEvaluations.evaluatedSymbol,
      symbol: instruments.symbol,
      ruleType: exitRules.ruleType,
      status: exitRules.status,
    })
    .from(ruleEvaluations)
    .innerJoin(exitRules, eq(ruleEvaluations.exitRuleId, exitRules.id))
    .innerJoin(instruments, eq(exitRules.instrumentId, instruments.id))
    .where(and(eq(ruleEvaluations.asOfDate, asOfDate), eq(ruleEvaluations.fired, true)));
  const t = ticker.toUpperCase();
  const pick = rows.find((r) => r.symbol === t || r.evaluatedSymbol === t);
  if (!pick || !pick.ruleType) {
    return { msg: null, fired: [...new Set(rows.map((r) => r.symbol))].sort() };
  }
  const ctx = await loadAlertContext(db, [pick.ruleId]);
  const det = ctx.detailBy.get(pick.ruleId)!;
  const prev = await previousCloses(db, [pick.evaluatedSymbol], asOfDate);
  const outcome: Fired = {
    kind: 'fired',
    severity: pick.severity === 'critical' ? 'critical' : 'warn',
    level: typeof pick.observed.level === 'string' ? pick.observed.level : '',
    message: pick.message ?? '',
    observed: pick.observed,
    track: { kind: 'event' },
  };
  const msg = await composeRuleAlert({
    tag: ruleAlertTag(pick.status as RuleStatus, pick.ruleType, outcome),
    display: det.type === 'option' && det.name ? det.name : pick.symbol,
    instrumentSymbol: pick.symbol,
    evaluatedSymbol: pick.evaluatedSymbol,
    name: det.type === 'option' ? null : det.name,
    isOption: det.type === 'option',
    ruleType: pick.ruleType,
    status: pick.status as RuleStatus,
    purpose: det.purpose,
    outcome,
    reason: 'first',
    alertNote: det.alertNote,
    planAction: det.planAction,
    judgment: det.judgment,
    lots: ctx.lotsFor(det.instrumentId),
    prevClose: prev.get(pick.evaluatedSymbol) ?? null,
    siblings: ctx.siblingsFor(det.instrumentId),
    asOfDate,
    now,
  });
  return { msg, fired: [] as string[] };
}
