/** @jsxRuntime automatic @jsxImportSource react */
import { AttentionCard } from '../components/AttentionCard';
import { FilingsList, type FilingItem } from '../components/FilingsList';
import { Footer } from '../components/Footer';
import { Header } from '../components/Header';
import { HeadlinesList, type HeadlineItem } from '../components/HeadlinesList';
import { KpiTiles, type KpiTile } from '../components/KpiTiles';
import { Box, EmailShell, Note, Section } from '../components/layout';
import type { PillTone } from '../components/Pill';
import { PositionsTable, type PositionRow } from '../components/PositionsTable';
import type { RangeBarProps } from '../components/RangeBar';
import { signedMoney, signedPct, toneColor } from '../format';
import { EmailTooLargeError, renderHtml } from '../render';
import { color, type Severity } from '../tokens';

/** P/L shown in a card footer: "−$992 (−4.8%)", colored. */
export interface PlFigure {
  dollars: number;
  pct: number | null;
}

export interface AttentionCardData {
  severity: Severity;
  ticker: string;
  pills: { label: string; tone: PillTone }[];
  price: string | null;
  changePct: number | null;
  body: string;
  range: RangeBarProps | null;
  /** "Your position: 140 sh across 3 lots" · P/L · "36% of portfolio" */
  position: { lead: string; pl: PlFigure | null; tail: string | null } | null;
  compact: boolean;
}

/** JSON-safe props: the worker builds them from the day's data; the preview loads them from disk. */
export interface DigestEmailProps {
  subject: string;
  preview: string;
  subtitle: string;
  kpis: KpiTile[];
  /** Rules alerted today (first alert or escalation), most severe first. */
  alerts: AttentionCardData[];
  /** Conditions still true but alerted on an earlier day. */
  active: AttentionCardData[];
  levelsToWatch: string[];
  positions: PositionRow[];
  /** "Options & untracked" box entries. */
  optionsBox: string[];
  filings: FilingItem[];
  headlines: { items: HeadlineItem[]; notes: string[]; watchlist: string | null };
  /** Last session of the week only. */
  weekly: { rulesToWrite: string[]; needsInput: string[] } | null;
  footer: string[];
}

export const plText = (pl: PlFigure) =>
  `${signedMoney(pl.dollars)}${pl.pct === null ? '' : ` (${signedPct(pl.pct)})`}`;

function PositionLine({
  p,
  compact,
}: {
  p: NonNullable<AttentionCardData['position']>;
  compact: boolean;
}) {
  return (
    <>
      {p.lead}
      {p.pl ? (
        <>
          {compact ? ' ' : ' · '}
          <span style={{ color: toneColor(p.pl.dollars) }}>{plText(p.pl)}</span>
        </>
      ) : null}
      {p.tail ? ` · ${p.tail}` : null}
    </>
  );
}

function Card({ a }: { a: AttentionCardData }) {
  return (
    <AttentionCard
      severity={a.severity}
      ticker={a.ticker}
      pills={a.pills}
      price={a.price ?? undefined}
      changePct={a.changePct}
      body={a.body}
      range={a.range ?? undefined}
      compact={a.compact}
      footer={a.position ? <PositionLine p={a.position} compact={a.compact} /> : undefined}
    />
  );
}

