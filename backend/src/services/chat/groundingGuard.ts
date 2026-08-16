/**
 * Citation/grounding guard for RAG-sourced chat answers (AIEV-12).
 *
 * Scope: this guard applies to the `search_care_knowledge` (RAG) path only —
 * NOT to tool-based answers about the user's own plants/tasks/climate, which
 * are grounded by construction (the tool result IS the source of truth, and
 * the household-scoping tests elsewhere cover that it can't leak another
 * household's data).
 *
 * What it checks: numeric/quantitative care claims (a frequency, percentage,
 * temperature, duration, dose/dilution, or fertilizer ratio — the class of
 * claim that produced the real "missing-data-as-false-answer" bugs fixed in
 * #170/#171 and the dose blind spot fixed in #307) must be traceable to a
 * retrieved span's text. A claim with a number that appears in NO retrieved
 * span is flagged as ungrounded — the model asserted a specific fact the
 * corpus never gave it.
 *
 * What it REPORTS is a three-state verdict, never a bare boolean pass
 * (#307). "The guard checked four numbers and they all trace to the corpus"
 * and "the guard recognized nothing in this answer" are different facts and
 * must not share a value:
 *
 *   - `verified`   — at least one claim was checked and every one is
 *                    supported, and no unclassified numeric content remains.
 *   - `unverified` — the guard checked nothing it can vouch for: either the
 *                    answer carries no recognized claim at all, or it carries
 *                    numeric content that fits no checkable claim shape. The
 *                    guard makes NO assertion about such an answer.
 *   - `ungrounded` — at least one recognized claim is unsupported. This is
 *                    the only verdict that blocks delivery.
 *
 * `unverified` deliberately does not block: an answer may legitimately be
 * qualitative, and blocking on "I don't recognize this" would replace every
 * such answer with the verification message. It also must never be read as a
 * pass — see `docs/observability.md` for the distinct log events, and
 * `docs/adr/0009-three-state-grounding-verdict.md` for the decision record.
 * (ADR 0008 is the unit-aware recognition decision; 0009 amends its reporting
 * bullet, so a reader sent to 0008 alone lands on the superseded half.)
 *
 * Deliberately NOT covered (starter-version limitation, see evals/README.md):
 * qualitative claims ("bright indirect light is best for pothos") aren't
 * mechanically checked here — verifying those requires semantic entailment
 * (an LLM-as-judge or FActScore-class tool), which is the full RAGAS/DeepEval
 * suite this repo has waived pending the eval-harness build-out (see the
 * dated waiver in docs/RESPONSIBLE-TECH-AUDITS.md). Such an answer is
 * reported `unverified`, not passed as checked.
 *
 * This module is unit-tested against synthetic fixtures
 * (chatGroundingGuard.test.ts) and wired into the live turnEvents() response
 * path. When RAG context is present, the completed answer is checked before
 * persistence or delivery; an unsupported quantitative claim is replaced by
 * a safe verification message. Streaming RAG answers are buffered until this
 * check completes so ungrounded text is never transiently shown.
 */

export interface RetrievedSpan {
  source: string;
  text: string;
}

/**
 * Three distinguishable outcomes. There is deliberately no `grounded: boolean`
 * on the result: a boolean cannot tell "checked and supported" apart from
 * "checked nothing", and the second one reported as the first is the defect
 * this shape exists to make unrepresentable (#307).
 */
export type GroundingVerdict = 'verified' | 'unverified' | 'ungrounded';

export interface GroundingResult {
  verdict: GroundingVerdict;
  /** Claim sentences whose numeric/quantitative token has no match in any retrieved span. */
  ungroundedClaims: string[];
  /** All numeric/quantitative claim sentences found, grounded or not (for reporting). */
  claimsChecked: string[];
  /**
   * Sentences that carry numeric content the guard could not resolve to a
   * checkable claim shape. Non-empty means "there are numbers in this answer
   * that nothing verified" — the honest inverse of silently treating an
   * unrecognized number as clean.
   */
  unclassifiedNumericSentences: string[];
}

