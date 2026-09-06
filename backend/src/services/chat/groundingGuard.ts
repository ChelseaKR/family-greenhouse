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
 * ONE EXCEPTION to the "unverified does not block" rule (ADR 0011): a
 * CATEGORICAL PET-SAFETY CLAIM — a clause asserting a plant is safe /
 * non-toxic / harmless / fine for cats, dogs or pets, in English or Spanish —
 * is a recognized claim, and an ungrounded one is `ungrounded`, not
 * `unverified`. It blocks. The reasoning that lets a qualitative care answer
 * through ("the corpus is largely qualitative; the guard just didn't
 * recognize anything") does not transfer to an all-clear about an animal:
 * a verified source exists (`models/petToxicity.ts`, reachable through the
 * `check_pet_toxicity` tool), so "no evidence" here means "the source was
 * not consulted", and the failure direction is an animal being harmed. The
 * danger direction ("toxic to cats") is deliberately not gated — a false
 * alarm costs a needless scare, a false all-clear can cost a pet. Evidence is
 * structured (`RetrievedSpan.petSafety`), per-species, and matched to the
 * plant the clause names where it names one. See `checkSafetyClaims`.
 *
 * A THIRD recognized claim class (ADR 0026): a COUNT OR TOTALITY CLAIM ABOUT
 * THE USER'S OWN COLLECTION — "you have 12 plants", "none of your plants are
 * toxic" — checked not against a corpus but against how much of the household
 * the answering service was actually given (`checkHouseholdClaims`). It exists
 * for the Sprout path, whose payload is a strict subset of the household twice
 * over (#549). Same rule as the other two: an unsupported claim blocks.
 *
 * This module is unit-tested against synthetic fixtures
 * (chatGroundingGuard.test.ts) and wired into the live turnEvents() response
 * path. When RAG context is present, the completed answer is checked before
 * persistence or delivery; an unsupported quantitative claim is replaced by
 * a safe verification message. Streaming RAG answers are buffered until this
 * check completes so ungrounded text is never transiently shown.
 */
import type { SproutCoverage } from '../sprout.js';

export type PetSpecies = 'cats' | 'dogs';
export type PetSafetyVerdict = 'toxic' | 'non-toxic';

/**
 * One curated-table entry carried on a `check_pet_toxicity` span. This is the
 * ONLY evidence a categorical safety claim can trace to: the corpus carries no
 * toxicity content by design (the table is the single source, and a second
 * source is how two sources drift apart), and a verdict is a fact about a
 * named plant and a species, not a number that could be matched by digits.
 */
export interface PetSafetyEvidence {
  /** Every name the entry answers to, normalized with `normalizeEvidenceName`. */
  names: string[];
  cats: PetSafetyVerdict;
  dogs: PetSafetyVerdict;
}

export interface RetrievedSpan {
  source: string;
  text: string;
  /**
   * Structured verdicts from the pet-toxicity tool. Present (possibly empty)
   * on every `check_pet_toxicity` span; an empty array is a "not in our
   * checker" result, which keeps the guard active without grounding anything.
   */
  petSafety?: PetSafetyEvidence[];
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
  /** Sentences carrying a categorical pet-safety claim, grounded or not (ADR 0011). */
  safetyClaimsChecked: string[];
  /**
   * Safety-claim sentences with no supporting non-toxic verdict for the plant
   * and species they vouch for. Each one blocks: this is the one place the
   * guard blocks on "nothing to check", because here nothing-to-check means
   * the verified table was not consulted.
   */
  ungroundedSafetyClaims: string[];
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

// ---------------------------------------------------------------------------
// Categorical pet-safety claims (ADR 0011)
// ---------------------------------------------------------------------------

/**
 * Accent-fold and lowercase for matching. Spanish predicates are matched on
 * the folded form ("tóxico" → "toxico", "está" → "esta") so the patterns
 * below stay ASCII and `\b` behaves; curly apostrophes are straightened for
 * the same reason. Per-character length is preserved for precomposed input,
 * but nothing below relies on mapping offsets back to the original text.
 */
function foldText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’‘]/g, "'")
    .toLowerCase();
}

