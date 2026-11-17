/** @jsxRuntime automatic @jsxImportSource react */
import { Link } from '@react-email/components';
import { color } from '../tokens';
import { Table } from './layout';
import { Pill } from './Pill';

export interface FilingItem {
  /** Ticker chips (navy), e.g. ["ACMX"] or ["ACMX", "BKX", "OPTX ×3"]. */
  tickers: string[];
  /** Plain-English form name, e.g. "8-K · Q3 results". */
  title: string;
  href?: string;
  /** Bold title (notable filings: results, dilution, insider buys/sells). */
  strong?: boolean;
  /** Muted detail after the title, e.g. "(Item 2.02) · Mon 1:06 PM". */
  detail?: string;
  /** Extra lines under the filing (Form 4 open-market trades). */
  lines?: string[];
}

export function FilingsList({ items }: { items: FilingItem[] }) {
  return (
    <Table style={{ fontSize: 13 }}>
      {items.map((f, i) => (
        <tr key={i}>
          <td style={{ padding: '5px 0', lineHeight: '1.6', color: color.body }}>
            {f.tickers.map((t) => (
              <span key={t}>
                <Pill tone="navy">{t}</Pill>{' '}
              </span>
            ))}
            &nbsp;
            {f.href ? (
              <Link href={f.href} style={{ color: color.review, textDecoration: 'none' }}>
                {f.strong ? <b>{f.title}</b> : f.title}
              </Link>
            ) : f.strong ? (
              <b>{f.title}</b>
            ) : (
              f.title
            )}
            {f.detail ? <span style={{ color: color.muted }}> {f.detail}</span> : null}
            {(f.lines ?? []).map((l) => (
              <div key={l} style={{ fontSize: 12, color: color.body, paddingLeft: 12 }}>
                {l}
              </div>
            ))}
          </td>
        </tr>
      ))}
    </Table>
  );
}