/** Section order matches the morning email: alerts, filings, headlines, prices, levels, active. */
export function DigestEmail(p: DigestEmailProps) {
  return (
    <EmailShell preview={p.preview}>
      <Header kicker="AI Investment Analyst" title="📊 Daily Digest" subtitle={p.subtitle}>
        <KpiTiles tiles={p.kpis} wideFirst />
      </Header>

      <Section emoji="🔔" title="Alerts today">
        {p.alerts.length === 0 ? (
          <Note style={{ marginTop: 0 }}>None.</Note>
        ) : (
          p.alerts.map((a, i) => <Card key={`${a.ticker}-${i}`} a={a} />)
        )}
      </Section>

      {p.filings.length ? (
        <Section emoji="🏛️" title="SEC filings">
          <FilingsList items={p.filings} />
        </Section>
      ) : null}

      {p.headlines.items.length || p.headlines.watchlist ? (
        <Section emoji="📰" title="Headlines" note="holdings · each story once">
          {p.headlines.items.length ? <HeadlinesList items={p.headlines.items} /> : null}
          {p.headlines.notes.length ? <Note>{p.headlines.notes.join(' · ')}</Note> : null}
          {p.headlines.watchlist ? (
            <Box style={{ marginTop: 6 }}>
              <b>Watchlist stories:</b> {p.headlines.watchlist}
            </Box>
          ) : null}
        </Section>
      ) : null}

      <Section emoji="💼" title="Positions" note="sorted by today's move">
        <PositionsTable rows={p.positions} />
        <Note style={{ fontSize: 11, color: color.faint, marginTop: 6 }}>
          R = Roth IRA · I = Individual · Next level = nearest stop, tier, take-profit, cost or 52w
          low and the distance to it (orange within 7%)
        </Note>
        {p.optionsBox.length ? (
          <Box style={{ marginTop: 10 }}>
            <b>Options &amp; untracked:</b> {p.optionsBox.join(' · ')}
          </Box>
        ) : null}
      </Section>

      {p.levelsToWatch.length ? (
        <Section emoji="👀" title="Levels to watch">
          {p.levelsToWatch.map((l) => (
            <div key={l} style={{ fontSize: 13, color: color.body, padding: '3px 0' }}>
              {l}
            </div>
          ))}
        </Section>
      ) : null}

      {p.active.length ? (
        <Section emoji="🎯" title="Still-active conditions">
          {p.active.map((a, i) => (
            <Card key={`${a.ticker}-${i}`} a={a} />
          ))}
        </Section>
      ) : null}

      {p.weekly && (p.weekly.rulesToWrite.length || p.weekly.needsInput.length) ? (
        <Section emoji="🗒️" title="Weekly: rules to write and missing input">
          {p.weekly.rulesToWrite.length ? (
            <Box>
              <b>Rules to write:</b> {p.weekly.rulesToWrite.join(' · ')}
            </Box>
          ) : null}
          {p.weekly.needsInput.length ? (
            <Box style={{ marginTop: 6 }}>
              <b>Needs your input:</b> {p.weekly.needsInput.join(' · ')}
            </Box>
          ) : null}
        </Section>
      ) : null}

      <Footer lines={p.footer} />
    </EmailShell>
  );
}

// ---- Plain text ---------------------------------------------------------------------------------

const heading = (s: string) => `\n${s.toUpperCase()}\n${'-'.repeat(s.length)}`;

