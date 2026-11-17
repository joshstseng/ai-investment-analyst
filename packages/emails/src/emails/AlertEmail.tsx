/** @jsxRuntime automatic @jsxImportSource react */
import { Footer } from '../components/Footer';
import { Header } from '../components/Header';
import { Box, EmailShell, Table } from '../components/layout';
import { RangeBar, type RangeBarProps } from '../components/RangeBar';
import { signedPct } from '../format';
import { renderHtml } from '../render';
import { color, SEVERITY, type Severity } from '../tokens';

/** JSON-safe props for one rule alert (see Mock 2). */
export interface AlertEmailProps {
  subject: string;
  preview: string;
  severity: Severity;
  /** Large title: the ticker or option name. */
  ticker: string;
  /** "Acme Corp · Roth IRA" */
  subtitle: string;
  price: string | null;
  changePct: number | null;
  /** e.g. "OPTX" when the price is the option's underlying. */
  priceNote: string | null;
  /** "New 52-week closing low" */
  title: string;
  /** What happened and why now (first alert / escalation). */
  body: string;
  range: RangeBarProps | null;
  /** Position box: up to 3 cells, plus one line per lot when there are several. */
  position: {
    cells: { label: string; value: string; tone?: 'gain' | 'loss' }[];
    lots: string[];
    note: string | null;
  } | null;
  /** Plan box lines, e.g. [{ label: 'Plan', text: 'Exit all 9 shares…' }, { label: 'Also check', … }]. */
  plan: { label: string; text: string }[];
  footer: string[];
}

export function AlertEmail(p: AlertEmailProps) {
  const sev = SEVERITY[p.severity];
  return (
    <EmailShell preview={p.preview}>
      <Header
        kicker="AI Investment Analyst · Alert"
        title={p.ticker}
        subtitle={p.subtitle}
        severity={p.severity}
        right={
          p.price
            ? {
                primary: p.price,
                secondary:
                  p.changePct === null
                    ? (p.priceNote ?? undefined)
                    : `${signedPct(p.changePct)} today${p.priceNote ? ` (${p.priceNote})` : ''}`,
                secondaryColor:
                  p.changePct === null
                    ? undefined
                    : p.changePct < 0
                      ? color.lossOnNavy
                      : p.changePct > 0
                        ? color.gainOnNavy
                        : undefined,
              }
            : undefined
        }
      />
      <tr>
        <td className="px" style={{ padding: '20px 24px 6px' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: color.text }}>{p.title}</div>
          <div style={{ fontSize: 14, color: color.body, marginTop: 4, lineHeight: '1.5' }}>
            {p.body}
          </div>
          {p.range ? (
            <div style={{ marginTop: 14 }}>
              <RangeBar {...p.range} />
            </div>
          ) : null}
        </td>
      </tr>
      {p.position ? (
        <tr>
          <td className="px" style={{ padding: '12px 24px' }}>
            <Table bg={color.panel} style={{ borderRadius: 10, borderCollapse: 'separate' }}>
              <tr>
                {p.position.cells.map((c) => (
                  <td
                    key={c.label}
                    style={{ padding: '12px 14px', fontSize: 13, verticalAlign: 'top' }}
                  >
                    <div style={{ color: color.muted, fontSize: 11, textTransform: 'uppercase' }}>
                      {c.label}
                    </div>
                    <b
                      style={{
                        color:
                          c.tone === 'gain'
                            ? color.gain
                            : c.tone === 'loss'
                              ? color.loss
                              : color.text,
                      }}
                    >
                      {c.value}
                    </b>
                  </td>
                ))}
              </tr>
              {p.position.lots.length || p.position.note ? (
                <tr>
                  <td
                    colSpan={p.position.cells.length}
                    style={{ padding: '0 14px 12px', fontSize: 12, color: color.muted }}
                  >
                    {p.position.lots.map((l) => (
                      <div key={l}>{l}</div>
                    ))}
                    {p.position.note ? <div>{p.position.note}</div> : null}
                  </td>
                </tr>
              ) : null}
            </Table>
          </td>
        </tr>
      ) : null}
      {p.plan.length ? (
        <tr>
          <td className="px" style={{ padding: '4px 24px 8px' }}>
            <Box variant="plan" accent={sev.color}>
              {p.plan.map((l, i) => (
                <div key={l.label} style={{ marginTop: i ? 6 : 0 }}>
                  <b>{l.label}:</b> {l.text}
                </div>
              ))}
            </Box>
          </td>
        </tr>
      ) : null}
      <Footer lines={p.footer} />
    </EmailShell>
  );
}

export function renderAlertText(p: AlertEmailProps): string {
  const t: string[] = [];
  const price = p.price
    ? `${p.price}${p.changePct === null ? '' : ` ${signedPct(p.changePct)} today`}${p.priceNote ? ` (${p.priceNote})` : ''}`
    : '';
  t.push(`${SEVERITY[p.severity].label} · ${p.ticker}${price ? ` · ${price}` : ''}`);
  if (p.subtitle) t.push(p.subtitle);
  t.push('', p.title, p.body);
  if (p.range)
    t.push(
      `Range: ${p.range.left} … ${p.range.right} (price at ${Math.round(p.range.markerPct)}%)`,
    );
  if (p.position) {
    t.push('', `Position: ${p.position.cells.map((c) => `${c.label} ${c.value}`).join(' · ')}`);
    for (const l of p.position.lots) t.push(`  ${l}`);
    if (p.position.note) t.push(`  ${p.position.note}`);
  }
  if (p.plan.length) t.push('', ...p.plan.map((l) => `${l.label}: ${l.text}`));
  t.push('', '--', ...p.footer, 'AI Investment Analyst · research and alerts only, no trading');
  return t.join('\n');
}

export async function renderAlertEmail(p: AlertEmailProps) {
  return {
    subject: p.subject,
    html: await renderHtml(<AlertEmail {...p} />),
    text: renderAlertText(p),
  };
}
