/** @jsxRuntime automatic @jsxImportSource react */
import type { ReactNode } from 'react';
import { signedPct, toneColor } from '../format';
import { color, SEVERITY, type Severity } from '../tokens';
import { Table } from './layout';
import { Pill, type PillTone } from './Pill';
import { RangeBar, type RangeBarProps } from './RangeBar';

export interface AttentionCardProps {
  severity: Severity;
  /** "ETFX" — shown as "📝 REVIEW · ETFX". */
  ticker: string;
  pills?: { label: string; tone: PillTone }[];
  price?: string;
  changePct?: number | null;
  /** One sentence: what happened / why now. */
  body: ReactNode;
  range?: RangeBarProps;
  /** Position line, e.g. "140 sh · −$742 (−5.1%) · 36% of portfolio". */
  footer?: ReactNode;
  /** One-line card (day-move / new-low rules). */
  compact?: boolean;
}

/** A card in "Needs attention": colored left border by severity. */
export function AttentionCard(p: AttentionCardProps) {
  const s = SEVERITY[p.severity];
  const heading = (
    <b>
      {s.emoji} {s.label} · {p.ticker}
    </b>
  );
  const change =
    p.changePct === undefined || p.changePct === null ? null : (
      <span style={{ color: toneColor(p.changePct) }}>{signedPct(p.changePct)}</span>
    );
  const frame = {
    border: `1px solid ${color.line}`,
    borderLeft: `4px solid ${s.color}`,
    borderRadius: 8,
    marginBottom: 10,
    borderCollapse: 'separate' as const,
  };

  if (p.compact) {
    return (
      <Table style={frame}>
        <tr>
          <td style={{ padding: '10px 14px', fontSize: 13, lineHeight: '1.5', color: color.text }}>
            {heading}
            {p.price ? (
              <>
                {' '}
                &nbsp;{p.price} {change}
              </>
            ) : null}{' '}
            · {p.body}
            {p.footer ? <> · {p.footer}</> : null}
          </td>
        </tr>
      </Table>
    );
  }

  return (
    <Table style={frame}>
      <tr>
        <td style={{ padding: '12px 14px' }}>
          <Table>
            <tr>
              <td style={{ fontSize: 14, color: color.text }}>
                {heading}
                {(p.pills ?? []).map((pill) => (
                  <span key={pill.label}>
                    {' '}
                    <Pill tone={pill.tone}>{pill.label}</Pill>
                  </span>
                ))}
              </td>
              {p.price ? (
                <td align="right" style={{ fontSize: 14, whiteSpace: 'nowrap', color: color.text }}>
                  <b>{p.price}</b> {change}
                </td>
              ) : null}
            </tr>
          </Table>
          <div style={{ fontSize: 13, color: color.body, margin: '6px 0 8px', lineHeight: '1.5' }}>
            {p.body}
          </div>
          {p.range ? <RangeBar {...p.range} /> : null}
          {p.footer ? (
            <div style={{ fontSize: 12, color: color.muted, marginTop: 8 }}>{p.footer}</div>
          ) : null}
        </td>
      </tr>
    </Table>
  );
}
