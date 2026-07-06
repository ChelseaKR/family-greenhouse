/**
 * Citation/grounding guard for RAG-sourced chat answers (AIEV-12).
 *
 * Scope: this guard applies to the `search_care_knowledge` (RAG) path only —
 * NOT to tool-based answers about the user's own plants/tasks/climate, which
 * are grounded by construction (the tool result IS the source of truth, and
 * the household-scoping tests elsewhere cover that it can't leak another
 * household's data).
 *
 * What it checks: numeric/quantitative care claims (a frequency, a
 * percentage, a temperature, a duration — the class of claim that produced
 * the real "missing-data-as-false-answer" bugs fixed in #170/#171) must be
 * traceable to a retrieved span's text. A claim with a number that appears
 * in NO retrieved span is flagged as ungrounded — the model asserted a
 * specific fact the corpus never gave it.
 *
 * Deliberately NOT covered (starter-version limitation, see evals/README.md):
 * qualitative claims ("bright indirect light is best for pothos") aren't
 * mechanically checked here — verifying those requires semantic entailment
 * (an LLM-as-judge or FActScore-class tool), which is the full RAGAS/DeepEval
 * suite this repo has waived pending the eval-harness build-out (see the
 * dated waiver in docs/RESPONSIBLE-TECH-AUDITS.md).
 *
 * This module is unit-tested against synthetic fixtures
 * (chatGroundingGuard.test.ts) and is NOT YET wired as a hard block into the
 * live turnEvents() response path — see the model card / waiver for why
 * (risk of false-positive-blocking a correct answer without more live
 * testing than this pass can safely do without calling real Bedrock).
 */

export interface RetrievedSpan {
  source: string;
  text: string;
}

export interface GroundingResult {
  grounded: boolean;
  /** Claim sentences whose numeric/quantitative token has no match in any retrieved span. */
  ungroundedClaims: string[];
  /** All numeric/quantitative claim sentences found, grounded or not (for reporting). */
  claimsChecked: string[];
}

// Matches a number followed by a care-relevant unit, OR a bare "every N
// day(s)/week(s)/month(s)" frequency phrase — the two claim shapes the actual
// corpus makes ("50%+", "every 2-4 weeks", "70-90%", "below ~40%").
// No trailing `\b` after the unit alternation: `%` and `°` are already
// non-word characters, so `\b` never matches right after them (there's no
// word/non-word transition between "%" and a following space) — that gap
// silently dropped every percentage claim in earlier testing.
const CLAIM_PATTERN =
  /\d+(\.\d+)?\s*(%|percent|degrees?|°[fc]?|days?|weeks?|months?|years?|hours?|minutes?|inches?|in\.|cm|ft)(?![a-z])|every\s+\d+/i;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pulls every standalone number (integer or decimal) out of a string. */
function extractNumbers(text: string): string[] {
  return text.match(/\d+(\.\d+)?/g) ?? [];
}

/**
 * Checks whether an answer's numeric/quantitative claims are each backed by
 * at least one retrieved span containing the same number. Vacuously grounded
 * if the answer makes no numeric claims (nothing to check) — this guard
 * targets the specific "fabricated statistic" failure mode, not general
 * factuality.
 */
export function checkGrounding(
  answerText: string,
  retrievedSpans: RetrievedSpan[]
): GroundingResult {
  const sentences = splitSentences(answerText);
  const claimSentences = sentences.filter((s) => CLAIM_PATTERN.test(s));
  const corpusText = retrievedSpans.map((s) => s.text).join('\n');
  const corpusNumbers = new Set(extractNumbers(corpusText));

  const ungroundedClaims: string[] = [];
  for (const claim of claimSentences) {
    const claimNumbers = extractNumbers(claim);
    // A claim sentence with numbers, none of which appear anywhere in the
    // retrieved spans, is ungrounded. (Numbers that appear for an unrelated
    // reason, e.g. a plant count, are an accepted false-negative risk in this
    // heuristic — documented in evals/README.md.)
    const hasSupport = claimNumbers.length === 0 || claimNumbers.some((n) => corpusNumbers.has(n));
    if (!hasSupport) ungroundedClaims.push(claim);
  }

  return {
    grounded: ungroundedClaims.length === 0,
    ungroundedClaims,
    claimsChecked: claimSentences,
  };
}
