/**
 * Daily digest (trading days, ~2:15 PM PT): closes, % vs cost per lot, distance to the nearest
 * stop / take-profit, still-active conditions, alerts sent today, new filings and headlines per
 * ticker, rules not checked (and why), feed problems. On the week's last session it adds
 * "rules to write" and missing user input.
 */
import { addDays, isRuleToWrite, nyDate, zonedTimeToUtc } from '@aia/core';
import {
  accounts,
  alerts,
  alertStates,
  exitRules,
  feedStatus,
  filings,
  holdings,
  instruments,
  marketCalendar,
  newsItems,
  positionTheses,
  pricesDaily,
  ruleEvaluations,
  symbolDataStatus,
  type Db,
} from '@aia/db';
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, ne } from 'drizzle-orm';
import { loadUniverse } from '../market/universe';
import { ACCOUNT_LABEL, escapeHtml, htmlDoc, money, ptTime, signedPct } from './format';

export interface DigestLevel {
  level: number;
  distPct: number;
  status: string;
  label: string;
}

export interface DigestPosition {
  display: string;
  symbol: string;
  evaluatedSymbol: string;
  isOption: boolean;
  noData: boolean;
  close: number | null;
  dayPct: number | null;
  lots: {
    account: string;
    quantity: number;
    avgCost: number;
    pctVsCost: number | null;
    unconfirmed: boolean;
  }[];
  stop: DigestLevel | null;
  takeProfit: DigestLevel | null;
}

export interface DigestData {
  date: string;
  generatedAt: Date;
  since: Date;
  until: Date;
  weekly: boolean;
  positions: DigestPosition[];
  active: {
    display: string;
    level: string;
    status: string;
    firstFiredOn: string;
    message: string;
  }[];
  alertsToday: string[];
  notChecked: { reason: string; items: string[] }[];
  filings: {
    ticker: string;
    items: { form: string; items: string[]; filedAt: Date; url: string }[];
  }[];
  headlines: {
    ticker: string;
    items: { headline: string; url: string | null; publishedAt: Date }[];
    more: number;
  }[];
  feedIssues: { feed: string; status: string; detail: string | null; since: Date }[];
  rulesToWrite: { display: string; purposes: string[] }[];
  needsInput: string[];
}

const HEADLINES_PER_TICKER = 5;
const DIGEST_HOUR_PT = 14;
const DIGEST_MINUTE_PT = 15;

/** Monday (YYYY-MM-DD) of the week containing `date`. */
const weekOf = (date: string) => {
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -dow);
};

/** The digest time for a session date: 2:15 PM Pacific. */
export function digestTimeFor(date: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return zonedTimeToUtc(
    { year: y, month: m, day: d, hour: DIGEST_HOUR_PT, minute: DIGEST_MINUTE_PT },
    'America/Los_Angeles',
  );
}

const REASON_TEXT: Record<string, string> = {
  no_data_source: 'no data source',
  missing_bar: 'missing bar',
  insufficient_history: 'insufficient history',
  not_started: 'not started yet',
  expired: 'rule ended',
  not_trading_day: 'not a trading day',
};