/**
 * Same normalization the toxicity matcher applies to its own names
 * (lowercase, accents folded, apostrophes dropped, non-alphanumerics to single
 * spaces). Evidence names AND the claim text are normalized with this one
 * function so "devil's ivy", "Devil’s Ivy" and "devils ivy" compare equal.
 */
export function normalizeEvidenceName(raw: string): string {
  return foldText(raw)
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const PET_NOUN_CATS = String.raw`(?:cats?|kittens?|kitt(?:y|ies)|felines?|gat[ao]s?|gatit[ao]s?|felin[ao]s?)`;
const PET_NOUN_DOGS = String.raw`(?:dogs?|pupp(?:y|ies)|pups?|canines?|perr[ao]s?|perrit[ao]s?|cachorr[ao]s?|canin[ao]s?)`;
const PET_NOUN_GENERIC = String.raw`(?:pets?|animals?|mascotas?|animal(?:es)?)`;
const PET_NOUN = String.raw`(?:${PET_NOUN_CATS}|${PET_NOUN_DOGS}|${PET_NOUN_GENERIC})`;
const CATS_PATTERN = new RegExp(String.raw`\b${PET_NOUN_CATS}\b`);
const DOGS_PATTERN = new RegExp(String.raw`\b${PET_NOUN_DOGS}\b`);
const PET_NOUN_PATTERN = new RegExp(String.raw`\b${PET_NOUN}\b`);

// A positive predicate needs either a copula before it or a preposition after
// it: "somewhere safe where the dog can't reach it" is neither, "is safe",
// "safe for cats", "es seguro", "segura para gatos" all are. Up to two
// intervening words absorb intensifiers ("is completely safe"). "fine" /
// "okay" are common enough in ordinary care advice that they only count when
// a pet noun follows the preposition directly ("fine for cats").
const SAFE_WORD_EN = String.raw`(?:safe|harmless)`;
const SOFT_WORD_EN = String.raw`(?:fine|okay|ok)`;
const SAFE_WORD_ES = String.raw`(?:segur[ao]s?|inofensiv[ao]s?|apt[ao]s?)`;
const COPULA_EN = String.raw`(?:is|are|was|were|be|been|being|remains?|stays?|seems?|considered|deemed|rated|listed|classified|'s|'re)`;
const COPULA_ES = String.raw`(?:es|son|era|eran|esta|estan|sea|sean|resulta|resultan|seria|serian|considerad[ao]s?|considera)`;
const PREP_EN = String.raw`(?:for|around|with|to|near)`;
const PREP_ES = String.raw`(?:para|con)`;
const FILLER = String.raw`(?:[a-z0-9%'-]+\s+){0,2}?`;
const DETERMINER = String.raw`(?:(?:the|your|my|our|a|an|most|all|los|las|tus|mis|un|una)\s+)?`;
// `(?<!pet[-\s])` keeps the generic forms off "pet-safe": that compound is
// handled by its own alternation below, with the checker/URL exclusions.
const NOT_PET_COMPOUND = String.raw`(?<!pet[-\s])`;
const POSITIVE_PREDICATE = new RegExp(
  [
    String.raw`\b${COPULA_EN}\s+${FILLER}${NOT_PET_COMPOUND}${SAFE_WORD_EN}\b`,
    String.raw`\b${NOT_PET_COMPOUND}${SAFE_WORD_EN}(?:\s+[a-z-]+){0,2}?\s+${PREP_EN}\b`,
    String.raw`\b${COPULA_EN}\s+${FILLER}${SOFT_WORD_EN}\s+${PREP_EN}\s+${DETERMINER}${PET_NOUN}\b`,
    // A prognosis with the pet as subject ("your cat should be fine after a
    // nibble", "dogs will be okay") is an all-clear about that animal too.
    String.raw`\b${PET_NOUN}\s+(?:should|will|would|'ll|is|are|was|were|be|should\s+be|will\s+be|would\s+be)\s+${FILLER}(?:fine|okay|ok|alright|all\s+right|safe)\b`,
    String.raw`\b${COPULA_ES}\s+${FILLER}${SAFE_WORD_ES}\b`,
    String.raw`\b${SAFE_WORD_ES}(?:\s+[a-z-]+){0,2}?\s+${PREP_ES}\b`,
    // "pet-safe" / "pet-friendly" carry their own noun — but not when they
    // name the checker itself ("use the pet-safe checker") or sit in a URL.
    String.raw`(?<![/\w])pet[-\s]?(?:safe|friendly)\b(?!\s*(?:checker|check|page|list|tool|lookup|search|section|guide|table))`,
  ].join('|'),
  'g'
);

// Negated danger is itself an all-clear ("non-toxic", "not poisonous", "no
// danger to cats", "no es tóxico", "sin riesgo") and needs no copula or noun:
// in a plant-care assistant these words are only ever about toxicity.
const DANGER_WORD_EN = String.raw`(?:toxic|poisonous|poison|dangerous|harmful|hazardous|a\s+(?:danger|risk|threat|hazard|problem))`;
const DANGER_WORD_ES = String.raw`(?:toxic[ao]s?|venenos[ao]s?|peligros[ao]s?|danin[ao]s?|nociv[ao]s?|un\s+(?:peligro|riesgo|problema))`;
const NEGATED_DANGER_PREDICATE = new RegExp(
  [
    // "non-toxic" — except as part of the ASPCA list's own name ("the toxic
    // and non-toxic plant list"), which the honest not-in-checker answer
    // points the user at and must not be read as an all-clear.
    String.raw`(?<!toxic\s(?:and|or)\s)\bnon[-\s]?toxic\b(?!\s+(?:plants?\s+)?(?:list|database|lookup|table|checker|page))`,
    String.raw`\bnontoxic\b(?!\s+(?:plants?\s+)?(?:list|database|lookup|table|checker|page))`,
    String.raw`\b(?:not|isn't|aren't|isnt|arent|never)\s+${FILLER}${DANGER_WORD_EN}\b`,
    String.raw`\b(?:nothing|no)\s+(?:[a-z]+\s+)?(?:toxic|poisonous|dangerous|harmful|danger|risk|threat|hazard)\b`,
    String.raw`\bwon'?t\s+(?:hurt|harm|poison)\b`,
    String.raw`\bposes?\s+no\s+(?:risk|threat|danger)\b`,
    // Likewise "lista de plantas tóxicas y no tóxicas" names the ASPCA list.
    String.raw`(?<!toxic[ao]s?\s(?:y|o)\s)\bno\s+(?:${COPULA_ES}\s+)?${FILLER}${DANGER_WORD_ES}\b`,
    String.raw`\b(?:nada|ningun[ao]?)\s+(?:[a-z]+\s+)?(?:toxic[ao]?|venenos[ao]?|peligros[ao]?|peligro|riesgo|dano)\b`,
    String.raw`\bsin\s+(?:riesgo|peligro|toxicidad)\b`,
    String.raw`\bno\s+(?:hace|hara|causa|causara)\s+dano\b`,
  ].join('|'),
  'g'
);

// A negation or hedge in the window before the predicate turns an assertion
// into its opposite or into an admission — "not safe", "unsafe" (no word
// boundary, never matches), "I can't confirm whether it's safe for cats",
// "no es seguro", "no puedo confirmar si es segura". The window runs back to
// the nearest contrastive boundary, so "pothos isn't safe, but spider plant
// is safe for cats" still checks the second clause on its own terms.
const NEGATION_PATTERN =
  /\b(?:not|never|no|cannot|neither|nor|nothing|none|unable|impossible|isnt|arent|dont|doesnt|cant|wont|couldnt|wouldnt|shouldnt|nunca|jamas|tampoco|ni|sin|nada|ningun[ao]?|imposible)\b|\w+n't\b/;
const HEDGE_PATTERN =
  /\b(?:if|whether|unless|until|unsure|uncertain|wonder(?:ing)?|question(?:able)?|hasta|incierto|insegur[ao])\b|\bsi\b(?!,)/;
const ONLY_BEFORE_PREDICATE = /\b(?:only|solo|solamente)\s+\S*$/;
const CONTRAST_BOUNDARY = /\b(?:but|however|yet|although|though|whereas|pero|sino|aunque)\b|[;:]/g;
// Clauses are the unit a claim names a plant and a species in: "calathea is
// safe for cats, unlike the ZZ plant" must be matched to calathea, not to
// whichever name in the sentence happens to be longest.
const CLAUSE_BOUNDARY =
  /[,;:()[\]—–]|\s-\s|\s+(?:but|so|though|although|unless|if|when|while|whereas|however|except|yet|pero|aunque|si|cuando|mientras|sino|excepto|salvo)\s+/;

/** A recognized categorical safety claim (reported at sentence granularity). */
interface SafetyClaim {
  sentence: string;
  /** Species the clause vouches for; both when unspecified or generic ("pets"). */
  species: PetSpecies[];
  /** The clause, normalized like evidence names, for plant-name matching. */
  normalizedClause: string;
}

function speciesIn(text: string): PetSpecies[] {
  const cats = CATS_PATTERN.test(text);
  const dogs = DOGS_PATTERN.test(text);
  if (cats && !dogs) return ['cats'];
  if (dogs && !cats) return ['dogs'];
  return ['cats', 'dogs'];
}

function isHedged(
  foldedSentence: string,
  predicateStart: number,
  predicateText: string,
  kind: 'positive' | 'negated-danger'
): boolean {
  let windowStart = 0;
  for (const boundary of foldedSentence.matchAll(CONTRAST_BOUNDARY)) {
    if (boundary.index >= predicateStart) break;
    windowStart = boundary.index + boundary[0].length;
  }
  const window = foldedSentence.slice(windowStart, predicateStart);
  // A positive predicate can carry its own negation inside the copula form
  // ("is not safe", "no es seguro"); a negated-danger predicate carries its
  // negation by construction ("not toxic"), so only the window counts there.
  const negationScope = kind === 'positive' ? `${window} ${predicateText}` : window;
  return (
    NEGATION_PATTERN.test(negationScope) ||
    HEDGE_PATTERN.test(window) ||
    ONLY_BEFORE_PREDICATE.test(`${window} ${predicateText}`.replace(/\s+/g, ' '))
  );
}

/**
 * Finds every categorical pet-safety claim in an answer. Questions ("is it
 * safe for cats?") are never claims. A positive predicate ("is safe", "safe
 * for") also needs a pet noun somewhere in the sentence; a negated-danger
 * predicate ("non-toxic") does not.
 */
function detectSafetyClaims(answerText: string): SafetyClaim[] {
  const claims: SafetyClaim[] = [];
  for (const sentence of splitSentences(answerText)) {
    if (/[?¿]/.test(sentence)) continue;
    const folded = foldText(sentence);
    const sentenceHasPetNoun = PET_NOUN_PATTERN.test(folded);
    const clauses = folded.split(CLAUSE_BOUNDARY);
    let cursor = 0;
    const found: SafetyClaim[] = [];
    for (const clause of clauses) {
      const start = folded.indexOf(clause, cursor);
      cursor = start + clause.length;
      if (!clause.trim()) continue;
      const predicates = [
        ...[...clause.matchAll(POSITIVE_PREDICATE)].map((m) => ({
          m,
          kind: 'positive' as const,
        })),
        ...[...clause.matchAll(NEGATED_DANGER_PREDICATE)].map((m) => ({
          m,
          kind: 'negated-danger' as const,
        })),
      ];
      for (const { m, kind } of predicates) {
        const needsNoun = kind === 'positive' && !/\bpet[-\s]?(?:safe|friendly)\b/.test(m[0]);
        if (needsNoun && !sentenceHasPetNoun) continue;
        if (isHedged(folded, start + m.index, m[0], kind)) continue;
        const clauseSpecies = PET_NOUN_PATTERN.test(clause) ? speciesIn(clause) : speciesIn(folded);
        found.push({
          sentence,
          species: clauseSpecies,
          normalizedClause: normalizeEvidenceName(clause),
        });
      }
    }
    claims.push(...found);
  }
  return claims;
}

/**
 * The evidence entry a clause is about: the entry whose (longest) name occurs
 * in the clause as whole words. "boston fern is safe for cats" resolves to
 * Boston fern even when the asparagus-fern entry (which shares "fern") is
 * also in evidence. Undefined when the clause names no known plant.
 */
function evidenceNamedIn(
  clause: string,
  evidence: PetSafetyEvidence[]
): PetSafetyEvidence | undefined {
  const padded = ` ${clause} `;
  let best: { entry: PetSafetyEvidence; length: number } | undefined;
  for (const entry of evidence) {
    for (const name of entry.names) {
      if (name.length < 3 || !padded.includes(` ${name} `)) continue;
      if (!best || name.length > best.length) best = { entry, length: name.length };
    }
  }
  return best?.entry;
}

function supportsSafety(entry: PetSafetyEvidence, species: PetSpecies[]): boolean {
  return species.every((s) => entry[s] === 'non-toxic');
}

/**
 * Checks every categorical pet-safety claim against the structured verdicts
 * carried on the retrieved spans. A claim is grounded only by a `non-toxic`
 * verdict for the species it vouches for, from the entry it names — or, when
 * it names none ("it's safe for your cat"), from EVERY entry in evidence.
 * Mixed evidence with an unnamed subject is therefore ungrounded: the
 * conservative reading, because the cost of the two errors is not symmetric.
 * With no evidence at all, every claim is ungrounded — that is the case this
 * check exists for.
 *
 * Exported separately from `checkGrounding` so the orchestrator can run the
 * safety dimension on an answer with NO retrieved context, where the
 * quantitative guard deliberately stays inactive (ADR 0009) but a
 * from-memory "pothos is safe for cats" must still not reach the user.
 */
export function checkSafetyClaims(
  answerText: string,
  retrievedSpans: RetrievedSpan[]
): Pick<GroundingResult, 'safetyClaimsChecked' | 'ungroundedSafetyClaims'> {
  const evidence = retrievedSpans.flatMap((span) => span.petSafety ?? []);
  const checked = new Set<string>();
  const ungrounded = new Set<string>();
  for (const claim of detectSafetyClaims(answerText)) {
    checked.add(claim.sentence);
    const named = evidenceNamedIn(claim.normalizedClause, evidence);
    const targets = named ? [named] : evidence;
    const grounded =
      targets.length > 0 && targets.every((entry) => supportsSafety(entry, claim.species));
    if (!grounded) ungrounded.add(claim.sentence);
  }
  return { safetyClaimsChecked: [...checked], ungroundedSafetyClaims: [...ungrounded] };
}

const PET_SAFETY_TOPIC_PATTERN =
  /\b(?:safe|safety|toxic\w*|poison\w*|harm\w*|danger\w*|hazard\w*|chew\w*|nibbl\w*|ate|eat\w*|eaten|swallow\w*|ingest\w*|vomit\w*|sick|segur\w*|venen\w*|peligr\w*|danin\w*|mordi\w*|mastic\w*|comi[od]\w*|comer|trag\w*|enferm\w*)\b|\bpet[-\s]?(?:safe|friendly)\b/;

/**
 * Does a USER message look like a pet-safety question? Used to hold streamed
 * output until the completed answer passes the guard — a from-memory
 * all-clear that has already streamed cannot be retracted, and the client
 * keeps streamed text over the final result. Deliberately broad: the cost of
 * a false positive is buffered delivery, not a wrong answer.
 */
export function mentionsPetSafety(text: string): boolean {
  const folded = foldText(text);
  return PET_NOUN_PATTERN.test(folded) && PET_SAFETY_TOPIC_PATTERN.test(folded);
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

  // Categorical pet-safety claims (ADR 0011) are checked against the
  // structured verdicts on the spans, never against numbers.
  const safety = checkSafetyClaims(answerText, retrievedSpans);

  // Verified requires positive evidence: something was checked, all of it
  // held, and no number was left unaccounted for. Anything else that isn't
  // an outright contradiction is "the guard cannot vouch for this answer".
  const anythingChecked = claimSentences.length > 0 || safety.safetyClaimsChecked.length > 0;
  const verdict: GroundingVerdict =
    ungroundedClaims.length > 0 || safety.ungroundedSafetyClaims.length > 0
      ? 'ungrounded'
      : anythingChecked && unclassifiedNumericSentences.length === 0
        ? 'verified'
        : 'unverified';

  return {
    verdict,
    ungroundedClaims,
    claimsChecked: claimSentences,
    unclassifiedNumericSentences,
    safetyClaimsChecked: safety.safetyClaimsChecked,
    ungroundedSafetyClaims: safety.ungroundedSafetyClaims,
  };
}

// ---------------------------------------------------------------------------
// Household count and totality claims (ADR 0026)
// ---------------------------------------------------------------------------

/**
 * The two reduced sets in a Sprout payload. Which noun a claim uses picks the
 * set it has to be answerable from, the same way an observation's `kind` does.
 */
type HouseholdSet = 'plants' | 'tasks';

/**
 * `collection` sits with the plant nouns on purpose: "nothing in your
 * collection is toxic" is a claim about the plants, and it is the phrasing an
 * all-clear most often takes.
 */
const HOUSEHOLD_NOUN: Record<HouseholdSet, string> = {
  plants: String.raw`(?:plants?|houseplants?|collections?|plantas?|coleccion(?:es)?)`,
  tasks: String.raw`(?:tasks?|chores?|reminders?|waterings?|tareas?|recordatorios?|riegos?)`,
};

/**
 * The claim has to be about THIS user's collection. Without a second-person
 * cue, "most plants prefer bright indirect light" is corpus advice about
 * plants in general, and how much of the household crossed says nothing about
 * whether it is true.
 */
const COLLECTION_CUE =
  /\b(?:your|yours|you\s+have|you'?ve|you\s+own|you\s+keep|i\s+can\s+see|i\s+see|tus?|tienes|tiene|tuy[ao]s?)\b/;

/**
 * Counting words as well as digits — "one of your plants is toxic" is the same
 * assertion as "1 of your plants is toxic". The Spanish `un`/`una` are
 * deliberately absent: they are also the indefinite article, so "una planta"
 * ("a plant") would read as a count of one.
 */
const HOUSEHOLD_COUNT = String.raw`(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)`;

/**
 * A universal quantifier makes the whole household the subject, which is the
 * same overstatement as a bare number. "None of your plants are toxic to cats"
 * is the sentence #549 was filed about.
 */
const HOUSEHOLD_TOTALITY = String.raw`(?:all|every|each|both|none|no|nothing|any|todas?|todos?|cada|ningun[ao]?|ningunos?|nada)`;

/**
 * Up to two words between the quantity and the noun ("12 toxic plants", "all
 * of your plants"), never crossing a conjunction — otherwise "water every 2
 * weeks and check your plants" would read as a count of plants.
 */
const HOUSEHOLD_FILLER = String.raw`(?:(?!(?:and|or|but|y|o|pero)\b)[a-z0-9%'-]+\s+){0,2}?`;

/**
 * The partitive "of" / "de" is free, and does not spend one of the two filler
 * words: "none of your 112 plants" has three words between the quantifier and
 * the noun, and it is the form a hedged-looking all-clear most often takes.
 */
function householdClaimPattern(quantity: string, noun: string): RegExp {
  return new RegExp(String.raw`\b${quantity}\s+(?:(?:of|de)\s+)?${HOUSEHOLD_FILLER}${noun}\b`, 'g');
}

const HOUSEHOLD_CLAIM_PATTERNS: Record<HouseholdSet, Record<'count' | 'totality', RegExp>> = {
  plants: {
    count: householdClaimPattern(HOUSEHOLD_COUNT, HOUSEHOLD_NOUN.plants),
    totality: householdClaimPattern(HOUSEHOLD_TOTALITY, HOUSEHOLD_NOUN.plants),
  },
  tasks: {
    count: householdClaimPattern(HOUSEHOLD_COUNT, HOUSEHOLD_NOUN.tasks),
    totality: householdClaimPattern(HOUSEHOLD_TOTALITY, HOUSEHOLD_NOUN.tasks),
  },
};

/**
 * A conditional is not an assertion: "if any of your plants show yellowing,
 * move them" states nothing about how many there are. The safety guard's hedge
 * vocabulary, plus the temporal conditionals that shape care advice.
 *
 * Only the text BEFORE the claim is scanned, so a hedge later in the sentence
 * ("you have 12 plants, if that helps") cannot retract a claim already made.
 * Negation is deliberately NOT a skip here, unlike `isHedged`: "none of your
 * plants" is a negation, and it is exactly the claim being caught.
 */
const HOUSEHOLD_HEDGE_PATTERN = new RegExp(
  `${HEDGE_PATTERN.source}|\\b(?:when|whenever|once|cuando|mientras)\\b`
);

export interface HouseholdClaimResult {
  /** Sentences carrying a recognized household count or totality claim. */
  householdClaimsChecked: string[];
  /**
   * Those the coverage cannot support. Each one blocks: the set it counts over
   * did not all cross, so the number is of a subset the reader was never told
   * about.
   */
  unsupportedHouseholdClaims: string[];
}

/**
 * Checks an answer's claims about the size or composition of the user's own
 * collection against how much of that collection the answering service was
 * actually given (#549, ADR 0026).
 *
 * `buildSproutContext` reduces the household twice — a canonical-species
 * privacy filter, then `SPROUT_CONTEXT_CAP` — and `coverage` reports both. A
 * count computed over what crossed is a true statement about the household
 * only when `complete` is set for that set; otherwise it is a subset presented
 * as a total, and unlike a wrong care tip a wrong count carries nothing in it
 * that could make a reader doubt it.
 *
 * Two claim shapes, one exception between them:
 *
 *   - a COUNT ("you have 12 plants") is supported when the sentence also
 *     states the household total for that set — that is what "say what the
 *     number is OF" means, and the total is ours, sent in the payload, so a
 *     denominator can only be right by having been given one;
 *   - a TOTALITY ("none of your plants are toxic") has no such exception. A
 *     denominator cannot rescue a universal claim over a set that did not all
 *     cross: "none of your 112 plants" asserts something about 112 plants when
 *     40 of them were seen.
 *
 * Bounded over-blocking, on the ADR 0011 precedent: a care generality phrased
 * as "all your plants will want more light in winter" is a totality claim
 * about the household by this test, and is blocked while coverage is partial.
 * The claim shape is what is recognizable; the intent behind it is not. Known
 * gap in the other direction: a quantifier trailing its noun ("your plants are
 * all fine") is not matched.
 */
export function checkHouseholdClaims(
  answerText: string,
  coverage: SproutCoverage
): HouseholdClaimResult {
  const checked = new Set<string>();
  const unsupported = new Set<string>();
  for (const sentence of splitSentences(answerText)) {
    if (/[?¿]/.test(sentence)) continue;
    const folded = foldText(sentence);
    if (!COLLECTION_CUE.test(folded)) continue;
    const numbers = new Set(extractNumbers(sentence));
    for (const set of ['plants', 'tasks'] as const) {
      const setCoverage = coverage[set];
      for (const kind of ['count', 'totality'] as const) {
        for (const match of folded.matchAll(HOUSEHOLD_CLAIM_PATTERNS[set][kind])) {
          if (HOUSEHOLD_HEDGE_PATTERN.test(folded.slice(0, match.index))) continue;
          checked.add(sentence);
          if (setCoverage.complete) continue;
          if (kind === 'count' && numbers.has(String(setCoverage.total))) continue;
          unsupported.add(sentence);
        }
      }
    }
  }
  return {
    householdClaimsChecked: [...checked],
    unsupportedHouseholdClaims: [...unsupported],
  };
}
