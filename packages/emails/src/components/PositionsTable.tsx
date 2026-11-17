/** @jsxRuntime automatic @jsxImportSource react */
import type { CSSProperties } from 'react';
import { signedMoney, signedPct, toneColor } from '../format';
import { color } from '../tokens';
import { Table } from './layout';
import { Pill } from './Pill';

export interface PositionRow {
  ticker: string;
  /** R / I / R+I */
  accountTag: string;
  /** Small gray line under the ticker for multi-lot positions, e.g. "12 @ 70.10 · 9 @ 84.40". */
  lotLine?: string;
  price: string;
  dayPct: number | null;
  value: string;
  plDollars: number | null;
  plPct: number | null;
  next: {
    text: string;
    /** draft / placeholder pill. */
    pill?: string;
    /** Within 7%: orange text. */
    near: boolean;
  } | null;
}

const cell: CSSProperties = {
  padding: '7px 4px',
  borderBottom: `1px solid ${color.rowLine}`,
  fontSize: 13,
  verticalAlign: 'top',
  color: color.text,
};
const head: CSSProperties = {
  padding: '6px 4px',
  borderBottom: `1px solid ${color.line}`,
  fontSize: 11,
  color: color.muted,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  whiteSpace: 'nowrap',
};

/** Positions table: ticker, price · day %, value, P/L, next level. */
export function PositionsTable({ rows }: { rows: PositionRow[] }) {
  return (
    <Table>
      <tr>
        <td style={head}>Ticker</td>
        <td align="right" style={head}>
          Price · day
        </td>
        <td align="right" style={head} className="hide-sm">
          Value
        </td>
        <td align="right" style={head}>
          P/L
        </td>
        <td style={head}>Next level</td>
      </tr>
      {rows.map((r) => (
        <tr key={r.ticker}>
          <td style={cell}>
            <b>{r.ticker}</b>{' '}
            <span style={{ fontSize: 10, color: color.faint }}>{r.accountTag}</span>
            {r.lotLine ? (
              <div style={{ fontSize: 10, color: color.faint, whiteSpace: 'nowrap' }}>
                {r.lotLine}
              </div>
            ) : null}
          </td>
          <td align="right" style={{ ...cell, whiteSpace: 'nowrap' }}>
            {r.price}{' '}
            {r.dayPct === null ? null : (
              <span style={{ color: toneColor(r.dayPct) }}>{signedPct(r.dayPct)}</span>
            )}
          </td>
          <td align="right" className="hide-sm" style={{ ...cell, whiteSpace: 'nowrap' }}>
            {r.value}
          </td>
          <td
            align="right"
            style={{ ...cell, whiteSpace: 'nowrap', color: toneColor(r.plDollars) }}
          >
            {r.plDollars === null ? (
              '—'
            ) : (
              <>
                {signedMoney(r.plDollars)}{' '}
                {r.plPct === null ? null : (
                  <span style={{ fontSize: 11 }}>{signedPct(r.plPct)}</span>
                )}
              </>
            )}
          </td>
          <td
            style={{
              ...cell,
              fontSize: 12,
              color: r.next?.near ? color.warning : color.muted,
            }}
          >
            {r.next ? (
              <>
                {r.next.text}
                {r.next.pill ? (
                  <>
                    {' '}
                    <Pill size="xs">{r.next.pill}</Pill>
                  </>
                ) : null}
              </>
            ) : (
              '—'
            )}
          </td>
        </tr>
      ))}
    </Table>
  );
}