/**
 * The single delivery decision. Only an actively contradicted claim blocks;
 * callers must not treat `unverified` as a failure, nor as a pass.
 */
export function isBlockingVerdict(result: GroundingResult): boolean {
  return result.verdict === 'ungrounded';
}

// Matches a number followed by a care-relevant unit, a bare "every N"
// frequency phrase, or a numeric mixing/fertilizer ratio. These are claim
// shapes the actual corpus makes ("50%+", "every 2-4 weeks", "1 tsp per
// gallon", "3-4 times the pot's volume", and "10-10-10" NPK).
// No trailing `\b` after the unit alternation: `%` and `°` are already
// non-word characters, so `\b` never matches right after them (there's no
// word/non-word transition between "%" and a following space) — that gap
// silently dropped every percentage claim in earlier testing.
//
// Ratio handling is deliberately narrower than "any hyphenated numbers":
// colon forms accept two or three components, while a hyphen/en-dash
// form requires three NPK-shaped components. That catches 1:4 and 20-20-20
// without treating slash-formatted dates or an ISO date such as 2026-08-09
// as fertilizer claims.
const NUMBER = String.raw`\d+(?:\.\d+)?`;
const RATIO_NUMBER = String.raw`\d{1,3}(?:\.\d+)?`;
const MEASUREMENT_UNIT = String.raw`(?:ml|milliliters?|millilitres?|liters?|litres?|l|fl\.?\s*oz|oz|ounces?|tsp|teaspoons?|tbsp|tablespoons?|cups?|gallons?|quarts?|gal|grams?|mg|g|lbs?|pounds?)`;
const SENSITIVE_UNIT = String.raw`(?:${MEASUREMENT_UNIT}|times?|parts?)`;
const CARE_UNIT = String.raw`(?:%|percent|degrees?|°[fc]?|days?|weeks?|months?|years?|hours?|minutes?|inches?|in\.|cm|ft|${SENSITIVE_UNIT}|plants?|tasks?|reminders?)`;
const COLON_RATIO = String.raw`${RATIO_NUMBER}\s*:\s*${RATIO_NUMBER}(?:\s*:\s*${RATIO_NUMBER})?`;
const NPK_RATIO = String.raw`${RATIO_NUMBER}\s*[-–]\s*${RATIO_NUMBER}\s*[-–]\s*${RATIO_NUMBER}(?:\s*NPK)?`;
const CLAIM_PATTERN = new RegExp(
  String.raw`(?:(?<!\d)(?:${NPK_RATIO}|${COLON_RATIO})(?!\d)|${NUMBER}\s*${CARE_UNIT}(?![a-z])|every\s+${NUMBER})`,
  'i'
);

// Dose claims are not always written with a digit. The corpus itself gives
// the highest-consequence instruction in words — "at half the recommended
// strength" (fertilizing.md:7), "quarter strength" (:8), "half-strength"
// (seasonal-care.md:41) — so an answer saying "at double strength" carries a
// real dilution instruction that the numeric patterns above cannot see at
// all. Treated as a checkable claim (matched against the same corpus spans),
// not as an unverifiable shape: the quantity word either appears with that
// noun in the retrieved text or it does not.
const DOSE_WORD_QUANTITY = String.raw`(?:half|quarter|third|full|double|twice|triple)`;
const DOSE_WORD_NOUN = String.raw`(?:strengths?|doses?|dosage|dilutions?|concentrations?)`;
const DOSE_WORD_SOURCE = String.raw`\b(${DOSE_WORD_QUANTITY})[-\s]+(?:\w+[-\s]+){0,3}?(${DOSE_WORD_NOUN})\b`;
// Separate instances: the `g`-flagged one carries `lastIndex` state and must
// never be shared with a `.test()` call site.
const DOSE_WORD_PATTERN = new RegExp(DOSE_WORD_SOURCE, 'i');
const DOSE_WORD_PATTERN_GLOBAL = new RegExp(DOSE_WORD_SOURCE, 'gi');

