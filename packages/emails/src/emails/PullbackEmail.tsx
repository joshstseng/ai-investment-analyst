/** @jsxRuntime automatic @jsxImportSource react */
import type { CSSProperties } from 'react';
import { Footer } from '../components/Footer';
import { Header } from '../components/Header';
import { HeadlinesList, type HeadlineItem } from '../components/HeadlinesList';
import { Box, EmailShell, Note, Section, Table } from '../components/layout';
import { Pill, type PillTone } from '../components/Pill';
import { RangeBar, type RangeBarProps } from '../components/RangeBar';
import { signedPct, toneColor } from '../format';
import { renderHtml } from '../render';
import { color } from '../tokens';

/** One row of a compact pullback table (digest, morning email, starting list, overflow). */
export interface PullbackRow {
  ticker: string;
  /** "−25%" or "—" */
  tier: string;
  /** "27.3%" below the 52-week high */
  belowHigh: string;
  d1Pct: number | null;
  /** What changed / why it qualifies, e.g. "Midday: deeper tier −25% · EOD: reversed". */
  note: string;
  quality: 'pass' | 'fail' | 'n/a';
}

/** Full alert block for one ticker. */
export interface PullbackBlock {
  ticker: string;
  name: string | null;
  /** "27.3% below the 52-week high · crossed the −25% tier" */
  headline: string;
  pills: { label: string; tone: PillTone }[];
  price: string;
  changePct: number | null;
  /** "12:31 PM ET · Alpaca IEX · Midday check · intraday, single venue, may differ from the close" */
  priceLine: string;
  facts: { label: string; value: string; tone?: 'gain' | 'loss' }[];
  range: RangeBarProps | null;
  holding: string;
  exposureNote: string | null;
  earnings: string[];
  headlines: HeadlineItem[];
  quality: { pass: boolean | null; reasons: string[] };
  scorecard: { label: string; value: string }[];
  scorecardNotes: string[];
  bull: string[];
  exits: { label: string; value: string; basis: string }[];
}

export interface PullbackEmailProps {
  subject: string;
  preview: string;
  title: string;
  subtitle: string;
  blocks: PullbackBlock[];
  /** Compact table after the blocks (overflow in a combined email; the whole starting list). */
  table: { title: string; rows: PullbackRow[] } | null;
  label: string;
  footer: string[];
}

const td: CSSProperties = {
  padding: '5px 8px 5px 0',
  borderBottom: `1px solid ${color.rowLine}`,
  fontSize: 13,
  verticalAlign: 'top',
  color: color.text,
};
const th: CSSProperties = {
  ...td,
  fontSize: 11,
  color: color.muted,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  borderBottom: `1px solid ${color.line}`,
  whiteSpace: 'nowrap',
};

/** Compact pullback table, shared by the digest, morning email and pullback emails. */
export function PullbackTable({ rows }: { rows: PullbackRow[] }) {
  return (
    <Table>
      <tr>
        <td style={th}>Ticker</td>
        <td style={{ ...th, textAlign: 'right' }}>Tier</td>
        <td style={{ ...th, textAlign: 'right' }}>From high</td>
        <td style={{ ...th, textAlign: 'right' }}>Day</td>
        <td style={th}>What changed</td>
      </tr>
      {rows.map((r) => (
        <tr key={r.ticker}>
          <td style={{ ...td, whiteSpace: 'nowrap' }}>
            <b>{r.ticker}</b>
            {r.quality === 'fail' ? (
              <>
                {' '}
                <Pill size="xs" tone="loss">
                  quality ✗
                </Pill>
              </>
            ) : null}
          </td>
          <td align="right" style={{ ...td, whiteSpace: 'nowrap' }}>
            {r.tier}
          </td>
          <td align="right" style={{ ...td, whiteSpace: 'nowrap', color: color.loss }}>
            −{r.belowHigh}
          </td>
          <td align="right" style={{ ...td, whiteSpace: 'nowrap', color: toneColor(r.d1Pct) }}>
            {r.d1Pct === null ? '—' : signedPct(r.d1Pct)}
          </td>
          <td style={{ ...td, fontSize: 12, color: color.body }}>{r.note}</td>
        </tr>
      ))}
    </Table>
  );
}