export async function gatherDigest(db: Db, date: string, now = new Date()): Promise<DigestData> {
  const sessions = (
    await db
      .select({ date: marketCalendar.date })
      .from(marketCalendar)
      .where(
        and(
          gte(marketCalendar.date, addDays(date, -10)),
          lt(marketCalendar.date, addDays(date, 10)),
        ),
      )
      .orderBy(asc(marketCalendar.date))
  ).map((s) => s.date);
  const idx = sessions.indexOf(date);
  const prevDate = idx > 0 ? sessions[idx - 1]! : null;
  const nextDate = sessions[idx + 1] ?? null;
  const since = prevDate ? digestTimeFor(prevDate) : new Date(now.getTime() - 86_400_000);
  const weekly = !nextDate || weekOf(nextDate) !== weekOf(date);
  // Window ends at this session's digest time, so a late or historical digest doesn't pull in
  // items that belong to the next one.
  const until = new Date(Math.min(now.getTime(), digestTimeFor(date).getTime()));

  // Holdings and their instruments.
  const lotRows = await db
    .select({
      instrumentId: instruments.id,
      symbol: instruments.symbol,
      name: instruments.name,
      type: instruments.instrumentType,
      underlying: instruments.underlyingSymbol,
      account: accounts.accountType,
      quantity: holdings.quantity,
      avgCost: holdings.avgCost,
      unconfirmed: holdings.needsConfirmation,
    })
    .from(holdings)
    .innerJoin(instruments, eq(holdings.instrumentId, instruments.id))
    .innerJoin(accounts, eq(holdings.accountId, accounts.id))
    .where(ne(holdings.status, 'closed'))
    .orderBy(asc(instruments.symbol), asc(accounts.accountType), asc(holdings.lotNo));

  const evalSymbols = [...new Set(lotRows.map((l) => l.underlying ?? l.symbol))];
  const bars = evalSymbols.length
    ? await db
        .select({ symbol: pricesDaily.symbol, date: pricesDaily.date, close: pricesDaily.close })
        .from(pricesDaily)
        .where(
          and(
            inArray(pricesDaily.symbol, evalSymbols),
            inArray(pricesDaily.date, [date, ...(prevDate ? [prevDate] : [])]),
          ),
        )
    : [];
  const closeOf = (sym: string, d: string | null) => {
    const b = bars.find((x) => x.symbol === sym && x.date === d);
    return b ? Number(b.close) : null;
  };
  const noData = new Set(
    (
      await db
        .select({ symbol: symbolDataStatus.symbol })
        .from(symbolDataStatus)
        .where(
          and(
            eq(symbolDataStatus.dataset, 'daily_bars'),
            eq(symbolDataStatus.status, 'no_data_source'),
          ),
        )
    ).map((r) => r.symbol),
  );

  const rules = await db
    .select({
      id: exitRules.id,
      instrumentId: exitRules.instrumentId,
      ruleType: exitRules.ruleType,
      params: exitRules.params,
      status: exitRules.status,
      purpose: exitRules.purpose,
      judgment: exitRules.thesisBreakTriggers,
    })
    .from(exitRules);
  const todaysEvals = await db
    .select()
    .from(ruleEvaluations)
    .where(eq(ruleEvaluations.asOfDate, date));
  const evalBy = new Map(todaysEvals.map((e) => [e.exitRuleId, e]));

  const byInstrument = new Map<number, typeof lotRows>();
  for (const l of lotRows)
    byInstrument.set(l.instrumentId, [...(byInstrument.get(l.instrumentId) ?? []), l]);

  const positions: DigestPosition[] = [];
  for (const [instrumentId, lots] of byInstrument) {
    const f = lots[0]!;
    const evaluatedSymbol = f.underlying ?? f.symbol;
    const isOption = f.type === 'option';
    const close = closeOf(evaluatedSymbol, date);
    const prev = closeOf(evaluatedSymbol, prevDate);
    const stops: DigestLevel[] = [];
    const tps: DigestLevel[] = [];
    for (const r of rules.filter((x) => x.instrumentId === instrumentId)) {
      const p = r.params as Record<string, number | string | null | undefined>;
      if (close === null) break;
      if (r.ruleType === 'stop_close_below' && typeof p.level === 'number') {
        stops.push({
          level: p.level,
          distPct: ((close - p.level) / close) * 100,
          status: r.status,
          label: 'stop',
        });
      }
      if (r.ruleType === 'trailing_close_pct_from_high') {
        const trigger = (evalBy.get(r.id)?.observed as { triggerLevel?: number } | undefined)
          ?.triggerLevel;
        if (typeof trigger === 'number') {
          stops.push({
            level: trigger,
            distPct: ((close - trigger) / close) * 100,
            status: r.status,
            label: 'trailing stop',
          });
        }
      }
      if (
        r.ruleType === 'take_profit_at_or_above' &&
        typeof p.level === 'number' &&
        !(typeof p.valid_until === 'string' && p.valid_until < date)
      ) {
        tps.push({
          level: p.level,
          distPct: ((p.level - close) / close) * 100,
          status: r.status,
          label: 'take-profit',
        });
      }
    }
    const nearest = (xs: DigestLevel[]) =>
      xs.length ? xs.reduce((a, b) => (Math.abs(b.distPct) < Math.abs(a.distPct) ? b : a)) : null;
    positions.push({
      display: isOption && f.name ? f.name : f.symbol,
      symbol: f.symbol,
      evaluatedSymbol,
      isOption,
      noData: noData.has(evaluatedSymbol),
      close,
      dayPct: close !== null && prev !== null ? ((close - prev) / prev) * 100 : null,
      lots: lots.map((l) => {
        const avg = Number(l.avgCost);
        return {
          account: l.account,
          quantity: Number(l.quantity),
          avgCost: avg,
          pctVsCost: !isOption && close !== null && avg > 0 ? ((close - avg) / avg) * 100 : null,
          unconfirmed: l.unconfirmed,
        };
      }),
      stop: nearest(stops),
      takeProfit: nearest(tps),
    });
  }

  // Still-active conditions and today's alerts.
  const activeRows = await db
    .select({
      ruleId: alertStates.exitRuleId,
      level: alertStates.level,
      firstFiredOn: alertStates.firstFiredOn,
      status: exitRules.status,
      symbol: instruments.symbol,
      name: instruments.name,
      type: instruments.instrumentType,
    })
    .from(alertStates)
    .innerJoin(exitRules, eq(alertStates.exitRuleId, exitRules.id))
    .innerJoin(instruments, eq(exitRules.instrumentId, instruments.id))
    .where(eq(alertStates.active, true))
    .orderBy(asc(instruments.symbol));
  const display = (r: { symbol: string; name: string | null; type: string }) =>
    r.type === 'option' && r.name ? r.name : r.symbol;
  const active = activeRows.map((r) => ({
    display: display(r),
    level: r.level,
    status: r.status,
    firstFiredOn: r.firstFiredOn,
    message: evalBy.get(r.ruleId)?.message ?? '',
  }));
  const alertsToday = (
    await db
      .select({ subject: alerts.subject })
      .from(alerts)
      .where(and(eq(alerts.asOfDate, date), inArray(alerts.kind, ['rule'])))
      .orderBy(asc(alerts.id))
  ).map((a) => a.subject);

  // Rules not checked today, grouped by reason.
  const ruleInfo = await db
    .select({
      id: exitRules.id,
      ruleType: exitRules.ruleType,
      symbol: instruments.symbol,
      name: instruments.name,
      type: instruments.instrumentType,
    })
    .from(exitRules)
    .innerJoin(instruments, eq(exitRules.instrumentId, instruments.id));
  const infoBy = new Map(ruleInfo.map((r) => [r.id, r]));
  const nc = new Map<string, string[]>();
  for (const e of todaysEvals.filter((x) => x.outcome === 'not_checked')) {
    const r = infoBy.get(e.exitRuleId);
    if (!r) continue;
    const key = REASON_TEXT[e.reason ?? ''] ?? e.reason ?? 'unknown';
    nc.set(key, [...(nc.get(key) ?? []), `${display(r)} ${r.ruleType}`]);
  }

  // Filings and headlines since the previous digest, per ticker we follow.
  const universe = await loadUniverse(db);
  const tickers = universe.newsSymbols;
  const heldSymbols = new Set(lotRows.map((l) => l.underlying ?? l.symbol));
  const order = (a: string, b: string) =>
    Number(heldSymbols.has(b)) - Number(heldSymbols.has(a)) || a.localeCompare(b);

  const fRows = tickers.length
    ? await db
        .select()
        .from(filings)
        .where(
          and(
            inArray(filings.ticker, tickers),
            gt(filings.filedAt, since),
            lte(filings.filedAt, until),
          ),
        )
        .orderBy(desc(filings.filedAt))
    : [];
  const filingGroups = [...new Set(fRows.map((f) => f.ticker!))].sort(order).map((ticker) => ({
    ticker,
    items: fRows
      .filter((f) => f.ticker === ticker)
      .map((f) => ({ form: f.form, items: f.items, filedAt: f.filedAt, url: f.url })),
  }));

  const nRows = await db
    .select({
      headline: newsItems.headline,
      url: newsItems.url,
      publishedAt: newsItems.publishedAt,
      symbols: newsItems.symbols,
    })
    .from(newsItems)
    .where(and(gt(newsItems.publishedAt, since), lte(newsItems.publishedAt, until)))
    .orderBy(desc(newsItems.publishedAt));
  const headlines = tickers
    .map((ticker) => {
      const all = nRows.filter((n) => n.symbols.includes(ticker));
      return {
        ticker,
        items: all
          .slice(0, HEADLINES_PER_TICKER)
          .map(({ headline, url, publishedAt }) => ({ headline, url, publishedAt })),
        more: Math.max(0, all.length - HEADLINES_PER_TICKER),
      };
    })
    .filter((h) => h.items.length)
    .sort((a, b) => order(a.ticker, b.ticker));

  const feedIssues = (await db.select().from(feedStatus))
    .filter((f) => !f.feed.includes(':') && (f.status === 'degraded' || f.status === 'down'))
    .map((f) => ({ feed: f.feed, status: f.status, detail: f.detail, since: f.since }));

  // Weekly: rules to write and missing user input.
  let rulesToWrite: DigestData['rulesToWrite'] = [];
  let needsInput: string[] = [];
  if (weekly) {
    const tw = new Map<string, string[]>();
    for (const r of rules) {
      if (!isRuleToWrite({ ruleType: r.ruleType, thesisBreakTriggers: r.judgment })) continue;
      const info = infoBy.get(r.id)!;
      tw.set(display(info), [...(tw.get(display(info)) ?? []), r.purpose.replace('_', ' ')]);
    }
    rulesToWrite = [...tw]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([d, purposes]) => ({ display: d, purposes }));
    const theses = await db
      .select({
        symbol: instruments.symbol,
        name: instruments.name,
        type: instruments.instrumentType,
        needs: positionTheses.needsInput,
      })
      .from(positionTheses)
      .innerJoin(instruments, eq(positionTheses.instrumentId, instruments.id))
      .orderBy(asc(instruments.symbol));
    needsInput = [
      ...lotRows
        .filter((l) => l.unconfirmed)
        .map((l) => `${l.symbol} (${ACCOUNT_LABEL[l.account]}): confirm the fill`),
      ...theses
        .filter((t) => t.needs.length)
        .map((t) => `${display(t)}: ${t.needs.map((n) => n.replace(/_/g, ' ')).join(', ')}`),
    ];
  }

  return {
    date,
    generatedAt: now,
    since,
    until,
    weekly,
    positions: positions.sort((a, b) => a.display.localeCompare(b.display)),
    active,
    alertsToday,
    notChecked: [...nc].map(([reason, items]) => ({ reason, items })),
    filings: filingGroups,
    headlines,
    feedIssues,
    rulesToWrite,
    needsInput,
  };
}

