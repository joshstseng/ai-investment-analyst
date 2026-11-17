/** @jsxRuntime automatic @jsxImportSource react */
import type { ReactNode } from 'react';
import { color } from '../tokens';

/** Feed status, data sources, "not checked" rules, generated time, disclaimer. */
export function Footer({ lines }: { lines: ReactNode[] }) {
  return (
    <tr>
      <td className="px" style={{ padding: '18px 24px 22px' }}>
        <div
          style={{
            borderTop: `1px solid ${color.line}`,
            paddingTop: 10,
            fontSize: 11,
            color: color.faint,
            lineHeight: '1.6',
          }}
        >
          {lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
          <div>AI Investment Analyst · research and alerts only, no trading</div>
        </div>
      </td>
    </tr>
  );
}