/** A sentence carries a claim if any recognized claim shape appears in it. */
function isClaimSentence(sentence: string): boolean {
  return CLAIM_PATTERN.test(sentence) || DOSE_WORD_PATTERN.test(sentence);
}

/**
 * Numeric content in a NON-claim sentence: a number the guard saw but could
 * not resolve to any checkable shape. Bare list markers ("1.", "2)") are not
 * quantitative content and are excluded so ordinary numbered advice doesn't
 * masquerade as an unverifiable quantity.
 */
function hasUnclassifiedNumber(sentence: string): boolean {
  return /\d/.test(sentence.replace(/^\s*\d+[.)]\s*/, ''));
}

/**
 * Dose/dilution evidence needs a little more specificity than the legacy
 * number-anywhere heuristic. `3 tsp` must not be "supported" merely because
 * the same article separately says `3-4 times`; likewise an NPK ratio must
 * occur as that ratio, not as three unrelated numbers. Unit aliases and dose
 * denominators are canonicalized so `1 tsp per gallon` and `1 teaspoon per
 * gal` remain equivalent, while `1 tsp per cup` does not borrow their support.
 */
function canonicalSensitiveUnit(unit: string): string {
  const compact = unit.toLowerCase().replace(/[.\s]/g, '');
  if (/^millilit(?:er|re)s?$/.test(compact) || compact === 'ml') return 'ml';
  if (/^lit(?:er|re)s?$/.test(compact) || compact === 'l') return 'l';
  if (compact === 'floz' || compact === 'oz' || /^ounces?$/.test(compact)) return 'oz';
  if (compact === 'tsp' || /^teaspoons?$/.test(compact)) return 'tsp';
  if (compact === 'tbsp' || /^tablespoons?$/.test(compact)) return 'tbsp';
  if (/^cups?$/.test(compact)) return 'cup';
  if (/^gallons?$/.test(compact) || compact === 'gal') return 'gallon';
  if (/^quarts?$/.test(compact)) return 'quart';
  if (compact === 'g' || /^grams?$/.test(compact)) return 'g';
  if (compact === 'mg') return 'mg';
  if (/^lbs?$/.test(compact) || /^pounds?$/.test(compact)) return 'lb';
  if (/^times?$/.test(compact)) return 'times';
  if (/^parts?$/.test(compact)) return 'parts';
  return compact;
}

function extractSensitiveEvidence(text: string): Set<string> {
  const evidence = new Set<string>();
  const quantityPattern = new RegExp(
    String.raw`(${NUMBER})\s*(${SENSITIVE_UNIT})(?![a-z])(?:\s*(?:per\b|/)\s*(?:(${NUMBER})\s*)?(${MEASUREMENT_UNIT})(?![a-z]))?`,
    'gi'
  );
  for (const match of text.matchAll(quantityPattern)) {
    let token = `quantity:${match[1]}:${canonicalSensitiveUnit(match[2])}`;
    if (match[4]) {
      const denominatorAmount = match[3];
      const canonicalDenominator = canonicalSensitiveUnit(match[4]);
      token +=
        denominatorAmount && Number(denominatorAmount) !== 1
          ? `:per:${denominatorAmount}:${canonicalDenominator}`
          : `:per:${canonicalDenominator}`;
    }
    evidence.add(token);
  }

  const ratioPattern = new RegExp(String.raw`(?<!\d)(?:${NPK_RATIO}|${COLON_RATIO})(?!\d)`, 'gi');
  for (const match of text.matchAll(ratioPattern)) {
    evidence.add(`ratio:${extractNumbers(match[0]).join(':')}`);
  }

  for (const match of text.matchAll(DOSE_WORD_PATTERN_GLOBAL)) {
    evidence.add(`dose:${canonicalDoseQuantity(match[1])}:${canonicalDoseNoun(match[2])}`);
  }
  return evidence;
}

