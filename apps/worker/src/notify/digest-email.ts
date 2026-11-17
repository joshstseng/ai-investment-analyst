/**
 * Digest view model (pure): DigestData → DigestEmailProps (subject, inbox preview text, KPI tiles,
 * attention cards, positions, filings, headlines, footer). Rendering lives in @aia/emails.
 */
import {
  sourceDomain,
  type AttentionTag,
  type HeadlineSelection,
  type LevelToWatch,
} from '@aia/core';
import {
  color,
  money,
  pct,
  renderDigestEmail,
  signedMoney,
  signedPct,
  type AttentionCardData,
  type DigestEmailProps,
  type FilingItem,
  type HeadlineItem,
  type KpiTile,
  type PositionRow,
  type Severity,
} from '@aia/emails';
import type { TradeSummary } from '../sec/form4';
import type { AttentionItem, DigestData, DigestPosition } from './digest';

const TZ = 'America/Los_Angeles';
const SEVERITY_OF: Record<AttentionTag, Severity> = {
  ACTION: 'action',
  WARNING: 'warning',
  REVIEW: 'review',
  REMINDER: 'reminder',
};
const TAG_EMOJI: Record<AttentionTag, string> = {
  ACTION: '‼️',
  WARNING: '⚠️',
  REVIEW: '📝',
  REMINDER: '💡',
};

const dateLabel = (date: string, withWeekday = true) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    ...(withWeekday ? { weekday: 'short' as const } : {}),
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
const ptLabel = (d: Date | string, opts: Intl.DateTimeFormatOptions) =>
  new Date(d).toLocaleString('en-US', { timeZone: TZ, ...opts });
const ptShort = (d: Date | string) =>
  `${ptLabel(d, { weekday: 'short' })} ${ptLabel(d, { hour: 'numeric', minute: '2-digit' })}`;
const price = (n: number) => money(n, n < 1 ? 4 : 2);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const statusPill = (status: string) => (status === 'CONFIRMED' ? undefined : status.toLowerCase());

// ---- Subject and inbox preview ------------------------------------------------------------------

/** "📊 [AIA] DIGEST Nov 16 · −2.5% · 4 alerts" */
export function digestSubject(d: DigestData): string {
  const parts = [`📊 [AIA] DIGEST ${dateLabel(d.date, false)}`];
  if (d.portfolio.pct !== null) parts.push(signedPct(d.portfolio.pct));
  parts.push(plural(d.alertsToday.length, 'alert'));
  return parts.join(' · ');
}

/** Short phrase for one attention item, e.g. "ETFX 17.5% off high", "SPCQ new low". */
function shortPhrase(a: AttentionItem): string {
  const o = a.observed as { drawdownPct?: number; movePct?: number };
  if (a.ruleType === 'etf_drawdown_from_52w_high' && typeof o.drawdownPct === 'number') {
    return `${a.display} ${pct(o.drawdownPct)} off high`;
  }
  if (a.ruleType === 'day_move_pct' && typeof o.movePct === 'number') {
    return `${a.display} ${signedPct(o.movePct)}`;
  }
  const byLevel: Record<string, string> = {
    stop: 'below stop',
    warning: 'at warning level',
    take_profit: 'take-profit',
    trailing_stop: 'trailing stop hit',
    new_low: 'new low',
    below_cost: 'below cost',
    time_stop: 'time-stop review',
    reminder: 'reminder',
  };
  return `${a.display} ${byLevel[a.level] ?? a.level.replace(/_/g, ' ')}`;
}

/** Hidden inbox preview: the top 3 attention items and an earnings 8-K, e.g. "ETFX 17.5% off high · SPCQ new low · ACMX results 8-K". */
export function digestPreviewText(d: DigestData): string {
  const parts = d.attention.slice(0, 3).map(shortPhrase);
  const earnings = d.filingList.find(
    (f) => f.title.startsWith('8-K') && f.title.includes('results'),
  );
  if (earnings) parts.push(`${earnings.tickers[0]} results 8-K`);
  if (parts.length === 0) {
    parts.push('No alerts or active conditions');
    if (d.portfolio.pct !== null) parts.push(`portfolio ${signedPct(d.portfolio.pct)}`);
  }
  return parts.join(' · ');
}

// ---- KPI tiles ----------------------------------------------------------------------------------

function alertMixLabel(mix: DigestData['alertMix'], total: number): string {
  if (total === 0) return 'none today';
  const tags = (Object.keys(mix) as AttentionTag[]).filter((t) => mix[t]);
  if (tags.length === 1) return `all ${TAG_EMOJI[tags[0]!]} ${tags[0]!.toLowerCase()}`;
  return (['ACTION', 'WARNING', 'REVIEW', 'REMINDER'] as const)
    .filter((t) => mix[t])
    .map((t) => `${mix[t]} ${TAG_EMOJI[t]}`)
    .join(' · ');
}

