/** `pnpm collect levels [--as-of ISO]`: pre-market prices and levels to watch, for inspection. */
import { nyDate } from '@aia/core';
import { marketCalendar, pricesDaily } from '@aia/db';
import { and, desc, eq, lte } from 'drizzle-orm';
import type { Context } from '../context';
import { loadUniverse } from '../market/universe';
import { latestCompletedSession } from '../rules/check';
import { loadLevels } from './levels';
import { fetchPremarket } from './premarket';

export async function printLevels(ctx: Context, now: Date) {
  const { db, alpaca } = ctx;
  const today = nyDate(now);
  const [session] = await db.select().from(marketCalendar).where(eq(marketCalendar.date, today));
  const asOfDate = (await latestCompletedSession(db, now)) ?? today;
  console.log(`As of ${now.toISOString()}; last completed session ${asOfDate}`);

  if (session?.sessionOpenAt) {
    const symbols = (await loadUniverse(db)).priceSymbols;
    const closes = new Map<string, number>();
    for (const s of symbols) {
      const [b] = await db
        .select({ close: pricesDaily.close })
        .from(pricesDaily)
        .where(and(eq(pricesDaily.symbol, s), lte(pricesDaily.date, asOfDate)))
        .orderBy(desc(pricesDaily.date))
        .limit(1);
      if (b) closes.set(s, Number(b.close));
    }
    const pm = await fetchPremarket(alpaca, {
      symbols,
      lastCloses: closes,
      sessionOpenAt: session.sessionOpenAt,
      openAt: session.openAt,
      now,
    });
    console.log(`\nPre-market (${pm.feed}, as of ${pm.asOf.toISOString()}):`);
    for (const q of pm.quotes) {
      const chg = q.changePct === null ? '' : `${q.changePct > 0 ? '+' : ''}${q.changePct}%`;
      console.log(
        `  ${q.symbol.padEnd(6)} close ${String(q.lastClose ?? '-').padEnd(8)} pre ${String(q.price ?? 'no trades').padEnd(10)} ${chg.padEnd(7)} vol ${q.volume}`,
      );
    }
  } else {
    console.log('No session today (holiday or weekend): no pre-market.');
  }

  console.log('\nLevels to watch (within 5% of the last close):');
  for (const l of await loadLevels(db, asOfDate)) {
    const side = l.direction === 'down' ? 'above' : 'below';
    console.log(
      `  ${l.display.padEnd(26)} ${l.label.padEnd(18)} $${l.level} vs close $${l.close}: ${l.distancePct}% / $${l.distanceDollars} ${side} [${l.status}]`,
    );
  }
}
