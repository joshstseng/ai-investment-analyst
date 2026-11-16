/**
 * Form 4 (insider transactions): parse the raw ownership XML into a summary. Open-market buys
 * and sales (codes P and S) are listed in detail; everything else is counted by code.
 */
import { XMLParser } from 'fast-xml-parser';

export interface InsiderTrade {
  code: 'P' | 'S';
  date: string | null;
  shares: number;
  price: number | null;
  value: number | null;
  owner: string;
  role: string;
  /** Made under a pre-arranged Rule 10b5-1 plan. */
  plan10b51: boolean;
}

export interface Form4Summary {
  owners: { name: string; role: string }[];
  trades: InsiderTrade[];
  /** Counts of all other transaction codes (non-derivative and derivative), e.g. { M: 2, F: 1 }. */
  otherCounts: Record<string, number>;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  isArray: (name) =>
    ['reportingOwner', 'nonDerivativeTransaction', 'derivativeTransaction'].includes(name),
});

type Node = Record<string, unknown> | undefined;
const val = (n: unknown): string | undefined => {
  if (n === undefined || n === null) return undefined;
  if (typeof n === 'object' && 'value' in (n as object))
    return val((n as { value: unknown }).value);
  return String(n).trim();
};
const truthy = (s: string | undefined) => s === '1' || s?.toLowerCase() === 'true';
const num = (s: string | undefined) =>
  s !== undefined && s !== '' && !Number.isNaN(Number(s)) ? Number(s) : null;

function role(rel: Node): string {
  if (!rel) return '';
  const parts: string[] = [];
  const title = val(rel.officerTitle);
  if (truthy(val(rel.isOfficer)) || title) parts.push(title || 'Officer');
  if (truthy(val(rel.isDirector))) parts.push('Director');
  if (truthy(val(rel.isTenPercentOwner))) parts.push('10% owner');
  if (truthy(val(rel.isOther))) parts.push(val(rel.otherText) || 'Other');
  return parts.join(', ');
}

/** "COXE TENCH" → "Tench Coxe" (SEC lists names surname-first in caps). */
export function displayName(raw: string): string {
  const words = raw.trim().split(/\s+/);
  if (words.length < 2) return raw.trim();
  const cased = words.map((w) => (w === w.toUpperCase() ? w[0]! + w.slice(1).toLowerCase() : w));
  const [last, ...rest] = cased;
  return [...rest, last].join(' ');
}

export function parseForm4Xml(xml: string): Form4Summary {
  const doc = parser.parse(xml) as { ownershipDocument?: Record<string, unknown> };
  const root = doc.ownershipDocument;
  if (!root) throw new Error('not a Form 4 ownership document');

  const owners = ((root.reportingOwner as Node[]) ?? []).map((o) => {
    const id = (o?.reportingOwnerId as Node) ?? {};
    return {
      name: displayName(val(id.rptOwnerName) ?? 'Unknown'),
      role: role(o?.reportingOwnerRelationship as Node),
    };
  });
  const owner = owners.map((o) => o.name).join(' & ') || 'Unknown';
  const ownerRole = [...new Set(owners.map((o) => o.role).filter(Boolean))].join('; ');
  const plan = truthy(val(root.aff10b5One));

  const trades: InsiderTrade[] = [];
  const otherCounts: Record<string, number> = {};
  const nonDeriv = ((root.nonDerivativeTable as Node)?.nonDerivativeTransaction as Node[]) ?? [];
  const deriv = ((root.derivativeTable as Node)?.derivativeTransaction as Node[]) ?? [];

  for (const t of nonDeriv) {
    const code = val((t?.transactionCoding as Node)?.transactionCode) ?? '?';
    if (code === 'P' || code === 'S') {
      const amounts = (t?.transactionAmounts as Node) ?? {};
      const shares = num(val(amounts.transactionShares)) ?? 0;
      const price = num(val(amounts.transactionPricePerShare));
      trades.push({
        code,
        date: val(t?.transactionDate) ?? null,
        shares,
        price,
        value: price !== null ? Math.round(shares * price * 100) / 100 : null,
        owner,
        role: ownerRole,
        plan10b51: plan,
      });
    } else {
      otherCounts[code] = (otherCounts[code] ?? 0) + 1;
    }
  }
  for (const t of deriv) {
    const code = val((t?.transactionCoding as Node)?.transactionCode) ?? '?';
    otherCounts[code] = (otherCounts[code] ?? 0) + 1;
  }
  return { owners, trades, otherCounts };
}

/** URL of the raw XML: the listed primary document is often an XSL-rendered view. */
export function form4XmlUrl(cik: string, accession: string, primaryDocument: string): string {
  const doc = primaryDocument.replace(/^xsl[^/]+\//, '');
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/${doc}`;
}

export interface TradeSummary {
  owner: string;
  role: string;
  code: 'P' | 'S';
  lots: number;
  shares: number;
  /** Weighted average price (null if no lot had a price). */
  avgPrice: number | null;
  value: number;
  firstDate: string | null;
  lastDate: string | null;
  plan10b51: boolean;
}

/**
 * One line per insider and direction for a filing (pure): many lots on one Form 4 become
 * "sold 1,575 sh @ avg $631.03 = $993.9K".
 */
export function summarizeTrades(trades: readonly InsiderTrade[]): TradeSummary[] {
  const groups = new Map<string, InsiderTrade[]>();
  for (const t of trades) {
    const k = `${t.owner}|${t.code}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return [...groups.values()].map((g) => {
    const priced = g.filter((t) => t.price !== null && t.value !== null);
    const pricedShares = priced.reduce((a, t) => a + t.shares, 0);
    const value = priced.reduce((a, t) => a + t.value!, 0);
    const dates = g
      .map((t) => t.date)
      .filter((d): d is string => !!d)
      .sort();
    return {
      owner: g[0]!.owner,
      role: g[0]!.role,
      code: g[0]!.code,
      lots: g.length,
      shares: g.reduce((a, t) => a + t.shares, 0),
      avgPrice: pricedShares > 0 ? Math.round((value / pricedShares) * 100) / 100 : null,
      value: Math.round(value * 100) / 100,
      firstDate: dates[0] ?? null,
      lastDate: dates.at(-1) ?? null,
      plan10b51: g.some((t) => t.plan10b51),
    };
  });
}
