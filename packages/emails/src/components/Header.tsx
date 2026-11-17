/** @jsxRuntime automatic @jsxImportSource react */
import type { ReactNode } from 'react';
import { color, type Severity } from '../tokens';
import { attrs, OnNavy, Table } from './layout';
import { SeverityPill } from './Pill';

export interface HeaderProps {
  /** Small caps line, e.g. "AI Investment Analyst". */
  kicker: string;
  /** "📊 Daily Digest", or the ticker on alerts. */
  title: string;
  subtitle?: string;
  /** Alerts: severity pill above a large title. */
  severity?: Severity;
  /** Alerts: price and day change on the right. */
  right?: { primary: string; secondary?: string; secondaryColor?: string };
  /** Content below the title inside the navy band (KPI tiles). */
  children?: ReactNode;
}

/** Navy band with title, date line and optional KPI tiles. */
export function Header({ kicker, title, subtitle, severity, right, children }: HeaderProps) {
  const large = severity !== undefined;
  return (
    <>
      <tr>
        <td
          className="px"
          style={{
            backgroundColor: color.navy,
            backgroundImage: `linear-gradient(${color.navy},${color.navy})`,
            padding: children ? '20px 24px 14px' : '20px 24px 18px',
          }}
          {...attrs({ bgcolor: color.navy })}
        >
          <div
            style={{
              fontSize: 12,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: color.headerKicker,
            }}
          >
            {kicker}
          </div>
          <Table style={{ marginTop: large ? 8 : 4 }}>
            <tr>
              <td style={{ verticalAlign: 'bottom' }}>
                {severity ? <SeverityPill severity={severity} /> : null}
                <div
                  style={{
                    fontSize: large ? (title.length > 10 ? 22 : 30) : 22,
                    fontWeight: large ? 800 : 700,
                    lineHeight: '1.2',
                    marginTop: large ? 6 : 0,
                  }}
                >
                  <OnNavy>{title}</OnNavy>
                </div>
                {subtitle ? (
                  <div style={{ fontSize: 13, color: color.headerSub, marginTop: 2 }}>
                    {subtitle}
                  </div>
                ) : null}
              </td>
              {right ? (
                <td align="right" style={{ verticalAlign: 'bottom', whiteSpace: 'nowrap' }}>
                  <div style={{ fontSize: 26, fontWeight: 700 }}>
                    <OnNavy>{right.primary}</OnNavy>
                  </div>
                  {right.secondary ? (
                    <div style={{ fontSize: 14, color: right.secondaryColor ?? color.headerSub }}>
                      {right.secondary}
                    </div>
                  ) : null}
                </td>
              ) : null}
            </tr>
          </Table>
        </td>
      </tr>
      {children ? (
        <tr>
          <td
            style={{
              backgroundColor: color.navy,
              backgroundImage: `linear-gradient(${color.navy},${color.navy})`,
              padding: '0 16px 18px',
            }}
            {...attrs({ bgcolor: color.navy })}
          >
            {children}
          </td>
        </tr>
      ) : null}
    </>
  );
}