function KeyValues({
  rows,
  cols = 2,
}: {
  rows: { label: string; value: string; tone?: 'gain' | 'loss' }[];
  cols?: number;
}) {
  const lines: (typeof rows)[] = [];
  for (let i = 0; i < rows.length; i += cols) lines.push(rows.slice(i, i + cols));
  return (
    <Table>
      {lines.map((line, i) => (
        <tr key={i}>
          {line.map((r) => (
            <td
              key={r.label}
              style={{
                padding: '3px 10px 3px 0',
                fontSize: 13,
                verticalAlign: 'top',
                width: `${100 / cols}%`,
              }}
            >
              <span style={{ color: color.muted }}>{r.label}</span>{' '}
              <b
                style={{
                  color:
                    r.tone === 'loss' ? color.loss : r.tone === 'gain' ? color.gain : color.text,
                }}
              >
                {r.value}
              </b>
            </td>
          ))}
        </tr>
      ))}
    </Table>
  );
}

const sub = (text: string) => (
  <div
    style={{
      fontSize: 12,
      fontWeight: 700,
      color: color.muted,
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      margin: '12px 0 4px',
    }}
  >
    {text}
  </div>
);

function Block({ b }: { b: PullbackBlock }) {
  return (
    <tr>
      <td
        className="px"
        style={{ padding: '18px 24px 8px', borderBottom: `6px solid ${color.page}` }}
      >
        <Table>
          <tr>
            <td style={{ fontSize: 18, fontWeight: 800, color: color.text }}>
              {b.ticker}
              {b.name ? (
                <span style={{ fontSize: 13, fontWeight: 400, color: color.muted }}> {b.name}</span>
              ) : null}
            </td>
            <td
              align="right"
              style={{ whiteSpace: 'nowrap', fontSize: 18, fontWeight: 700, color: color.text }}
            >
              {b.price}{' '}
              {b.changePct === null ? null : (
                <span style={{ fontSize: 14, color: toneColor(b.changePct) }}>
                  {signedPct(b.changePct)}
                </span>
              )}
            </td>
          </tr>
        </Table>
        <div style={{ margin: '4px 0' }}>
          {b.pills.map((p) => (
            <span key={p.label}>
              <Pill tone={p.tone}>{p.label}</Pill>{' '}
            </span>
          ))}
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, color: color.text, marginTop: 6 }}>
          {b.headline}
        </div>
        <div style={{ fontSize: 11, color: color.muted, margin: '2px 0 8px' }}>{b.priceLine}</div>
        <KeyValues rows={b.facts} />
        {b.range ? (
          <div style={{ marginTop: 8 }}>
            <RangeBar {...b.range} />
          </div>
        ) : null}
        <Box style={{ marginTop: 10 }}>
          <div>
            <b>Position:</b> {b.holding}
          </div>
          {b.exposureNote ? <div>{b.exposureNote}</div> : null}
          {b.earnings.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </Box>
        {b.headlines.length ? (
          <>
            {sub('Latest headlines')}
            <HeadlinesList items={b.headlines} />
          </>
        ) : null}
        {sub(
          b.quality.pass === null
            ? 'Quality scorecard: no data'
            : b.quality.pass
              ? 'Quality scorecard: passed'
              : 'Quality scorecard: FAILED',
        )}
        {b.quality.pass === false ? (
          <div style={{ fontSize: 12, color: color.loss, marginBottom: 4 }}>
            {b.quality.reasons.join('; ')}
          </div>
        ) : null}
        <KeyValues rows={b.scorecard} />
        {b.scorecardNotes.length ? (
          <Note style={{ marginTop: 4 }}>{b.scorecardNotes.join(' · ')}</Note>
        ) : null}
        {b.bull.length ? (
          <>
            {sub('Bull evidence (numbers only)')}
            <Box variant="plan" accent={color.gain}>
              {b.bull.map((x) => (
                <div key={x}>• {x}</div>
              ))}
            </Box>
          </>
        ) : null}
        {sub('Mechanical exit levels')}
        <Table>
          {b.exits.map((e) => (
            <tr key={e.label}>
              <td style={{ ...td, whiteSpace: 'nowrap', color: color.muted, width: 1 }}>
                {e.label}
              </td>
              <td style={{ ...td, whiteSpace: 'nowrap', fontWeight: 700 }}>{e.value}</td>
              <td style={{ ...td, fontSize: 12, color: color.body }}>{e.basis}</td>
            </tr>
          ))}
        </Table>
      </td>
    </tr>
  );
}

