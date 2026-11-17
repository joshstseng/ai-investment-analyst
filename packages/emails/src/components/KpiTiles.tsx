/** @jsxRuntime automatic @jsxImportSource react */
import { color } from '../tokens';
import { attrs, OnNavy } from './layout';

export interface KpiTile {
  label: string;
  value: string;
  /** Value color; omitted = white. */
  valueColor?: string;
  sub?: string;
  subColor?: string;
}

/** Row of tiles inside the navy header band. The first tile is wider when `wideFirst`. */
export function KpiTiles({ tiles, wideFirst = false }: { tiles: KpiTile[]; wideFirst?: boolean }) {
  const n = tiles.length;
  const widths = tiles.map((_, i) =>
    wideFirst && n > 1 ? (i === 0 ? 34 : Math.floor(66 / (n - 1))) : Math.floor(100 / n),
  );
  return (
    <table
      role="presentation"
      width="100%"
      cellPadding={0}
      cellSpacing={8}
      border={0}
      style={{ borderCollapse: 'separate' }}
    >
      <tbody>
        <tr>
          {tiles.map((t, i) => (
            <td
              key={t.label}
              className="kpi"
              width={`${widths[i]}%`}
              style={{
                backgroundColor: color.navyTile,
                borderRadius: 10,
                padding: '10px 12px',
                verticalAlign: 'top',
              }}
              {...attrs({ bgcolor: color.navyTile })}
            >
              <div
                className="kpi-l"
                style={{
                  fontSize: 11,
                  color: color.headerKicker,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                {t.label}
              </div>
              <div
                className="kpi-v"
                style={{ fontSize: 20, fontWeight: 700, marginTop: 2, whiteSpace: 'nowrap' }}
              >
                {t.valueColor ? (
                  <span style={{ color: t.valueColor }}>{t.value}</span>
                ) : (
                  <OnNavy>{t.value}</OnNavy>
                )}
              </div>
              {t.sub ? (
                <div style={{ fontSize: 12, color: t.subColor ?? color.headerSub }}>{t.sub}</div>
              ) : null}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}
