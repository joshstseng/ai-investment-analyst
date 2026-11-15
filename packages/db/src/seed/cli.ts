/**
 * pnpm seed [--dir <path>] [--dry-run]
 *
 * Parses data/seed/, upserts everything in one transaction, verifies the result against
 * holdings.md (rolling back if it doesn't match), and logs the run to job_runs.
 */
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { ruleAlertLabel } from '@aia/core';
import { createDb } from '../client';
import { loadDatabaseUrl } from '../env';
import { describeDatabaseUrl } from '../migrations';
import { jobRuns } from '../schema';
import { applySeedPlan, type ApplyReport } from './apply';
import { loadSeedDir } from './index';
import type { SeedPlan } from './plan';
import { verifyAgainstHoldingsMd, type VerifyResult } from './verify';

const { values: args } = parseArgs({
  options: {
    dir: {
      type: 'string',
      default: fileURLToPath(new URL('../../../../data/seed', import.meta.url)),
    },
    'dry-run': { type: 'boolean', default: false },
  },
});

class VerifyFailed extends Error {}

function printPlan(plan: SeedPlan) {
  console.log(`\nAccounts`);
  for (const a of plan.accounts) {
    console.log(`  ${a.name.padEnd(22)} total $${a.totalValue}  cash $${a.cashBalance}`);
  }
  console.log(`\nHoldings (${plan.holdings.length} lots)`);
  for (const h of plan.holdings) {
    const flags = [
      h.needsConfirmation && 'NEEDS CONFIRMATION',
      h.costBasisTotal && `total cost $${h.costBasisTotal}`,
    ].filter(Boolean);
    console.log(
      `  ${h.accountType.padEnd(19)} ${h.symbol.padEnd(20)} lot ${h.lotNo}  ${h.quantity.padStart(8)} @ $${h.avgCost}${flags.length ? `  [${flags.join('; ')}]` : ''}`,
    );
  }
  console.log(`\nExit rules (${plan.rules.length})`);
  for (const r of plan.rules) {
    const what = r.ruleType
      ? `${r.ruleType} ${JSON.stringify(r.params)}`
      : r.thesisBreakTriggers
        ? `judgment: ${r.thesisBreakTriggers.slice(0, 70)}${r.thesisBreakTriggers.length > 70 ? '…' : ''}`
        : '(to be defined)';
    console.log(
      `  ${r.symbol.padEnd(20)} ${r.status.padEnd(11)} ${`(${ruleAlertLabel(r.status)})`.padEnd(18)} ${r.purpose.padEnd(14)} ${what}`,
    );
  }
  console.log(`\nWatchlist: ${plan.watchlist.map((w) => w.symbol).join(', ') || '(none)'}`);
  if (plan.warnings.length) {
    console.log(`\nWarnings`);
    for (const w of plan.warnings) console.log(`  ! ${w}`);
  }
}

function printReport(report: ApplyReport, verify: VerifyResult) {
  console.log(`\nWrite summary (inserted / updated / unchanged)`);
  for (const [table, c] of Object.entries(report.counts)) {
    console.log(`  ${table.padEnd(12)} ${c.inserted} / ${c.updated} / ${c.unchanged}`);
  }
  if (report.stale.length) {
    console.log(`\nIn the database but not in the seed (left in place):`);
    for (const s of report.stale) console.log(`  ? ${s}`);
  }
  console.log(
    `\nVerify against holdings.md: ${verify.ok ? 'OK' : 'FAILED'} (${verify.checked} lots checked)`,
  );
  for (const p of verify.problems) console.log(`  ✗ ${p}`);
}

const { input, plan } = loadSeedDir(args.dir);
console.log(`Seed dir: ${args.dir}`);
printPlan(plan);

if (args['dry-run']) {
  console.log('\n--dry-run: nothing written.');
  process.exit(0);
}

const databaseUrl = loadDatabaseUrl();
console.log(`\nTarget database: ${describeDatabaseUrl(databaseUrl)}`);
const { db, sql } = createDb(databaseUrl, { max: 1 });
const [run] = await db.insert(jobRuns).values({ job: 'seed_import' }).returning({ id: jobRuns.id });
try {
  const { report, verify } = await db.transaction(async (tx) => {
    const report = await applySeedPlan(tx, plan);
    const verify = await verifyAgainstHoldingsMd(tx, input.holdingsMd);
    if (!verify.ok) {
      printReport(report, verify);
      throw new VerifyFailed('verification failed; transaction rolled back');
    }
    return { report, verify };
  });
  printReport(report, verify);
  await db
    .update(jobRuns)
    .set({
      status: 'success',
      finishedAt: new Date(),
      itemsProcessed: plan.holdings.length + plan.rules.length + plan.watchlist.length,
      meta: { counts: report.counts, stale: report.stale, warnings: plan.warnings },
    })
    .where(eq(jobRuns.id, run!.id));
} catch (err) {
  await db
    .update(jobRuns)
    .set({ status: 'error', finishedAt: new Date(), error: String(err) })
    .where(eq(jobRuns.id, run!.id));
  console.error(`\n${String(err)}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
