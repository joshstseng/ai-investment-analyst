/** @jsxRuntime automatic @jsxImportSource react */
import { Footer } from '../components/Footer';
import { Header } from '../components/Header';
import { Box, EmailShell, Table } from '../components/layout';
import { Pill } from '../components/Pill';
import { renderHtml } from '../render';
import { color } from '../tokens';

/** JSON-safe props for a feed failure or recovery. */
export interface HealthEmailProps {
  subject: string;
  preview: string;
  /** "News stream (Alpaca)" */
  feedName: string;
  kind: 'failure' | 'recovery';
  /** "down" / "degraded" / "recovered" */
  statusLabel: string;
  /** One sentence: what broke, or that it recovered. */
  lead: string;
  /** Since / down for / detail / checked. */
  facts: { label: string; value: string }[];
  /** What this affects while it's broken. */
  impact: string | null;
  /** Other feeds that are fine, e.g. "Daily bars, SEC EDGAR filings". */
  stillWorks: string | null;
  /** "You'll get one more email when it recovers." */
  next: string;
  footer: string[];
}

export function HealthEmail(p: HealthEmailProps) {
  return (
    <EmailShell preview={p.preview}>
      <Header
        kicker="AI Investment Analyst · Feed health"
        title={p.feedName}
        subtitle={p.kind === 'failure' ? `Feed ${p.statusLabel}` : 'Feed recovered'}
        severity="health"
      />
      <tr>
        <td className="px" style={{ padding: '20px 24px 6px' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: color.text }}>
            <Pill tone={p.kind === 'failure' ? 'loss' : 'gain'}>{p.statusLabel}</Pill> {p.lead}
          </div>
          <Table style={{ marginTop: 12, fontSize: 13 }}>
            {p.facts.map((f) => (
              <tr key={f.label}>
                <td
                  style={{
                    padding: '4px 12px 4px 0',
                    color: color.muted,
                    whiteSpace: 'nowrap',
                    verticalAlign: 'top',
                    width: 1,
                  }}
                >
                  {f.label}
                </td>
                <td style={{ padding: '4px 0', color: color.text }}>{f.value}</td>
              </tr>
            ))}
          </Table>
        </td>
      </tr>
      <tr>
        <td className="px" style={{ padding: '10px 24px 8px' }}>
          {p.impact ? (
            <Box variant="plan" accent={p.kind === 'failure' ? color.warning : color.gain}>
              <b>{p.kind === 'failure' ? 'Affected' : 'Back to normal'}:</b> {p.impact}
            </Box>
          ) : null}
          {p.stillWorks ? (
            <Box style={{ marginTop: 8 }}>
              <b>Still working:</b> {p.stillWorks}
            </Box>
          ) : null}
          <div style={{ fontSize: 12, color: color.muted, marginTop: 10 }}>{p.next}</div>
        </td>
      </tr>
      <Footer lines={p.footer} />
    </EmailShell>
  );
}

export function renderHealthText(p: HealthEmailProps): string {
  return [
    `HEALTH · ${p.feedName}: ${p.statusLabel}`,
    '',
    p.lead,
    ...p.facts.map((f) => `${f.label}: ${f.value}`),
    ...(p.impact
      ? ['', `${p.kind === 'failure' ? 'Affected' : 'Back to normal'}: ${p.impact}`]
      : []),
    ...(p.stillWorks ? [`Still working: ${p.stillWorks}`] : []),
    '',
    p.next,
    '',
    '--',
    ...p.footer,
    'AI Investment Analyst · research and alerts only, no trading',
  ].join('\n');
}

export async function renderHealthEmail(p: HealthEmailProps) {
  return {
    subject: p.subject,
    html: await renderHtml(<HealthEmail {...p} />),
    text: renderHealthText(p),
  };
}
