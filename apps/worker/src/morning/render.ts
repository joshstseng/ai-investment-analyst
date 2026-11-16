/**
 * Morning email rendering (pure): subject, mobile-friendly HTML and a plain-text fallback.
 * Sections follow a fixed order; empty sections are skipped, except alerts ("none").
 * All times are shown in Pacific time.
 */
import { FORM4_CODES } from '@aia/core';
import { escapeHtml, money, signedPct } from '../notify/format';
import type { MorningData } from './gather';

const TZ = 'America/Los_Angeles';
const time = (d: Date) =>
  d.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const dayTime = (d: Date) =>
  d.toLocaleString('en-US', {
    timeZone: TZ,
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
const dayOfDate = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
const shortDay = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
  });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const compactUsd = (n: number) =>
  n >= 1e9
    ? `$${(n / 1e9).toFixed(2)}B`
    : n >= 1e6
      ? `$${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `$${(n / 1e3).toFixed(1)}K`
        : `$${n.toFixed(0)}`;
const TIME_OF_DAY: Record<string, string> = {
  before_open: 'before open',
  after_close: 'after close',
  during_market: 'during market',
  unknown: '',
};
const EVENT_LABEL: Record<string, string> = {
  earnings: 'earnings',
  dividend: 'dividend',
  split: 'split',
  lockup_expiry: 'lockup expiry',
  option_expiry: 'option expiry',
  guidance: 'guidance',
  reminder: 'reminder',
  other: 'event',
};
const SOURCE_LABEL: Record<string, string> = {
  seed: 'your notes',
  alphavantage: 'Alpha Vantage',
  alpaca: 'Alpaca',
  rule: 'your rule',
  derived: 'derived',
  ai_extracted: 'AI-extracted',
};
const FEED_LABEL: Record<string, string> = {
  alpaca_news_stream: 'news stream',
  alpaca_quotes: 'quotes',
  alpaca_bars: 'daily bars',
  sec_edgar: 'EDGAR',
  scheduler: 'scheduler',
  alphavantage_calendar: 'earnings calendar',
};

export function morningSubject(d: MorningData): string {
  const day = dayOfDate(d.window.today);
  if (d.window.closed) return `[AIA] MORNING ${day}: market closed`;
  if (d.window.recap) return `[AIA] MORNING ${day}: weekend recap + week ahead`;
  const filings = d.filings.reduce(
    (a, f) => a + f.items.length + f.insiderTrades.length + f.otherInsiderFilings,
    0,
  );
  return `[AIA] MORNING ${day}: ${plural(d.alerts.length, 'alert')}, ${plural(filings, 'filing')}, ${plural(d.levels.length, 'level')} to watch`;
}

interface Out {
  text: string[];
  html: string[];
}

function section(o: Out, title: string) {
  o.text.push('', title.toUpperCase());
  o.html.push(
    `<h3 style="font-size:16px;margin:22px 0 6px;padding-bottom:3px;border-bottom:1px solid #ddd">${escapeHtml(title)}</h3>`,
  );
}
function line(o: Out, text: string, html = escapeHtml(text)) {
  o.text.push(`- ${text}`);
  o.html.push(`<div style="margin:3px 0">${html}</div>`);
}
const link = (href: string | null, label: string) =>
  href
    ? `<a href="${escapeHtml(href)}" style="color:#0b57d0">${escapeHtml(label)}</a>`
    : escapeHtml(label);
const muted = (s: string) => `<span style="color:#666">${escapeHtml(s)}</span>`;

export function renderMorning(d: MorningData) {
  const w = d.window;
  const o: Out = { text: [], html: [] };
  const subject = morningSubject(d);

  // 1. Today
  section(o, 'Today');
  if (w.closed) {
    const next = w.next
      ? `Next session ${dayOfDate(w.next.date)}, opens ${time(w.next.openAt)} PT.`
      : '';
    line(o, `Market closed today. ${next}`.trim());
  } else {
    const early = w.session!.earlyClose
      ? ` EARLY CLOSE ${time(w.session!.closeAt)} PT.`
      : ` Closes ${time(w.session!.closeAt)} PT.`;
    line(
      o,
      `Market open today: opens ${time(w.session!.openAt)} PT.${early}`,
      `Market open today: opens <b>${time(w.session!.openAt)} PT</b>.${w.session!.earlyClose ? ` <b style="color:#b3261e">Early close ${time(w.session!.closeAt)} PT.</b>` : ` Closes ${time(w.session!.closeAt)} PT.`}`,
    );
  }
  line(
    o,
    `Covers ${dayTime(w.start)} → ${dayTime(w.end)} PT${w.recap ? ' (weekend recap)' : ''}.`,
    muted(`Covers ${dayTime(w.start)} → ${dayTime(w.end)} PT${w.recap ? ' (weekend recap)' : ''}.`),
  );

  // 2. Overnight alerts (always shown)
  section(o, w.recap ? 'Alerts since Friday' : 'Overnight alerts');
  if (d.alerts.length === 0) line(o, 'none');
  for (const a of d.alerts) {
    const t = `${dayTime(a.createdAt)} — ${a.subject.replace(/^\[AIA\] /, '')}${a.sent ? '' : ' (not yet emailed)'}`;
    line(o, t);
  }

  if (!w.closed) {
    // 3. Economic calendar
    if (!d.econ.available) {
      section(o, w.recap ? 'Economic calendar this week' : 'Economic calendar today');
      line(o, 'unavailable (calendar feed not fetched today)');
    } else if (d.econ.items.length) {
      section(o, w.recap ? 'Economic calendar this week' : 'Economic calendar today');
      const rank = (i: string) => (i === 'High' ? 0 : 1);
      const items = [...d.econ.items].sort((a, b) =>
        w.recap
          ? a.at.getTime() - b.at.getTime() || rank(a.impact) - rank(b.impact)
          : rank(a.impact) - rank(b.impact) || a.at.getTime() - b.at.getTime(),
      );
      for (const e of items) {
        const when = e.allDay
          ? `${w.recap ? `${shortDay(e.at.toISOString().slice(0, 10))} ` : ''}all day`
          : w.recap
            ? dayTime(e.at)
            : time(e.at);
        const nums = e.actual
          ? `actual ${e.actual} (forecast ${e.forecast ?? '—'}, previous ${e.previous ?? '—'})`
          : [e.forecast && `forecast ${e.forecast}`, e.previous && `previous ${e.previous}`]
              .filter(Boolean)
              .join(', ');
        const released =
          !e.actual && !e.allDay && e.at <= d.generatedAt
            ? ` — released ${time(e.at)}, see brief`
            : '';
        const t = `${when} [${e.impact}] ${e.title}${nums ? ` — ${nums}` : ''}${released}`;
        line(
          o,
          t,
          `${escapeHtml(when)} <b style="color:${e.impact === 'High' ? '#b3261e' : '#8a5a00'}">${e.impact}</b> ${escapeHtml(e.title)}${nums ? ` ${muted(`— ${nums}`)}` : ''}${released ? muted(released) : ''}`,
        );
      }
    }

    // 4. Filings
    if (d.filings.length) {
      section(o, 'New SEC filings');
      for (const g of d.filings) {
        const who = `${g.ticker}${g.held ? '' : ' (watchlist)'}`;
        for (const f of g.items) {
          line(
            o,
            `${who}: ${f.label} (${dayTime(f.filedAt)}) ${f.url}`,
            `<b>${escapeHtml(who)}</b> ${link(f.url, f.label)}${f.dilution ? ' ⚠' : ''} ${muted(dayTime(f.filedAt))}`,
          );
        }
        for (const t of g.insiderTrades) {
          const verb = t.code === 'P' ? 'bought' : 'sold';
          const px =
            t.avgPrice !== null
              ? ` @ ${t.lots > 1 ? 'avg ' : ''}${money(t.avgPrice)} = ${compactUsd(t.value)}`
              : '';
          const when = t.firstDate
            ? ` on ${shortDay(t.firstDate)}${t.lastDate && t.lastDate !== t.firstDate ? `–${shortDay(t.lastDate)}` : ''}`
            : '';
          const s = `${who}: Form 4 — ${t.owner}${t.role ? ` (${t.role})` : ''} ${verb} ${t.shares.toLocaleString('en-US')} sh${px}${when}${t.plan10b51 ? ' (10b5-1 plan)' : ''}`;
          line(
            o,
            `${s} ${t.url}`,
            `<b>${escapeHtml(who)}</b> ${link(t.url, 'Form 4')} — ${escapeHtml(s.split(' — ')[1]!)}`,
          );
        }
        const activity = Object.entries(g.otherCodes)
          .sort((x, y) => y[1] - x[1])
          .map(([code, n]) => `${n} ${FORM4_CODES[code] ?? `code ${code}`}`)
          .join(', ');
        if (g.otherInsiderFilings || activity) {
          const filingsPart = g.otherInsiderFilings
            ? `${plural(g.otherInsiderFilings, 'other insider filing')}`
            : 'other insider activity';
          const s = `${who}: ${filingsPart}${activity ? ` (${activity})` : ''}`;
          line(o, s, `<b>${escapeHtml(who)}</b> ${muted(s.slice(who.length + 2))}`);
        }
      }
    }

    // 5. Headlines
    if (d.headlines.length) {
      section(o, 'Headlines');
      for (const g of d.headlines) {
        o.text.push(`${g.ticker}${g.held ? '' : ' (watchlist)'}:`);
        o.html.push(
          `<div style="margin:10px 0 2px"><b>${escapeHtml(g.ticker)}</b>${g.held ? '' : ' ' + muted('(watchlist)')}</div>`,
        );
        for (const n of g.items) {
          const also = n.also.length ? ` (also: ${n.also.join(', ')})` : '';
          o.text.push(
            `  - ${n.headline} (${n.source}, ${dayTime(n.publishedAt)})${also} ${n.url ?? ''}`.trimEnd(),
          );
          o.html.push(
            `<div style="margin:2px 0 2px 12px">${link(n.url, n.headline)} ${muted(`${n.source} · ${dayTime(n.publishedAt)}${also}`)}</div>`,
          );
        }
        if (g.more) {
          o.text.push(`  (+${g.more} more)`);
          o.html.push(`<div style="margin:2px 0 2px 12px">${muted(`+${g.more} more`)}</div>`);
        }
      }
    }

    // 6. Pre-market
    if (d.premarket.quotes.length) {
      const asOf = d.premarket.asOf
        ? `, as of ${time(d.premarket.asOf)} PT${d.premarket.feed === 'sip' ? ' (15-min delayed)' : ''}`
        : '';
      section(o, `Pre-market${asOf}`);
      if (!d.premarket.available) line(o, 'pre-market unavailable on free feed; last close shown');
      if (d.premarket.note && d.premarket.available) line(o, d.premarket.note);
      o.html.push('<table cellpadding="3" style="border-collapse:collapse;font-size:14px">');
      for (const q of d.premarket.quotes) {
        const pre =
          q.price === null
            ? q.lastClose === null
              ? 'no data source'
              : 'no pre-market trades'
            : `${money(q.price)} ${signedPct(q.changePct, 2)}`;
        o.text.push(`  ${q.symbol.padEnd(6)} close ${money(q.lastClose)}  pre ${pre}`);
        const color = q.changePct === null ? '#666' : q.changePct < 0 ? '#b3261e' : '#137333';
        o.html.push(
          `<tr><td><b>${escapeHtml(q.symbol)}</b></td><td style="color:#666">${money(q.lastClose)}</td><td style="color:${color}">${escapeHtml(pre)}</td></tr>`,
        );
      }
      o.html.push('</table>');
    }

    // 7. Levels to watch
    if (d.levels.length) {
      section(o, 'Levels to watch (within 5%)');
      for (const l of d.levels) {
        const side = l.direction === 'down' ? 'above' : 'below';
        // Always 2 decimals for the $ distance (money() uses 4 below $1, e.g. "$0.1200").
        const dollars = `$${l.distanceDollars.toFixed(2)}`;
        const t = `${l.display}: ${l.label} ${money(l.level)} — ${l.distancePct.toFixed(2)}% / ${dollars} ${side} (close ${money(l.close)})${l.status === 'CONFIRMED' ? '' : ` [${l.status.toLowerCase()}]`}`;
        line(
          o,
          t,
          `<b>${escapeHtml(l.display)}</b> ${escapeHtml(l.label)} ${money(l.level)} — <b>${l.distancePct.toFixed(2)}%</b> / ${dollars} ${side} ${muted(`(close ${money(l.close)})${l.status === 'CONFIRMED' ? '' : ` [${l.status.toLowerCase()}]`}`)}`,
        );
      }
    }

    // 8. Still-active conditions
    if (d.active.length) {
      section(o, 'Still-active conditions');
      for (const a of d.active) {
        const t = `${a.display} [${a.status.toLowerCase()}] ${plural(a.daysActive, 'day')} active (since ${shortDay(a.firstFiredOn)}): ${a.message}`;
        line(
          o,
          t,
          `<b>${escapeHtml(a.display)}</b> ${muted(`[${a.status.toLowerCase()}] ${plural(a.daysActive, 'day')} active`)}: ${escapeHtml(a.message)}`,
        );
      }
    }
  }

  // 9. Upcoming
  const upcomingTitle = w.recap ? 'This week (+ earnings, next 3 weeks)' : 'Upcoming 7 days';
  if (d.upcoming.items.length || !d.upcoming.available.earnings) {
    section(o, upcomingTitle);
    if (!d.upcoming.available.earnings) {
      line(
        o,
        `earnings calendar unavailable today${d.upcoming.available.lastFetched ? ` (last updated ${d.upcoming.available.lastFetched})` : ''}`,
      );
    }
    for (const e of d.upcoming.items) {
      const tod = TIME_OF_DAY[e.timeOfDay] ? ` ${TIME_OF_DAY[e.timeOfDay]}` : '';
      const state =
        e.eventType === 'earnings' || e.eventType === 'lockup_expiry' || e.eventType === 'guidance'
          ? e.estimated
            ? ' (estimated)'
            : ' (confirmed)'
          : '';
      const moved = e.previousDate ? ` — moved from ${shortDay(e.previousDate)}` : '';
      const note = e.note ? ` — ${e.note}` : '';
      const t = `${shortDay(e.date)} ${e.ticker} ${EVENT_LABEL[e.eventType] ?? e.eventType}${tod}${state}: ${e.title}${moved}${note} [${SOURCE_LABEL[e.source] ?? e.source}]`;
      line(
        o,
        t,
        `<b>${escapeHtml(shortDay(e.date))} ${escapeHtml(e.ticker)}</b> ${escapeHtml(`${EVENT_LABEL[e.eventType] ?? e.eventType}${tod}${state}`)}: ${escapeHtml(e.title)}${moved ? ` <b style="color:#b3261e">${escapeHtml(moved)}</b>` : ''}${note ? muted(note) : ''} ${muted(`[${SOURCE_LABEL[e.source] ?? e.source}]`)}`,
      );
    }
  }

  // 10. Recap only
  if (w.recap && d.lastWeek) {
    section(o, 'Last week');
    for (const r of d.lastWeek) {
      line(
        o,
        `${r.symbol}: ${signedPct(r.changePct)}`,
        `<b>${escapeHtml(r.symbol)}</b> <span style="color:${(r.changePct ?? 0) < 0 ? '#b3261e' : '#137333'}">${signedPct(r.changePct)}</span>`,
      );
    }
    if (d.pastWeekAlerts?.length) {
      o.text.push('', 'Alerts last week:');
      o.html.push(`<div style="margin:10px 0 2px"><b>Alerts last week</b></div>`);
      for (const a of d.pastWeekAlerts)
        line(o, `${dayTime(a.createdAt)} — ${a.subject.replace(/^\[AIA\] /, '')}`);
    }
  }

  // 11. Feed health
  section(o, 'Feed health');
  if (d.health.issues.length === 0) {
    line(o, `All ${d.health.ok} feeds OK.`);
  } else {
    line(
      o,
      `${plural(d.health.issues.length, 'issue')}: ${d.health.issues.map((i) => `${FEED_LABEL[i.feed] ?? i.feed} ${i.status}${i.detail ? ` (${i.detail})` : ''}`).join('; ')}`,
    );
  }

  o.text.push('', `Generated ${dayTime(d.generatedAt)} PT. Research and alerts only, no trading.`);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:12px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.45;color:#1a1a1a">
<div style="max-width:640px;margin:0 auto">
${o.html.join('\n')}
<p style="color:#777;font-size:12px;margin-top:24px">Generated ${escapeHtml(dayTime(d.generatedAt))} PT. Research and alerts only, no trading.</p>
</div></body></html>`;
  return { subject, text: o.text.join('\n').trimStart(), html };
}
