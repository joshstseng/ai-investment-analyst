/** @jsxRuntime automatic @jsxImportSource react */
import { color } from '../tokens';
import { Table } from './layout';

export interface RangeBarProps {
  /** Label at the left end, e.g. "20% $96.00" or "stop $45.00". */
  left: string;
  /** Label at the right end, e.g. "high $120.00". */
  right: string;
  /** Where the current price sits, 0 (left end) to 100 (right end); clamped. */
  markerPct: number;
  fillColor?: string;
}

/** Position of the price between two levels: filled up to a marker, then empty track. */
export function RangeBar({ left, right, markerPct, fillColor = color.rangeFill }: RangeBarProps) {
  const p = Math.round(Math.min(100, Math.max(0, markerPct)));
  const track = { height: 6, lineHeight: '6px', fontSize: 0 } as const;
  return (
    <Table style={{ fontSize: 11, color: color.muted }}>
      <tr>
        <td style={{ whiteSpace: 'nowrap', paddingRight: 8, width: 1 }}>{left}</td>
        <td>
          <Table>
            <tr>
              {p > 0 ? (
                <td
                  width={`${p}%`}
                  style={{ ...track, backgroundColor: fillColor, borderRadius: '3px 0 0 3px' }}
                >
                  &nbsp;
                </td>
              ) : null}
              <td
                width={3}
                style={{ height: 12, lineHeight: '12px', fontSize: 0, backgroundColor: color.navy }}
              >
                &nbsp;
              </td>
              {p < 100 ? (
                <td style={{ ...track, backgroundColor: color.line, borderRadius: '0 3px 3px 0' }}>
                  &nbsp;
                </td>
              ) : null}
            </tr>
          </Table>
        </td>
        <td align="right" style={{ whiteSpace: 'nowrap', paddingLeft: 8, width: 1 }}>
          {right}
        </td>
      </tr>
    </Table>
  );
}