function kpis(d: DigestData): KpiTile[] {
  const p = d.portfolio;
  const up = p.change > 0;
  const flat = Math.round(p.change) === 0;
  return [
    {
      label: 'Portfolio today',
      value: signedMoney(p.change),
      valueColor: flat ? undefined : up ? color.gainOnNavy : color.lossOnNavy,
      sub: `${p.pct === null ? '—' : signedPct(p.pct)} · value ${money(p.value, 0)}`,
      subColor: flat ? undefined : up ? color.gainOnNavy : color.lossSubOnNavy,
    },
    {
      label: 'Alerts',
      value: String(d.alertsToday.length),
      sub: alertMixLabel(d.alertMix, d.alertsToday.length),
    },
    {
      label: 'Active',
      value: String(d.attention.filter((a) => !a.alertedToday).length),
      sub: 'still active',
    },
    {
      label: 'Filings',
      value: String(d.filingCounts.total),
      sub: d.filingCounts.earnings8k
        ? `${d.filingCounts.earnings8k} earnings 8-K`
        : 'since last digest',
    },
  ];
}

// ---- Needs attention ----------------------------------------------------------------------------

function attentionBody(a: AttentionItem, next: LevelToWatch | null): string {
  const o = a.observed as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : null);
  switch (a.ruleType) {
    case 'etf_drawdown_from_52w_high': {
      const dd = n('drawdownPct');
      const high = n('high');
      const tier = n('tier') ?? Number(/drawdown_(\d+)/.exec(a.level)?.[1] ?? NaN);
      const nextTier =
        next?.kind === 'drawdown_tier'
          ? ` Next tier (${next.label.split(' ')[0]}) at ${price(next.level)}.`
          : ' Past the deepest tier.';
      return `${dd === null ? '' : `${pct(dd)} `}below the 52-week high${high === null ? '' : ` (${price(high)})`}, ${a.escalated ? 'crossing' : 'past'} the ${tier}% tier.${nextTier}`;
    }
    case 'stop_close_below': {
      const close = n('close');
      const level = n('level');
      const warn = n('warnLevel');
      if (a.level === 'warning') {
        return `Closed at ${close === null ? '—' : price(close)}, at or below the ${warn === null ? '' : `${price(warn)} `}warning level${level === null ? '' : ` (stop ${price(level)})`}.`;
      }
      return `Closed at ${close === null ? '—' : price(close)}, below the ${level === null ? '' : `${price(level)} `}stop.`;
    }
    case 'take_profit_at_or_above': {
      const level = n('level');
      return `Reached the ${level === null ? '' : `${price(level)} `}take-profit.`;
    }
    case 'trailing_close_pct_from_high': {
      const hi = n('highestClose');
      const trig = n('triggerLevel');
      return `Closed at or below the trailing stop${trig === null ? '' : ` (${price(trig)})`}${hi === null ? '' : `, ${n('pct') ?? ''}% below the highest close of ${price(hi)}`}.`;
    }
    case 'day_move_pct':
      return `one-day move past ±${n('threshold') ?? ''}%`;
    case 'new_52w_low': {
      const prior = n('priorLowClose');
      return `new 52-week closing low${prior === null ? '' : ` (was ${price(prior)})`}`;
    }
    case 'close_below_cost': {
      const cost = n('cost');
      return `closed below your ${cost === null ? '' : `${price(cost)} `}cost${typeof o.lot === 'string' ? ` (${o.lot})` : ''}`;
    }
    default:
      return a.message;
  }
}

function attentionCard(a: AttentionItem, d: DigestData): AttentionCardData {
  const pos = d.positions.find((p) => p.symbol === a.symbol) ?? null;
  const pills: AttentionCardData['pills'] = [{ label: a.status.toLowerCase(), tone: 'neutral' }];
  if (a.escalated) pills.push({ label: 'escalated', tone: 'escalated' });
  else if (!a.alertedToday && a.firstFiredOn && a.firstFiredOn < d.date) {
    pills.push({ label: `active since ${dateLabel(a.firstFiredOn, false)}`, tone: 'neutral' });
  }
  const p = a.position;
  const plFigure = p && p.plDollars !== null ? { dollars: p.plDollars, pct: p.plPct } : null;
  const position = !p
    ? null
    : a.compact
      ? plFigure
        ? { lead: 'position', pl: plFigure, tail: null }
        : null
      : {
          lead: `Your position: ${Number(p.shares.toFixed(3))} sh${p.lots > 1 ? ` across ${p.lots} lots` : ''}`,
          pl: plFigure,
          tail: p.weightPct === null ? null : `${Math.round(p.weightPct)}% of portfolio`,
        };
  return {
    severity: SEVERITY_OF[a.tag],
    ticker: a.display,
    pills: a.compact ? [] : pills,
    price: a.close === null ? null : price(a.close),
    changePct: a.dayPct,
    body: attentionBody(a, pos?.next ?? null),
    range: a.range
      ? {
          left: `${a.range.left.label} ${price(a.range.left.value)}`,
          right: `${a.range.right.label} ${price(a.range.right.value)}`,
          markerPct: a.range.markerPct,
        }
      : null,
    position,
    compact: a.compact,
  };
}