/** Plain-text version with the same content and order as the HTML. */
export function renderDigestText(p: DigestEmailProps): string {
  const t: string[] = [p.subtitle, ''];
  t.push(p.kpis.map((k) => `${k.label}: ${k.value}${k.sub ? ` (${k.sub})` : ''}`).join(' | '));

  const card = (a: AttentionCardData) => {
    const pills = a.pills.length ? ` [${a.pills.map((x) => x.label).join(', ')}]` : '';
    const price = a.price
      ? ` ${a.price}${a.changePct === null ? '' : ` ${signedPct(a.changePct)}`}`
      : '';
    const pos = a.position
      ? ` | ${a.position.lead}${a.position.pl ? ` ${plText(a.position.pl)}` : ''}${a.position.tail ? ` · ${a.position.tail}` : ''}`
      : '';
    return `- ${a.severity.toUpperCase()} ${a.ticker}${pills}:${price} — ${a.body}${pos}`;
  };

  t.push(heading('Alerts today'));
  if (p.alerts.length === 0) t.push('- none');
  for (const a of p.alerts) t.push(card(a));

  if (p.filings.length) {
    t.push(heading('SEC filings'));
    for (const f of p.filings) {
      t.push(
        `- ${f.tickers.join(', ')}: ${f.title}${f.detail ? ` ${f.detail}` : ''}${f.href ? ` ${f.href}` : ''}`,
      );
      for (const l of f.lines ?? []) t.push(`    ${l}`);
    }
  }

  if (p.headlines.items.length || p.headlines.watchlist) {
    t.push(heading('Headlines'));
    for (const h of p.headlines.items) {
      const tickers = [...h.tickers, ...(h.otherTickers ?? []).map((x) => `${x} (watchlist)`)];
      t.push(
        `- ${h.title} — ${h.source}, ${h.day} [${tickers.join(', ')}]${h.extra ? ` (${h.extra})` : ''}${h.href ? `\n  ${h.href}` : ''}`,
      );
    }
    if (p.headlines.notes.length) t.push(p.headlines.notes.join(' · '));
    if (p.headlines.watchlist) t.push(`Watchlist stories: ${p.headlines.watchlist}`);
  }

  t.push(heading("Positions (by today's move)"));
  for (const r of p.positions) {
    const pl =
      r.plDollars === null
        ? '—'
        : `${signedMoney(r.plDollars)}${r.plPct === null ? '' : ` (${signedPct(r.plPct)})`}`;
    const next = r.next ? `${r.next.text}${r.next.pill ? ` [${r.next.pill}]` : ''}` : '—';
    t.push(
      `- ${r.ticker} ${r.accountTag}${r.lotLine ? ` (${r.lotLine})` : ''}: ${r.price}${r.dayPct === null ? '' : ` ${signedPct(r.dayPct)}`} | ${r.value} | P/L ${pl} | next: ${next}`,
    );
  }
  if (p.optionsBox.length) t.push(`Options & untracked: ${p.optionsBox.join(' · ')}`);

  if (p.levelsToWatch.length) {
    t.push(heading('Levels to watch'));
    for (const l of p.levelsToWatch) t.push(`- ${l}`);
  }

  if (p.active.length) {
    t.push(heading('Still-active conditions'));
    for (const a of p.active) t.push(card(a));
  }

  if (p.weekly && (p.weekly.rulesToWrite.length || p.weekly.needsInput.length)) {
    t.push(heading('Weekly: rules to write and missing input'));
    if (p.weekly.rulesToWrite.length)
      t.push(`Rules to write: ${p.weekly.rulesToWrite.join(' · ')}`);
    if (p.weekly.needsInput.length) t.push(`Needs your input: ${p.weekly.needsInput.join(' · ')}`);
  }

  t.push('', '--', ...p.footer, 'AI Investment Analyst · research and alerts only, no trading');
  return t.join('\n');
}

/**
 * A smaller version for very busy days: one-line cards, at most 12 filings and 3 headlines,
 * 8 levels to watch. Positions are never dropped.
 */
export function trimDigestProps(p: DigestEmailProps): DigestEmailProps {
  const filings =
    p.filings.length > 12
      ? [
          ...p.filings.slice(0, 12),
          { tickers: [], title: `+ ${p.filings.length - 12} more filings (see EDGAR)` },
        ]
      : p.filings;
  return {
    ...p,
    alerts: p.alerts.map((a) => ({ ...a, compact: true, range: null, pills: [] })),
    active: p.active.map((a) => ({ ...a, compact: true, range: null, pills: [] })),
    levelsToWatch: p.levelsToWatch.slice(0, 8),
    filings: filings.map((f) => ({ ...f, lines: (f.lines ?? []).slice(0, 2) })),
    headlines: { ...p.headlines, items: p.headlines.items.slice(0, 3) },
  };
}

/**
 * Subject, HTML and plain text for a digest. If the HTML would be clipped by Gmail, the trimmed
 * version is sent instead (and, as a last resort, sent clipped rather than not at all).
 */
export async function renderDigestEmail(p: DigestEmailProps) {
  const text = renderDigestText(p);
  try {
    return {
      subject: p.subject,
      html: await renderHtml(<DigestEmail {...p} />),
      text,
      trimmed: false,
    };
  } catch (e) {
    if (!(e instanceof EmailTooLargeError)) throw e;
    const t = trimDigestProps(p);
    try {
      return {
        subject: p.subject,
        html: await renderHtml(<DigestEmail {...t} />),
        text,
        trimmed: true,
      };
    } catch (e2) {
      if (!(e2 instanceof EmailTooLargeError)) throw e2;
      return {
        subject: p.subject,
        html: await renderHtml(<DigestEmail {...t} />, { guard: false }),
        text,
        trimmed: true,
      };
    }
  }
}
