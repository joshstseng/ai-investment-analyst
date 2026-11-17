/**
 * V2 HOOK (not built yet): an AI "story check" per pullback alert.
 *
 * The numbers check (price, quality scorecard, exit levels) is done in code. The story check is
 * the part code can't do: why the stock fell and whether the thesis still holds. A future
 * implementation calls the Claude API (Sonnet; see CLAUDE.md for model and budget rules) with
 * the alert's data plus retrieved sources, and returns the fields below. The result would be
 * appended to the alert email (or sent as a follow-up) and stored next to the observation.
 *
 * Rules for the implementation:
 * - It never decides whether a ticker qualified or changes tiers/state: that stays in code.
 * - Every claim about the cause of the drop cites a source (URL + publisher + date).
 * - Research only, never an order; staged entries are ideas, not instructions.
 * - Respect the monthly API spend cap; skip (return null) when over budget or unavailable.
 */
import type { PriceMetrics, PullbackCheck, Scorecard } from '@aia/core';

export interface StoryCheckInput {
  symbol: string;
  name: string | null;
  check: PullbackCheck;
  date: string;
  metrics: PriceMetrics;
  tier: number | null;
  scorecard: Scorecard | null;
  qualityPass: boolean | null;
  nextEarnings: string | null;
  /** Latest headlines we already have (the implementation may fetch more). */
  headlines: { title: string; url: string | null; publishedAt: string }[];
  exitLevels: { riskStop: number; valuationTrim: number | null; reUnderwrite: string | null };
}

export interface SourcedClaim {
  text: string;
  sources: { url: string; publisher: string; date: string }[];
}

export interface StoryCheck {
  /** The cause of the drop, with sources (e.g. guidance cut, downgrade, sector move, macro). */
  causeOfDrop: SourcedClaim[];
  /** Whether earnings power looks intact, and why. */
  earningsPowerIntact: { verdict: 'intact' | 'impaired' | 'unclear'; reasoning: SourcedClaim[] };
  bullCase: string[];
  bearCase: string[];
  /** Staged entry idea: a starter size; add only after a confirming catalyst. */
  stagedEntry: { starter: string; addOnlyAfter: string };
  exitPlan: {
    thesisBreakTrigger: string;
    takeProfitOrReunderwrite: string;
    valuationTrim: string;
    riskStop: { level: number; basis: string };
  };
  model: string;
  generatedAt: string;
}

export interface PullbackResearcher {
  /** Returns null when research is unavailable (no key, over budget, error). */
  research(input: StoryCheckInput): Promise<StoryCheck | null>;
}

/** Step 1 default: no AI. TODO(v2): implement with the Claude API and wire into runPullbackCheckJob. */
export const noResearcher: PullbackResearcher = {
  research: async () => null,
};