/** "twice the strength" and "double strength" are the same instruction. */
function canonicalDoseQuantity(quantity: string): string {
  const word = quantity.toLowerCase();
  return word === 'twice' ? 'double' : word;
}

function canonicalDoseNoun(noun: string): string {
  const word = noun.toLowerCase().replace(/s$/, '');
  return word === 'dosage' ? 'dose' : word;
}

function splitSentences(text: string): string[] {
  // Keep the period inside the care-unit abbreviation `fl. oz`; the generic
  // punctuation splitter would otherwise turn `7 fl. oz` into two fragments
  // and leave both without a recognizable quantitative claim. Restore the
  // exact user-facing punctuation after splitting so results/logging retain
  // the original sentence text. Ordinary sentence-ending periods still split.
  const abbreviationPeriod = '\uE000';
  const protectedText = text.replace(/\bfl\.(?=\s*oz(?![a-z]))/gi, (match) =>
    match.replace('.', abbreviationPeriod)
  );
  return protectedText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replaceAll(abbreviationPeriod, '.').trim())
    .filter(Boolean);
}

/** Pulls every standalone number (integer or decimal) out of a string. */
function extractNumbers(text: string): string[] {
  return text.match(/\d+(\.\d+)?/g) ?? [];
}

/**
 * Checks whether an answer's numeric/quantitative claims are each backed by
 * at least one retrieved span containing the same number.
 *
 * An answer the guard recognized nothing in is reported `unverified`, NOT
 * grounded: "nothing to check" is not evidence of correctness, and a caller
 * (or a reader of the logs, or `docs/RESPONSIBLE-TECH-AUDITS.md`) must not be
 * able to mistake it for one. This guard targets the specific "fabricated
 * quantity" failure mode, not general factuality.
 */
export function checkGrounding(
  answerText: string,
  retrievedSpans: RetrievedSpan[]
): GroundingResult {
  const sentences = splitSentences(answerText);
  const claimSentences = sentences.filter(isClaimSentence);
  const unclassifiedNumericSentences = sentences.filter(
    (s) => !isClaimSentence(s) && hasUnclassifiedNumber(s)
  );
  const corpusText = retrievedSpans.map((s) => s.text).join('\n');
  const corpusNumbers = new Set(extractNumbers(corpusText));
  const corpusSensitiveEvidence = extractSensitiveEvidence(corpusText);

  const ungroundedClaims: string[] = [];
  for (const claim of claimSentences) {
    const claimNumbers = extractNumbers(claim);
    // Every numeric token in the claim must appear in the retrieved spans. A
    // fabricated threshold must not piggyback on one supported number in the
    // same sentence (for example, "50% normally, but 92% today"). Numbers that
    // appear in context for an unrelated reason remain an accepted heuristic
    // false-negative risk documented in evals/README.md.
    const sensitiveEvidence = extractSensitiveEvidence(claim);
    const hasNumberSupport =
      claimNumbers.length === 0 || claimNumbers.every((n) => corpusNumbers.has(n));
    const hasSensitiveSupport = [...sensitiveEvidence].every((token) =>
      corpusSensitiveEvidence.has(token)
    );
    const hasSupport = hasNumberSupport && hasSensitiveSupport;
    if (!hasSupport) ungroundedClaims.push(claim);
  }

  // Verified requires positive evidence: something was checked, all of it
  // held, and no number was left unaccounted for. Anything else that isn't
  // an outright contradiction is "the guard cannot vouch for this answer".
  const verdict: GroundingVerdict =
    ungroundedClaims.length > 0
      ? 'ungrounded'
      : claimSentences.length > 0 && unclassifiedNumericSentences.length === 0
        ? 'verified'
        : 'unverified';

  return {
    verdict,
    ungroundedClaims,
    claimsChecked: claimSentences,
    unclassifiedNumericSentences,
  };
}
