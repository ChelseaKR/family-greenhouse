import {
  ASPCA_POISON_CONTROL_PHONE,
  sentenceName,
  sentenceStartName,
} from '@/features/care/plantNames';

/**
 * The one place a pet-toxicity verdict from the API becomes words on screen.
 *
 * Every surface that shows a verdict from `GET /species/toxicity` or the
 * sitter brief (the /pet-safe checker card, the sitter brief, the plant
 * passport) goes through here, and every branch below is an exhaustive
 * `switch` ending in a `never` check. Two guarantees follow:
 *
 *   1. "Non-toxic" / "pet-safe" is reachable ONLY from the literal
 *      `'non-toxic'`. The checker card used to render
 *      `cats === 'toxic' ? 'Toxic' : 'Non-toxic'`, which turned any other
 *      value (a new `unknown`, a typo, `undefined`) into an all-clear.
 *   2. A value the type does not know fails to compile, and a value the
 *      server sends that the type does not know is normalized to `unknown`
 *      at the service boundary (`asPetVerdict`), so at runtime it renders
 *      "Unknown" plus the caution, never safe.
 */

export type PetVerdict = 'toxic' | 'non-toxic' | 'unknown';
export type PetAnimal = 'cats' | 'dogs';

/** What a plant's two verdicts add up to, for headings and styling. */
export type PetOutcome = 'harmful' | 'safe' | 'unknown';

/**
 * Compile-time exhaustiveness: a case missing from a `switch` makes `value`
 * not `never` and fails to compile. At runtime it is unreachable (every
 * entry point normalizes with `asPetVerdict` first); if it is ever reached it
 * returns the caller's safe-side fallback rather than throwing a page down.
 */
export function assertNever<T>(value: never, fallback: T): T {
  void value;
  return fallback;
}

/** Anything that is not exactly `toxic` or `non-toxic` is `unknown`. */
export function asPetVerdict(value: unknown): PetVerdict {
  return value === 'toxic' || value === 'non-toxic' ? value : 'unknown';
}

/**
 * Harmful if either animal is toxic; safe only if BOTH are an explicit
 * non-toxic; otherwise unknown. One unknown animal can never make a plant
 * "safe".
 */
export function petOutcome(rawCats: PetVerdict, rawDogs: PetVerdict): PetOutcome {
  const cats = asPetVerdict(rawCats);
  const dogs = asPetVerdict(rawDogs);
  if (cats === 'toxic' || dogs === 'toxic') return 'harmful';
  if (isNonToxic(cats) && isNonToxic(dogs)) return 'safe';
  return 'unknown';
}

function isNonToxic(verdict: PetVerdict): boolean {
  switch (verdict) {
    case 'non-toxic':
      return true;
    case 'toxic':
    case 'unknown':
      return false;
    default:
      return assertNever(verdict, false);
  }
}

/** Catalog key for one animal's verdict label. */
export function verdictLabelKey(raw: PetVerdict): string {
  const verdict = asPetVerdict(raw);
  switch (verdict) {
    case 'toxic':
      return 'petSafety.verdict.toxic';
    case 'non-toxic':
      return 'petSafety.verdict.nonToxic';
    case 'unknown':
      return 'petSafety.verdict.unknown';
    default:
      return assertNever(verdict, 'petSafety.verdict.unknown');
  }
}

/** The sitter brief's lower-case verdict words (`sitterBrief.verdict.*`). */
export function sitterVerdictKey(raw: PetVerdict): string {
  const verdict = asPetVerdict(raw);
  switch (verdict) {
    case 'toxic':
      return 'sitterBrief.verdict.toxic';
    case 'non-toxic':
      return 'sitterBrief.verdict.non-toxic';
    case 'unknown':
      return 'sitterBrief.verdict.unknown';
    default:
      return assertNever(verdict, 'sitterBrief.verdict.unknown');
  }
}

type Translate = (key: string, options?: Record<string, string>) => string;

/**
 * The caution for a plant with an unknown animal, or null. The English
 * catalog reads exactly as `cautionFor` in features/care/careToxicity.ts (a
 * test holds them together), so the care page, the /pet-safe directory and
 * the checker say the same thing.
 */
export function petCaution(
  t: Translate,
  commonName: string,
  rawCats: PetVerdict,
  rawDogs: PetVerdict
): string | null {
  const cats = asPetVerdict(rawCats);
  const dogs = asPetVerdict(rawDogs);
  const unknown = (['cats', 'dogs'] as const).filter(
    (animal) => (animal === 'cats' ? cats : dogs) === 'unknown'
  );
  const phone = ASPCA_POISON_CONTROL_PHONE;
  if (unknown.length === 2) {
    return t('petSafety.caution.both', { name: sentenceStartName(commonName), phone });
  }
  if (unknown.length === 1) {
    const animal: PetAnimal = unknown[0]!;
    switch (animal) {
      case 'cats':
        return t('petSafety.caution.cats', { name: sentenceName(commonName), phone });
      case 'dogs':
        return t('petSafety.caution.dogs', { name: sentenceName(commonName), phone });
      default:
        return assertNever(animal, null);
    }
  }
  return null;
}

/** A dialable link for the caution's number. */
export const ASPCA_POISON_CONTROL_TEL = `tel:+1${ASPCA_POISON_CONTROL_PHONE.replace(/-/g, '')}`;

/**
 * The one-line summary the sitter brief and the plant passport print above a
 * match. "Listed as non-toxic" is reachable only from two literal
 * `non-toxic` verdicts.
 */
export function petSummaryLine(t: Translate, cats: PetVerdict, dogs: PetVerdict): string {
  const words = { cats: t(sitterVerdictKey(cats)), dogs: t(sitterVerdictKey(dogs)) };
  const outcome = petOutcome(cats, dogs);
  switch (outcome) {
    case 'harmful':
      return t('sitterBrief.petToxic', words);
    case 'safe':
      return t('sitterBrief.petSafe');
    case 'unknown':
      return t('sitterBrief.petUnknown', words);
    default:
      return assertNever(outcome, t('sitterBrief.petUnknown', words));
  }
}