export function levelPhrase(l: LevelToWatch): string {
  const what =
    l.kind === 'drawdown_tier'
      ? l.label.replace(' drawdown tier', ' tier')
      : l.kind === 'warning'
        ? 'warning level'
        : l.label;
  // Only DRAFT is called out; almost every tier is a PLACEHOLDER, so saying so adds noise.
  const draft = l.status === 'DRAFT' ? ' draft' : '';
  return `${l.display} ${price(l.close)}, ${l.distancePct.toFixed(1)}% ${l.direction === 'down' ? 'above' : 'below'} its ${price(l.level)}${draft} ${what}`;
}

// ---- Positions ----------------------------------------------------------------------------------

function nextText(p: DigestPosition): PositionRow['next'] {
  if (p.atNewLow) return { text: 'at 52w low', near: true };
  const l = p.next;
  if (!l) return null;
  const where = `${l.distancePct.toFixed(1)}%`;
  const text =
    l.kind === 'drawdown_tier'
      ? `${l.label.replace(' drawdown tier', ' tier')} ${price(l.level)} · ${where}`
      : `${l.kind === 'warning' ? 'warning' : l.label} ${price(l.level)} · ${where}`;
  return { text, pill: statusPill(l.status), near: l.distancePct < 7 };
}

function positionRow(p: DigestPosition): PositionRow {
  return {
    ticker: p.display,
    accountTag: p.accountTag,
    lotLine: p.lotLine ?? undefined,
    price: p.close === null ? '—' : price(p.close),
    dayPct: p.dayPct,
    value: p.value === null ? '—' : money(p.value, 0),
    plDollars: p.plDollars,
    plPct: p.plPct,
    next: nextText(p),
  };
}

