/** @jsxRuntime automatic @jsxImportSource react */
import type { CSSProperties } from 'react';
import { FilingsList, type FilingItem } from '../components/FilingsList';
import { Footer } from '../components/Footer';
import { Header } from '../components/Header';
import { HeadlinesList, type HeadlineItem } from '../components/HeadlinesList';
import { KpiTiles, type KpiTile } from '../components/KpiTiles';
import { Box, EmailShell, Note, Section, Table } from '../components/layout';
import { Pill, type PillTone } from '../components/Pill';
import { signedPct, toneColor } from '../format';
import { renderHtml } from '../render';
import { color, SEVERITY, type Severity } from '../tokens';

export interface EconRow {
  /** "5:30 AM" (recap: "Tue 5:30 AM"), or "all day". */
  time: string;
  event: string;
  impact: string;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  /** e.g. "released 5:30 AM, see brief" (no actual in the feed yet). */
  status: string | null;
}

export interface UpcomingItem {
  /** "Tue 12/1" */
  date: string;
  ticker: string;
  /** "earnings after close (confirmed)" */
  what: string;
  title: string;
  /** "moved from Mon 11/30" */
  moved: string | null;
  note: string | null;
  source: string;
  sourceTone: PillTone;
}

/** JSON-safe props for the weekday morning email. */
export interface MorningEmailProps {
  subject: string;
  preview: string;
  title: string;
  /** Today: date, open/close (early close), or "market closed · next session …". */
  subtitle: string;
  kpis: KpiTile[];
  alerts: {
    title: string;
    items: { time: string; severity: Severity | null; text: string; pending: boolean }[];
  };
  econ: { title: string; available: boolean; rows: EconRow[] } | null;
  filings: FilingItem[];
  headlines: { items: HeadlineItem[]; notes: string[]; watchlist: string | null } | null;
  premarket: {
    title: string;
    note: string | null;
    rows: { symbol: string; close: string; pre: string; changePct: number | null }[];
  } | null;
  levels: string[];
  active: { ticker: string; status: string; since: string; message: string }[];
  upcoming: { title: string; note: string | null; items: UpcomingItem[] } | null;
  lastWeek: { rows: { symbol: string; changePct: number | null }[]; alerts: string[] } | null;
  footer: string[];
}

const th: CSSProperties = {
  padding: '5px 6px 5px 0',
  borderBottom: `1px solid ${color.line}`,
  fontSize: 11,
  color: color.muted,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  textAlign: 'left',
  whiteSpace: 'nowrap',
};
const td: CSSProperties = {
  padding: '6px 6px 6px 0',
  borderBottom: `1px solid ${color.rowLine}`,
  fontSize: 13,
  verticalAlign: 'top',
  color: color.text,
};

function EconTable({ rows }: { rows: EconRow[] }) {
  return (
    <Table>
      <tr>
        <td style={th}>Time PT</td>
        <td style={th}>Event</td>
        <td style={{ ...th, textAlign: 'right' }}>Fcst</td>
        <td style={{ ...th, textAlign: 'right' }}>Prev</td>
        <td style={{ ...th, textAlign: 'right' }}>Actual</td>
      </tr>
      {rows.map((r, i) => (
        <tr key={i}>
          <td style={{ ...td, whiteSpace: 'nowrap', color: color.muted }}>{r.time}</td>
          <td style={td}>
            <Pill tone={r.impact === 'High' ? 'loss' : 'neutral'} size="xs">
              {r.impact}
            </Pill>{' '}
            {r.event}
            {r.status ? <div style={{ fontSize: 11, color: color.muted }}>{r.status}</div> : null}
          </td>
          <td align="right" style={{ ...td, whiteSpace: 'nowrap' }}>
            {r.forecast ?? '—'}
          </td>
          <td align="right" style={{ ...td, whiteSpace: 'nowrap', color: color.muted }}>
            {r.previous ?? '—'}
          </td>
          <td
            align="right"
            style={{ ...td, whiteSpace: 'nowrap', fontWeight: r.actual ? 700 : 400 }}
          >
            {r.actual ?? '—'}
          </td>
        </tr>
      ))}
    </Table>
  );
}

