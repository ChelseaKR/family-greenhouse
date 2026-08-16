import { describe, it, expect } from 'vitest';
import {
  checkGrounding,
  isBlockingVerdict,
  type RetrievedSpan,
} from '../../../src/services/chat/groundingGuard.js';

const HUMIDITY_SPAN: RetrievedSpan = {
  source: 'humidity-tropicals.md',
  text: 'Calatheas, marantas, ctenanthes (prayer plants): 50%+ minimum, ideally 60-70%. They crisp up below 40%.',
};

const FERTILIZING_SPAN: RetrievedSpan = {
  source: 'fertilizing.md',
  text: 'Growing season (spring + summer): every 2-4 weeks at half the recommended strength.',
};

const DOSING_SPAN: RetrievedSpan = {
  source: 'fertilizing.md',
  text: [
    'For liquid concentrate, dilute to about 1 tsp per gallon of water.',
    'Use a balanced 10-10-10 or 20-20-20 fertilizer.',
    "Flush with 3-4 times the pot's volume of water.",
    'Mix one batch at a 1:4 concentrate-to-water ratio.',
  ].join(' '),
};

describe('checkGrounding (AIEV-12 citation/grounding guard)', () => {
  describe('the guard never reports a pass it did not earn (#307)', () => {
    it('reports "unverified" — not a pass — when it recognized no claim at all', () => {
      const result = checkGrounding(
        'Bright indirect light is best for most tropical houseplants.',
        [HUMIDITY_SPAN]
      );

      expect(result.claimsChecked).toHaveLength(0);
      expect(result.verdict).toBe('unverified');
      expect(result.verdict).not.toBe('verified');
      expect(result.ungroundedClaims).toHaveLength(0);
      // Delivered, because a qualitative answer is legitimate — but the guard
      // asserts nothing about it.
      expect(isBlockingVerdict(result)).toBe(false);
    });

    it('exposes no boolean that could carry a pass with zero claims checked', () => {
      const result = checkGrounding('Repot when roots circle the pot.', [HUMIDITY_SPAN]);

      // The removed `grounded` field is the defect surface itself: a boolean
      // cannot distinguish "checked and supported" from "checked nothing".
      expect(result).not.toHaveProperty('grounded');
    });

    it.each([
      ['Bright indirect light is best for most tropical houseplants.', [HUMIDITY_SPAN]],
      ['This is the best houseplant in the entire world.', []],
      ['Your calathea wants at least 50% humidity to stay happy.', [HUMIDITY_SPAN]],
      ['Keep it at exactly 92% humidity.', [HUMIDITY_SPAN]],
      ['The 7 gramophones arrived on 2026-08-09.', [HUMIDITY_SPAN]],
      ['Fertilize every 2-4 weeks. Water when the top 3 inches are dry.', [FERTILIZING_SPAN]],
    ])(
      'a "verified" verdict always has at least one checked claim behind it: %s',
      (answer, spans) => {
        const result = checkGrounding(answer, spans as RetrievedSpan[]);

        if (result.verdict === 'verified') {
          expect(result.claimsChecked.length).toBeGreaterThan(0);
          expect(result.ungroundedClaims).toHaveLength(0);
          expect(result.unclassifiedNumericSentences).toHaveLength(0);
        }
      }
    );

    it('will not call an answer verified while numeric content in it went unchecked', () => {
      // The percentage claim is supported; "3 fertilizers" fits no checkable
      // shape. The answer as a whole has not been verified, and must not be
      // reported as though it had.
      const result = checkGrounding(
        'Keep humidity at 50% or above. I compared 3 fertilizers for you.',
        [HUMIDITY_SPAN]
      );

      expect(result.claimsChecked).toHaveLength(1);
      expect(result.unclassifiedNumericSentences).toEqual(['I compared 3 fertilizers for you.']);
      expect(result.verdict).toBe('unverified');
      expect(isBlockingVerdict(result)).toBe(false);
    });

    it('reports numeric content it could not classify rather than treating it as clean', () => {
      const result = checkGrounding(
        'The 7 gramophones arrived on 2026-08-09; the visit was 8/9, and 4 timeshares were discussed.',
        []
      );

      expect(result.claimsChecked).toHaveLength(0);
      expect(result.unclassifiedNumericSentences).toHaveLength(1);
      expect(result.verdict).toBe('unverified');
    });

    it('does not count a bare list marker as unclassified numeric content', () => {
      const result = checkGrounding('Try these. 1. Move it closer to the window.', []);

      expect(result.unclassifiedNumericSentences).toHaveLength(0);
      expect(result.claimsChecked).toHaveLength(0);
      expect(result.verdict).toBe('unverified');
    });
  });

  it('verifies a claim whose number is lifted verbatim from a retrieved span', () => {
    const result = checkGrounding('Your calathea wants at least 50% humidity to stay happy.', [
      HUMIDITY_SPAN,
    ]);
    expect(result.verdict).toBe('verified');
    expect(result.claimsChecked).toHaveLength(1);
  });

  it('verifies a frequency claim ("every N weeks") lifted from a retrieved span', () => {
    const result = checkGrounding('Fertilize every 2-4 weeks during the growing season.', [
      FERTILIZING_SPAN,
    ]);
    expect(result.verdict).toBe('verified');
  });

  it.each([
    ['Dilute your fertilizer to 3 tsp per gallon for best results.', /3 tsp/],
    ['Use a 40-5-5 NPK fertilizer for flowering houseplants.', /40-5-5/],
    ['Flush the pot with 9 times its volume of water.', /9 times/],
    ['Mix 15 ml of neem oil into 1 liter of water and spray weekly.', /15 ml/],
    ['Water your monstera 5 times a week.', /5 times/],
  ])('flags the issue #307 fabricated dose/ratio example: %s', (answer, expectedClaim) => {
    const result = checkGrounding(answer, [DOSING_SPAN]);

    expect(result.verdict).toBe('ungrounded');
    expect(isBlockingVerdict(result)).toBe(true);
    expect(result.claimsChecked).toHaveLength(1);
    expect(result.ungroundedClaims).toHaveLength(1);
    expect(result.ungroundedClaims[0]).toMatch(expectedClaim);
  });

  it.each([
    'Dilute to 1 tsp per gallon of water.',
    "Flush with 3-4 times the pot's volume of water.",
    'Use a balanced 10-10-10 fertilizer.',
    'Mix it at a 1:4 concentrate-to-water ratio.',
  ])('accepts a supported dose or ratio claim: %s', (answer) => {
    const result = checkGrounding(answer, [DOSING_SPAN]);

    expect(result.verdict).toBe('verified');
    expect(result.claimsChecked).toHaveLength(1);
    expect(result.ungroundedClaims).toHaveLength(0);
  });

  it.each([
    ['Apply 1 teaspoon per gallon.', 'Use 1 tsp per 1 gal.'],
    ['Apply 15 millilitres per litre.', 'Use 15 ml per liter.'],
    ['Apply 2 ounces per pound.', 'Use 2 oz per lb.'],
    ['Apply 1 tablespoon/cup.', 'Use 1 tbsp per cup.'],
    ['Apply 7 ounces per gallon.', 'Use 7 fl. oz per gal.'],
  ])('canonicalizes supported numerator and denominator aliases: %s', (source, answer) => {
    const result = checkGrounding(answer, [{ source: 'dose.md', text: source }]);

    expect(result.verdict).toBe('verified');
    expect(result.claimsChecked).toHaveLength(1);
  });

  it('does not let a supported numerator ground a substituted dose denominator', () => {
    const result = checkGrounding('Dilute to 1 teaspoon per cup of water.', [DOSING_SPAN]);

    expect(result.verdict).toBe('ungrounded');
    expect(result.claimsChecked).toHaveLength(1);
    expect(result.ungroundedClaims).toEqual(['Dilute to 1 teaspoon per cup of water.']);
  });

  it('distinguishes a multi-unit denominator from an implicit one-unit denominator', () => {
    const result = checkGrounding('Dilute to 1 tsp per gallon.', [
      { source: 'dose.md', text: 'Dilute to 1 teaspoon per 2 gallons.' },
    ]);

    expect(result.verdict).toBe('ungrounded');
    expect(result.claimsChecked).toHaveLength(1);
  });

  describe('word-quantity dose claims (no digit, still a dilution instruction)', () => {
    it.each([
      'Feed at half strength during the growing season.',
      'Feed at half the recommended strength.',
      'Feed at half-strength during the growing season.',
    ])('verifies a word-quantity dose the corpus actually gives: %s', (answer) => {
      const result = checkGrounding(answer, [FERTILIZING_SPAN]);

      expect(result.claimsChecked).toHaveLength(1);
      expect(result.verdict).toBe('verified');
    });

    it.each([
      'Feed at double strength during the growing season.',
      'Feed at twice the recommended strength.',
      'Use a full-strength dilution every week.',
    ])('blocks a word-quantity dose the corpus never gives: %s', (answer) => {
      const result = checkGrounding(answer, [FERTILIZING_SPAN]);

      expect(result.claimsChecked).toHaveLength(1);
      expect(result.verdict).toBe('ungrounded');
      expect(isBlockingVerdict(result)).toBe(true);
    });

    it('treats "twice" and "double" as the same instruction on both sides', () => {
      const result = checkGrounding('Mix a double concentration for hungry plants.', [
        { source: 'dose.md', text: 'Some growers mix twice the concentration for hungry plants.' },
      ]);

      expect(result.verdict).toBe('verified');
    });
  });

  it('keeps fl. oz together while splitting ordinary sentences', () => {
    const result = checkGrounding(
      'Mix gently. Apply 7 fl. oz per gallon. Stop if the leaves react.',
      []
    );

    expect(result.verdict).toBe('ungrounded');
    expect(result.claimsChecked).toEqual(['Apply 7 fl. oz per gallon.']);
    expect(result.ungroundedClaims).toEqual(['Apply 7 fl. oz per gallon.']);
  });

  it.each([
    '7 ml',
    '7 milliliters',
    '7 millilitres',
    '7 l',
    '7 liters',
    '7 litres',
    '7 oz',
    '7 ounces',
    '7 tsp',
    '7 teaspoons',
    '7 tbsp',
    '7 tablespoons',
    '7 cups',
    '7 gallons',
    '7 quarts',
    '7 g',
    '7 grams',
    '7 mg',
    '7 lb',
    '7 lbs',
    '7 pounds',
    '7 parts',
  ])('recognizes the added volume/mass/dilution unit %s', (quantity) => {
    const result = checkGrounding(`Apply ${quantity} during feeding.`, []);

    expect(result.verdict).toBe('ungrounded');
    expect(result.claimsChecked).toHaveLength(1);
  });

  it('recognizes three-part NPK ratios with an en dash and generic colon ratios', () => {
    const result = checkGrounding(
      'Use 12–4–8 NPK for growth. Mix the concentrate at 1:6 before applying it.',
      []
    );

    expect(result.verdict).toBe('ungrounded');
    expect(result.claimsChecked).toHaveLength(2);
    expect(result.ungroundedClaims).toHaveLength(2);
  });

  it('does not treat unit-name prefixes or ISO dates as quantitative care claims', () => {
    const result = checkGrounding(
      'The 7 gramophones arrived on 2026-08-09; the visit was 8/9, and 4 timeshares were discussed.',
      []
    );

    expect(result.claimsChecked).toHaveLength(0);
    // Not a claim shape — and therefore not verified either.
    expect(result.verdict).toBe('unverified');
  });

  it('flags a fabricated numeric claim with no support in any retrieved span', () => {
    // 92% never appears anywhere in the corpus fixture below — a model that
    // states it anyway is exactly the failure class this guard exists to
    // catch (the "missing-data-as-false-answer" bug family from #170/#171,
    // generalized from "missing" to "invented").
    const result = checkGrounding('Your fern needs 92% humidity or it will die within a day.', [
      HUMIDITY_SPAN,
    ]);
    expect(result.verdict).toBe('ungrounded');
    expect(result.ungroundedClaims).toHaveLength(1);
    expect(result.ungroundedClaims[0]).toMatch(/92%/);
  });

  it('requires every number in a claim to be supported, not merely one of them', () => {
    const result = checkGrounding(
      'Keep humidity above 50%, and raise it to 92% whenever the leaves curl.',
      [HUMIDITY_SPAN]
    );
    expect(result.verdict).toBe('ungrounded');
    expect(result.ungroundedClaims[0]).toMatch(/92%/);
  });

  it('flags a numeric claim when there are no retrieved spans at all (no data, asserted anyway)', () => {
    const result = checkGrounding('Water it every 9 days without fail.', []);
    expect(result.verdict).toBe('ungrounded');
    expect(result.ungroundedClaims).toHaveLength(1);
  });

  it('checks multiple sentences independently — one grounded, one not', () => {
    const answer =
      'Calatheas want 50% humidity or more. Also, misting once will permanently fix it for 365 days.';
    const result = checkGrounding(answer, [HUMIDITY_SPAN]);
    expect(result.claimsChecked).toHaveLength(2);
    expect(result.verdict).toBe('ungrounded');
    expect(result.ungroundedClaims).toHaveLength(1);
    expect(result.ungroundedClaims[0]).toMatch(/365 days/);
  });

  it('is scoped to numeric/quantitative claims only — a qualitative overstatement is not caught (documented limitation)', () => {
    // "the best plant ever" is an unverifiable qualitative claim; this
    // starter-version heuristic does not attempt semantic entailment (that's
    // the full RAGAS/FActScore-class check this repo has waived — see
    // docs/RESPONSIBLE-TECH-AUDITS.md). It is reported as unverified, which
    // is the truth: nothing about it was checked.
    const result = checkGrounding('This is the best houseplant in the entire world.', []);
    expect(result.verdict).toBe('unverified');
    expect(isBlockingVerdict(result)).toBe(false);
  });
});
