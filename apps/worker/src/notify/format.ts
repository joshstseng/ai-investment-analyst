/** Formatting helpers for emails. Times are shown in America/Los_Angeles. */
export const money = (n: number | null | undefined) =>
  n === null || n === undefined || Number.isNaN(n) ? '—' : `$${n.toFixed(Math.abs(n) < 1 ? 4 : 2)}`;

export const signedPct = (n: number | null | undefined, digits = 1) =>
  n === null || n === undefined || Number.isNaN(n)
    ? '—'
    : `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;

export function ptTime(d: Date) {
  return d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Wraps body HTML in a minimal, email-safe document. */
export function htmlDoc(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;color:#1a1a1a;max-width:760px">
${body}
<p style="color:#777;font-size:12px;margin-top:24px">AI Investment Analyst · research and alerts only, no trading.</p>
</body></html>`;
}

export const ACCOUNT_LABEL: Record<string, string> = {
  roth_ira: 'Roth IRA',
  individual_taxable: 'Individual',
};