export function PullbackEmail(p: PullbackEmailProps) {
  return (
    <EmailShell preview={p.preview}>
      <Header
        kicker="AI Investment Analyst · Pullback screen"
        title={p.title}
        subtitle={p.subtitle}
        severity="review"
      />
      {p.blocks.map((b) => (
        <Block key={b.ticker} b={b} />
      ))}
      {p.table && p.table.rows.length ? (
        <Section emoji="📉" title={p.table.title}>
          <PullbackTable rows={p.table.rows} />
        </Section>
      ) : null}
      <tr>
        <td className="px" style={{ padding: '14px 24px 4px' }}>
          <Box variant="plan" accent={color.review}>
            {p.label}
          </Box>
        </td>
      </tr>
      <Footer lines={p.footer} />
    </EmailShell>
  );
}

// ---- Plain text ---------------------------------------------------------------------------------

export function pullbackTableText(rows: PullbackRow[]): string[] {
  return rows.map(
    (r) =>
      `- ${r.ticker}${r.quality === 'fail' ? ' (quality ✗)' : ''}: tier ${r.tier}, −${r.belowHigh} from high, day ${r.d1Pct === null ? '—' : signedPct(r.d1Pct)} — ${r.note}`,
  );
}

export function renderPullbackText(p: PullbackEmailProps): string {
  const t: string[] = [p.title, p.subtitle];
  for (const b of p.blocks) {
    t.push(
      '',
      `${b.ticker}${b.name ? ` (${b.name})` : ''} — ${b.price}${b.changePct === null ? '' : ` ${signedPct(b.changePct)}`}`,
      b.headline,
      b.priceLine,
      ...b.facts.map((f) => `  ${f.label}: ${f.value}`),
      `Position: ${b.holding}`,
      ...(b.exposureNote ? [b.exposureNote] : []),
      ...b.earnings,
    );
    if (b.headlines.length)
      t.push('Headlines:', ...b.headlines.map((h) => `  - ${h.title} (${h.source}, ${h.day})`));
    t.push(
      `Quality scorecard: ${b.quality.pass === null ? 'no data' : b.quality.pass ? 'passed' : `FAILED (${b.quality.reasons.join('; ')})`}`,
      ...b.scorecard.map((s) => `  ${s.label}: ${s.value}`),
      ...b.scorecardNotes.map((n) => `  (${n})`),
    );
    if (b.bull.length) t.push('Bull evidence (numbers only):', ...b.bull.map((x) => `  • ${x}`));
    t.push(
      'Mechanical exit levels:',
      ...b.exits.map((e) => `  ${e.label}: ${e.value} — ${e.basis}`),
    );
  }
  if (p.table?.rows.length)
    t.push('', p.table.title.toUpperCase(), ...pullbackTableText(p.table.rows));
  t.push(
    '',
    p.label,
    '',
    '--',
    ...p.footer,
    'AI Investment Analyst · research and alerts only, no trading',
  );
  return t.join('\n');
}

export async function renderPullbackEmail(p: PullbackEmailProps) {
  return {
    subject: p.subject,
    html: await renderHtml(<PullbackEmail {...p} />),
    text: renderPullbackText(p),
  };
}
