/** @jsxRuntime automatic @jsxImportSource react */
import { Link } from '@react-email/components';
import { color } from '../tokens';
import { Table } from './layout';

export interface HeadlineItem {
  title: string;
  href?: string;
  /** "Financial Times via Benzinga" or a domain. */
  source: string;
  /** "Mon" / "Sat". */
  day: string;
  /** Holdings it mentions (blue). */
  tickers: string[];
  /** Watchlist tickers it also mentions (gray). */
  otherTickers?: string[];
  /** e.g. "+16 more ACMX stories". */
  extra?: string;
}

export function HeadlinesList({ items }: { items: HeadlineItem[] }) {
  return (
    <Table style={{ fontSize: 13 }}>
      {items.map((h, i) => (
        <tr key={i}>
          <td style={{ padding: '6px 0', borderBottom: `1px solid ${color.rowLine}` }}>
            {h.href ? (
              <Link href={h.href} style={{ color: color.text, textDecoration: 'none' }}>
                <b>{h.title}</b>
              </Link>
            ) : (
              <b>{h.title}</b>
            )}
            <div style={{ fontSize: 11, color: color.muted, marginTop: 2 }}>
              {h.source} · {h.day}
              {h.tickers.length ? (
                <>
                  {' '}
                  · <span style={{ color: color.review }}>{h.tickers.join(' · ')}</span>
                </>
              ) : null}
              {h.otherTickers?.length ? (
                <span style={{ color: color.faint }}>
                  {' '}
                  + {h.otherTickers.join(' · ')} (watchlist)
                </span>
              ) : null}
              {h.extra ? <> · {h.extra}</> : null}
            </div>
          </td>
        </tr>
      ))}
    </Table>
  );
}