export function MorningEmail(p: MorningEmailProps) {
  return (
    <EmailShell preview={p.preview}>
      <Header kicker="AI Investment Analyst" title={p.title} subtitle={p.subtitle}>
        <KpiTiles tiles={p.kpis} />
      </Header>

      <Section emoji="🔔" title={p.alerts.title}>
        {p.alerts.items.length === 0 ? (
          <Note style={{ marginTop: 0 }}>None.</Note>
        ) : (
          <Table>
            {p.alerts.items.map((a, i) => (
              <tr key={i}>
                <td style={{ ...td, whiteSpace: 'nowrap', color: color.muted, width: 1 }}>
                  {a.time}
                </td>
                <td style={td}>
                  {a.severity ? `${SEVERITY[a.severity].emoji} ` : ''}
                  {a.text}
                  {a.pending ? (
                    <span style={{ color: color.warning }}> (not yet emailed)</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      {p.econ ? (
        <Section emoji="🗓️" title={p.econ.title}>
          {p.econ.available ? (
            <EconTable rows={p.econ.rows} />
          ) : (
            <Note style={{ marginTop: 0 }}>Unavailable (calendar feed not fetched today).</Note>
          )}
        </Section>
      ) : null}

      {p.filings.length ? (
        <Section emoji="🏛️" title="New SEC filings">
          <FilingsList items={p.filings} />
        </Section>
      ) : null}

      {p.headlines && (p.headlines.items.length || p.headlines.watchlist) ? (
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

      {p.premarket ? (
        <Section emoji="⏱️" title={p.premarket.title}>
          {p.premarket.note ? (
            <Note style={{ marginTop: 0, marginBottom: 6 }}>{p.premarket.note}</Note>
          ) : null}
          <Table>
            <tr>
              <td style={th}>Symbol</td>
              <td style={{ ...th, textAlign: 'right' }}>Last close</td>
              <td style={{ ...th, textAlign: 'right' }}>Pre-market</td>
            </tr>
            {p.premarket.rows.map((r) => (
              <tr key={r.symbol}>
                <td style={{ ...td, fontWeight: 700 }}>{r.symbol}</td>
                <td align="right" style={{ ...td, color: color.muted }}>
                  {r.close}
                </td>
                <td
                  align="right"
                  style={{ ...td, color: toneColor(r.changePct), whiteSpace: 'nowrap' }}
                >
                  {r.pre}
                </td>
              </tr>
            ))}
          </Table>
        </Section>
      ) : null}

      {p.levels.length ? (
        <Section emoji="👀" title="Levels to watch">
          {p.levels.map((l) => (
            <div key={l} style={{ fontSize: 13, color: color.body, padding: '3px 0' }}>
              {l}
            </div>
          ))}
        </Section>
      ) : null}

      {p.active.length ? (
        <Section emoji="🎯" title="Still-active conditions">
          {p.active.map((a, i) => (
            <div key={i} style={{ fontSize: 13, color: color.body, padding: '4px 0' }}>
              <b style={{ color: color.text }}>{a.ticker}</b> <Pill size="xs">{a.status}</Pill>{' '}
              <span style={{ color: color.muted }}>{a.since}</span> · {a.message}
            </div>
          ))}
        </Section>
      ) : null}

      {p.upcoming ? (
        <Section emoji="📅" title={p.upcoming.title}>
          {p.upcoming.note ? (
            <Note style={{ marginTop: 0, marginBottom: 6, color: color.warning }}>
              {p.upcoming.note}
            </Note>
          ) : null}
          <Table>
            {p.upcoming.items.map((e, i) => (
              <tr key={i}>
                <td style={{ ...td, whiteSpace: 'nowrap', fontWeight: 700, width: 1 }}>{e.date}</td>
                <td style={td}>
                  <Pill tone="navy">{e.ticker}</Pill> {e.what}: {e.title}
                  {e.moved ? <b style={{ color: color.loss }}> · {e.moved}</b> : null}
                  {e.note ? <span style={{ color: color.muted }}> · {e.note}</span> : null}{' '}
                  <Pill tone={e.sourceTone} size="xs">
                    {e.source}
                  </Pill>
                </td>
              </tr>
            ))}
          </Table>
        </Section>
      ) : null}

      {p.lastWeek ? (
        <Section emoji="📈" title="Last week">
          <div style={{ fontSize: 13, lineHeight: '1.8' }}>
            {p.lastWeek.rows.map((r, i) => (
              <span key={r.symbol}>
                {i ? ' · ' : ''}
                <b>{r.symbol}</b>{' '}
                <span style={{ color: toneColor(r.changePct) }}>
                  {r.changePct === null ? '—' : signedPct(r.changePct)}
                </span>
              </span>
            ))}
          </div>
          {p.lastWeek.alerts.length ? (
            <Box style={{ marginTop: 8 }}>
              <b>Alerts last week:</b>
              {p.lastWeek.alerts.map((a) => (
                <div key={a}>{a}</div>
              ))}
            </Box>
          ) : null}
        </Section>
      ) : null}

      <Footer lines={p.footer} />
    </EmailShell>
  );
}

// ---- Plain text ---------------------------------------------------------------------------------

const heading = (s: string) => `\n${s.toUpperCase()}`;

export function renderMorningText(p: MorningEmailProps): string {
  const t: string[] = [p.subtitle, p.kpis.map((k) => `${k.label}: ${k.value}`).join(' | ')];
  t.push(heading(p.alerts.title));
  if (p.alerts.items.length === 0) t.push('- none');
  for (const a of p.alerts.items) {
    t.push(`- ${a.time} — ${a.text}${a.pending ? ' (not yet emailed)' : ''}`);
  }
  if (p.econ) {
    t.push(heading(p.econ.title));
    if (!p.econ.available) t.push('- unavailable');
    for (const r of p.econ.rows) {
      const nums = r.actual
        ? `actual ${r.actual} (forecast ${r.forecast ?? '—'}, previous ${r.previous ?? '—'})`
        : [r.forecast && `forecast ${r.forecast}`, r.previous && `previous ${r.previous}`]
            .filter(Boolean)
            .join(', ');
      t.push(
        `- ${r.time} [${r.impact}] ${r.event}${nums ? ` — ${nums}` : ''}${r.status ? ` — ${r.status}` : ''}`,
      );
    }
  }
  if (p.filings.length) {
    t.push(heading('New SEC filings'));
    for (const f of p.filings) {
      t.push(
        `- ${f.tickers.join(', ')}: ${f.title}${f.detail ? ` ${f.detail}` : ''}${f.href ? ` ${f.href}` : ''}`,
      );
      for (const l of f.lines ?? []) t.push(`    ${l}`);
    }
  }
  if (p.headlines && (p.headlines.items.length || p.headlines.watchlist)) {
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
  if (p.premarket) {
    t.push(heading(p.premarket.title));
    if (p.premarket.note) t.push(p.premarket.note);
    for (const r of p.premarket.rows)
      t.push(`  ${r.symbol.padEnd(6)} close ${r.close}  pre ${r.pre}`);
  }
  if (p.levels.length) {
    t.push(heading('Levels to watch'));
    for (const l of p.levels) t.push(`- ${l}`);
  }
  if (p.active.length) {
    t.push(heading('Still-active conditions'));
    for (const a of p.active) t.push(`- ${a.ticker} [${a.status}] ${a.since}: ${a.message}`);
  }
  if (p.upcoming) {
    t.push(heading(p.upcoming.title));
    if (p.upcoming.note) t.push(p.upcoming.note);
    for (const e of p.upcoming.items) {
      t.push(
        `- ${e.date} ${e.ticker} ${e.what}: ${e.title}${e.moved ? ` — ${e.moved}` : ''}${e.note ? ` — ${e.note}` : ''} [${e.source}]`,
      );
    }
  }
  if (p.lastWeek) {
    t.push(heading('Last week'));
    t.push(
      p.lastWeek.rows
        .map((r) => `${r.symbol} ${r.changePct === null ? '—' : signedPct(r.changePct)}`)
        .join(' · '),
    );
    if (p.lastWeek.alerts.length)
      t.push('Alerts last week:', ...p.lastWeek.alerts.map((a) => `- ${a}`));
  }
  t.push('', '--', ...p.footer, 'AI Investment Analyst · research and alerts only, no trading');
  return t.join('\n');
}

export async function renderMorningEmail(p: MorningEmailProps) {
  return {
    subject: p.subject,
    html: await renderHtml(<MorningEmail {...p} />),
    text: renderMorningText(p),
  };
}