/** Shortens at a word boundary: "Tax checkpoint: decide sell-for-loss; no rebuy…". */
export function shortTitle(s: string, max = 60): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, '')}…`;
}

function optionsBoxEntry(p: DigestPosition): string {
  const reminder = p.reminder
    ? ` · 💡 ${dateLabel(p.reminder.date, false)}: ${shortTitle(p.reminder.title, 50)}`
    : '';
  if (p.noData) return `${p.display} · no data source${reminder}`;
  if (p.close === null) return `${p.display} · no price today${reminder}`;
  const o = p.option;
  const strike =
    o && o.vsStrikePct !== null
      ? `, ${pct(o.vsStrikePct)} ${o.vsStrikePct >= 0 ? 'above' : 'below'} strike`
      : '';
  return `${p.display} · ${p.evaluatedSymbol} ${price(p.close)} ${p.dayPct === null ? '' : signedPct(p.dayPct)}${strike}${reminder}`;
}

// ---- Filings and headlines ----------------------------------------------------------------------

export function tradeLine(t: TradeSummary): string {
  const verb = t.code === 'P' ? 'bought' : 'sold';
  const avg = t.avgPrice === null ? '' : ` @ ${price(t.avgPrice)} avg`;
  return `${t.owner}${t.role ? ` (${t.role})` : ''} ${verb} ${t.shares.toLocaleString('en-US')} sh${avg} (${money(t.value, 0)})${t.plan10b51 ? ' · 10b5-1 plan' : ''}`;
}

function filingItems(d: DigestData): FilingItem[] {
  return d.filingList.map((f) => ({
    tickers: f.tickers,
    title: f.title,
    href: f.url ?? undefined,
    strong: f.strong,
    detail:
      [f.itemsNote ? `(${f.itemsNote})` : null, f.filedAt ? ptShort(f.filedAt) : null]
        .filter(Boolean)
        .join(' · ') || undefined,
    lines: f.trades.map(tradeLine),
  }));
}

export function headlinesProps(sel: HeadlineSelection): DigestEmailProps['headlines'] {
  const items: HeadlineItem[] = sel.shown.map((s) => ({
    title: s.story.headline,
    href: s.story.url ?? undefined,
    source: sourceDomain(s.story.url) ?? 'Benzinga',
    day: ptLabel(s.story.publishedAt, { weekday: 'short' }),
    tickers: s.holdings,
    otherTickers: s.watchlist,
    extra: s.moreForTicker
      ? `+${s.moreForTicker} more ${s.holdings[0]} ${s.moreForTicker === 1 ? 'story' : 'stories'}`
      : undefined,
  }));
  const notes: string[] = [];
  if (sel.more)
    notes.push(`+ ${sel.more} more holding ${sel.more === 1 ? 'headline' : 'headlines'}`);
  if (sel.filtered.count) {
    notes.push(
      `${sel.filtered.count} filtered as noise${sel.filtered.example ? ` (e.g. "${shortTitle(sel.filtered.example, 70)}")` : ''}`,
    );
  }
  const w = sel.watchlist;
  const watchlist = w.counts.length
    ? `${w.counts.map((c) => `${c.ticker} ${c.stories}`).join(' · ')}${w.top ? ` · top: ${shortTitle(w.top.headline, 90)}` : ''}`
    : null;
  return { items, notes, watchlist };
}

// ---- Footer -------------------------------------------------------------------------------------

const RULE_LABEL: Record<string, string> = {
  day_move_pct: 'day move',
  stop_close_below: 'stop',
  take_profit_at_or_above: 'take-profit',
  trailing_close_pct_from_high: 'trailing stop',
  etf_drawdown_from_52w_high: 'drawdown tiers',
  new_52w_low: '52w low',
  close_below_cost: 'below cost',
  option_value_below: 'option value',
  time_stop: 'time stop',
  date_reminder: 'reminder',
};

function footer(d: DigestData, barsFeed: string): string[] {
  const feeds = d.feedIssues.length
    ? `🩺 Feed issues: ${d.feedIssues.map((f) => `${f.feed} ${f.status}${f.detail ? ` (${f.detail})` : ''}`).join('; ')}`
    : '🩺 Feeds OK';
  const lines = [
    `${feeds} · prices: Alpaca ${barsFeed.toUpperCase()} daily bars · filings: SEC EDGAR · news: Benzinga`,
  ];
  if (d.notChecked.length) {
    lines.push(
      `Not checked: ${d.notChecked
        .map(
          (g) =>
            `${g.items
              .map((i) => {
                // "<display> <rule_type>"; option displays contain spaces.
                const at = i.lastIndexOf(' ');
                const type = i.slice(at + 1);
                return `${i.slice(0, at)} ${RULE_LABEL[type] ?? type}`;
              })
              .join(', ')} (${g.reason})`,
        )
        .join(' · ')}`,
    );
  }
  lines.push(
    `Close of ${dateLabel(d.date)} · news & filings since ${ptShort(d.since)} PT · generated ${ptShort(d.generatedAt)} PT`,
  );
  return lines;
}

// ---- Props --------------------------------------------------------------------------------------

export function digestEmailProps(d: DigestData, opts: { barsFeed: string }): DigestEmailProps {
  const table = d.positions.filter((p) => !p.isOption && !p.noData && p.close !== null);
  const box = d.positions.filter((p) => !table.includes(p));
  return {
    subject: digestSubject(d),
    preview: digestPreviewText(d),
    subtitle: `${dateLabel(d.date)} · close · news & filings since ${ptShort(d.since)} PT`,
    kpis: kpis(d),
    alerts: d.attention.filter((a) => a.alertedToday).map((a) => attentionCard(a, d)),
    active: d.attention.filter((a) => !a.alertedToday).map((a) => attentionCard(a, d)),
    levelsToWatch: d.levelsToWatch.map(levelPhrase),
    positions: table.map(positionRow),
    optionsBox: box.map(optionsBoxEntry),
    filings: filingItems(d),
    headlines: headlinesProps(d.headlineSelection),
    pullbacks: d.pullbacks
      ? {
          note: `${d.pullbacks.total} in the screen · ${d.pullbacks.changed} changed today`,
          rows: d.pullbacks.rows,
          more: d.pullbacks.more,
        }
      : null,
    weekly: d.weekly
      ? {
          rulesToWrite: d.rulesToWrite.map((r) => `${r.display} (${r.purposes.join(', ')})`),
          needsInput: d.needsInput,
        }
      : null,
    footer: footer(d, opts.barsFeed),
  };
}

/** Subject, HTML and plain text for the digest. */
export async function composeDigest(d: DigestData, opts: { barsFeed: string }) {
  const props = digestEmailProps(d, opts);
  return { props, ...(await renderDigestEmail(props)) };
}