// ------------------------------------------------------------------------------------------------
// Rendering (pure)
// ------------------------------------------------------------------------------------------------

const fmtDate = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

function levelText(l: DigestLevel | null, kind: 'stop' | 'tp') {
  if (!l) return '—';
  const where =
    kind === 'stop'
      ? l.distPct >= 0
        ? `${l.distPct.toFixed(1)}% above`
        : `${Math.abs(l.distPct).toFixed(1)}% BELOW`
      : l.distPct >= 0
        ? `${l.distPct.toFixed(1)}% away`
        : `${Math.abs(l.distPct).toFixed(1)}% PAST`;
  const tag = l.status === 'CONFIRMED' ? '' : ` [${l.status.toLowerCase()}]`;
  return `${l.label} ${money(l.level)} (${where})${tag}`;
}

function lotsText(p: DigestPosition) {
  return p.lots
    .map(
      (l) =>
        `${ACCOUNT_LABEL[l.account] ?? l.account} ${l.quantity} @ ${money(l.avgCost)}${
          l.pctVsCost === null ? '' : ` (${signedPct(l.pctVsCost)})`
        }${l.unconfirmed ? ' (unconfirmed)' : ''}`,
    )
    .join(' · ');
}

function closeText(p: DigestPosition) {
  if (p.noData) return 'not checked: no data source';
  if (p.close === null) return 'no bar';
  const und = p.isOption ? ` (${p.evaluatedSymbol})` : '';
  return `${money(p.close)}${und} ${signedPct(p.dayPct)}`;
}

export function renderDigest(d: DigestData) {
  const subject = `[AIA] DIGEST ${fmtDate(d.date)}${
    d.active.length
      ? `: ${d.active.length} active condition${d.active.length === 1 ? '' : 's'}`
      : ''
  }`;
  const t: string[] = [];
  const h: string[] = [];
  const section = (title: string) => {
    t.push('', title.toUpperCase(), '-'.repeat(title.length));
    h.push(`<h3 style="margin:20px 0 6px;border-bottom:1px solid #ddd">${escapeHtml(title)}</h3>`);
  };
  const td = (s: string, extra = '') =>
    `<td style="padding:3px 8px;vertical-align:top;border-bottom:1px solid #f0f0f0${extra}">${s}</td>`;

  t.push(
    `Daily digest for the ${d.date} close. News and filings from ${ptTime(d.since)} to ${ptTime(d.until)}.`,
  );
  h.push(
    `<p>Daily digest for the <strong>${escapeHtml(fmtDate(d.date))}</strong> close. News and filings from ${escapeHtml(ptTime(d.since))} to ${escapeHtml(ptTime(d.until))}.</p>`,
  );

  if (d.feedIssues.length) {
    section('Feed problems');
    for (const f of d.feedIssues) {
      t.push(`! ${f.feed}: ${f.status} since ${ptTime(f.since)} (${f.detail ?? ''})`);
    }
    h.push(
      `<ul>${d.feedIssues.map((f) => `<li><strong>${escapeHtml(f.feed)}</strong>: ${escapeHtml(f.status)} since ${escapeHtml(ptTime(f.since))} (${escapeHtml(f.detail ?? '')})</li>`).join('')}</ul>`,
    );
  }

  section('Positions');
  h.push(
    `<table style="border-collapse:collapse;font-size:13px"><tr style="text-align:left;color:#555">${['Holding', 'Close (day)', 'Lots (vs cost)', 'Nearest stop', 'Nearest take-profit'].map((c) => td(`<strong>${c}</strong>`)).join('')}</tr>`,
  );
  for (const p of d.positions) {
    t.push(
      `${p.display}: ${closeText(p)} | ${lotsText(p)} | ${levelText(p.stop, 'stop')} | ${levelText(p.takeProfit, 'tp')}`,
    );
    h.push(
      `<tr>${td(`<strong>${escapeHtml(p.display)}</strong>`)}${td(escapeHtml(closeText(p)), ';white-space:nowrap')}${td(escapeHtml(lotsText(p)))}${td(escapeHtml(levelText(p.stop, 'stop')))}${td(escapeHtml(levelText(p.takeProfit, 'tp')))}</tr>`,
    );
  }
  h.push('</table>');
  if (d.positions.some((p) => p.isOption)) {
    t.push(
      'Options: close shown is the underlying; % vs cost needs option prices (not collected).',
    );
    h.push(
      '<p style="color:#555;font-size:12px">Options: close shown is the underlying; % vs cost needs option prices (not collected).</p>',
    );
  }

  section(`Still-active conditions (${d.active.length})`);
  if (d.active.length === 0) {
    t.push('None.');
    h.push('<p>None.</p>');
  } else {
    for (const a of d.active)
      t.push(`- ${a.display} [${a.status}] ${a.level} since ${a.firstFiredOn}: ${a.message}`);
    h.push(
      `<ul>${d.active.map((a) => `<li><strong>${escapeHtml(a.display)}</strong> <span style="color:#555">[${escapeHtml(a.status)}] since ${escapeHtml(a.firstFiredOn)}</span>: ${escapeHtml(a.message)}</li>`).join('')}</ul>`,
    );
  }

  if (d.alertsToday.length) {
    section('Alerts sent for this close');
    for (const s of d.alertsToday) t.push(`- ${s}`);
    h.push(`<ul>${d.alertsToday.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`);
  }

  section('Rules not checked');
  if (d.notChecked.length === 0) {
    t.push('All machine-checkable rules were checked.');
    h.push('<p>All machine-checkable rules were checked.</p>');
  } else {
    for (const n of d.notChecked) t.push(`- ${n.reason}: ${n.items.join(', ')}`);
    h.push(
      `<ul>${d.notChecked.map((n) => `<li><strong>${escapeHtml(n.reason)}</strong>: ${escapeHtml(n.items.join(', '))}</li>`).join('')}</ul>`,
    );
  }

  section('New filings');
  if (d.filings.length === 0) {
    t.push('None.');
    h.push('<p>None.</p>');
  } else {
    for (const g of d.filings) {
      for (const f of g.items) {
        t.push(
          `- ${g.ticker} ${f.form}${f.items.length ? ` (items ${f.items.join(', ')})` : ''} ${ptTime(f.filedAt)} ${f.url}`,
        );
      }
    }
    h.push(
      `<ul>${d.filings.flatMap((g) => g.items.map((f) => `<li><strong>${escapeHtml(g.ticker)}</strong> <a href="${escapeHtml(f.url)}">${escapeHtml(f.form)}</a>${f.items.length ? ` (items ${escapeHtml(f.items.join(', '))})` : ''} <span style="color:#555">${escapeHtml(ptTime(f.filedAt))}</span></li>`)).join('')}</ul>`,
    );
  }

  section('Headlines');
  if (d.headlines.length === 0) {
    t.push('None.');
    h.push('<p>None.</p>');
  } else {
    for (const g of d.headlines) {
      t.push(`${g.ticker}:`);
      for (const n of g.items) t.push(`  - ${n.headline}${n.url ? ` ${n.url}` : ''}`);
      if (g.more) t.push(`  (+${g.more} more)`);
    }
    h.push(
      d.headlines
        .map(
          (g) =>
            `<p style="margin:10px 0 2px"><strong>${escapeHtml(g.ticker)}</strong></p><ul style="margin-top:0">${g.items
              .map(
                (n) =>
                  `<li>${n.url ? `<a href="${escapeHtml(n.url)}">${escapeHtml(n.headline)}</a>` : escapeHtml(n.headline)}</li>`,
              )
              .join('')}${g.more ? `<li style="color:#555">+${g.more} more</li>` : ''}</ul>`,
        )
        .join(''),
    );
  }

  if (d.weekly) {
    section('Weekly: rules to write');
    if (d.rulesToWrite.length === 0) {
      t.push('None.');
      h.push('<p>None.</p>');
    } else {
      for (const r of d.rulesToWrite) t.push(`- ${r.display}: ${r.purposes.join(', ')}`);
      h.push(
        `<ul>${d.rulesToWrite.map((r) => `<li><strong>${escapeHtml(r.display)}</strong>: ${escapeHtml(r.purposes.join(', '))}</li>`).join('')}</ul>`,
      );
    }
    section('Weekly: missing input');
    if (d.needsInput.length === 0) {
      t.push('None.');
      h.push('<p>None.</p>');
    } else {
      for (const n of d.needsInput) t.push(`- ${n}`);
      h.push(`<ul>${d.needsInput.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`);
    }
  }

  t.push('', `Generated ${ptTime(d.generatedAt)}.`);
  h.push(`<p style="color:#555">Generated ${escapeHtml(ptTime(d.generatedAt))}.</p>`);
  return { subject, text: t.join('\n').trimStart(), html: htmlDoc(subject, h.join('\n')) };
}

/** The session whose digest should go out now (trading day, 2:15 PM PT passed, not yet sent). */
export function digestDue(
  sessionDates: readonly string[],
  now: Date,
  lastDigestDate: string | null,
): string | null {
  const today = nyDate(now);
  if (!sessionDates.includes(today)) return null;
  if (now < digestTimeFor(today)) return null;
  if (lastDigestDate && lastDigestDate >= today) return null;
  return today;
}
