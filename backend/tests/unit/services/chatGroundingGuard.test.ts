import { describe, it, expect } from 'vitest';
import {
  checkGrounding,
  checkSafetyClaims,
  isBlockingVerdict,
  mentionsPetSafety,
  normalizeEvidenceName,
  type RetrievedSpan,
} from '../../../src/services/chat/groundingGuard.js';
import { PET_TOXICITY, normalizeName } from '../../../src/models/petToxicity.js';

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

describe('categorical pet-safety claims (ADR 0011)', () => {
  const SPIDER: RetrievedSpan = {
    source: 'tool:check_pet_toxicity',
    text: 'Spider plant (Chlorophytum comosum): cats non-toxic; dogs non-toxic.',
    petSafety: [
      {
        names: [
          'spider plant',
          'chlorophytum comosum',
          'airplane plant',
          'ribbon plant',
          'chlorophytum',
        ],
        cats: 'non-toxic',
        dogs: 'non-toxic',
      },
    ],
  };
  const POTHOS: RetrievedSpan = {
    source: 'tool:check_pet_toxicity',
    text: 'Pothos (Epipremnum aureum): cats toxic; dogs toxic.',
    petSafety: [
      {
        names: ['pothos', 'epipremnum aureum', 'devils ivy', 'golden pothos', 'money plant'],
        cats: 'toxic',
        dogs: 'toxic',
      },
    ],
  };
  const NOT_IN_CHECKER: RetrievedSpan = {
    source: 'tool:check_pet_toxicity',
    text: 'No pet-toxicity verdict for "string of hearts": not in our checker.',
    petSafety: [],
  };
  const MIXED: RetrievedSpan = {
    source: 'tool:check_pet_toxicity',
    text: 'Calathea: non-toxic. ZZ plant: toxic.',
    petSafety: [
      { names: ['calathea', 'prayer plant'], cats: 'non-toxic', dogs: 'non-toxic' },
      { names: ['zz plant', 'zamioculcas', 'zz'], cats: 'toxic', dogs: 'toxic' },
    ],
  };
  const FERNS: RetrievedSpan = {
    source: 'tool:check_pet_toxicity',
    text: 'Boston fern: non-toxic. Asparagus fern: toxic.',
    petSafety: [
      { names: ['boston fern', 'sword fern', 'fern'], cats: 'non-toxic', dogs: 'non-toxic' },
      { names: ['asparagus fern', 'emerald fern'], cats: 'toxic', dogs: 'toxic' },
    ],
  };

  describe('an ungrounded safety claim is `ungrounded` and blocks — never merely `unverified`', () => {
    it.each([
      'Pothos is completely safe for cats, so there is no need to move it out of reach.',
      'Snake plants are non-toxic to dogs.',
      'String of hearts is pet-safe.',
      'There is no danger to cats from a peace lily.',
      'Your cat should be fine after a small nibble.',
      'El potus es seguro para los gatos.',
      'La sansevieria no es tóxica para perros.',
      'Es una planta apta para mascotas.',
    ])('with no evidence at all: %s', (answer) => {
      const result = checkGrounding(answer, []);

      expect(result.verdict).toBe('ungrounded');
      expect(isBlockingVerdict(result)).toBe(true);
      expect(result.safetyClaimsChecked).toEqual([answer]);
      expect(result.ungroundedSafetyClaims).toEqual([answer]);
    });

    it('with unrelated RAG spans only — the gap #388 measured as "unverified, delivered"', () => {
      const result = checkGrounding(
        'Pothos is completely safe for cats, so there is no need to move it out of reach.',
        [HUMIDITY_SPAN, FERTILIZING_SPAN]
      );

      expect(result.verdict).toBe('ungrounded');
      expect(isBlockingVerdict(result)).toBe(true);
    });

    it('when the checker had no entry — the model may not fill the gap with its own belief', () => {
      const result = checkGrounding('String of hearts is safe for cats.', [NOT_IN_CHECKER]);

      expect(result.verdict).toBe('ungrounded');
      expect(result.ungroundedSafetyClaims).toHaveLength(1);
    });

    it('when the verdict for the named plant is toxic', () => {
      expect(checkGrounding('Pothos is safe for cats.', [POTHOS]).verdict).toBe('ungrounded');
      expect(checkGrounding("Devil's ivy is harmless to cats.", [POTHOS]).verdict).toBe(
        'ungrounded'
      );
    });

    it('is per species: a dogs verdict does not ground a claim about cats, and "pets" needs both', () => {
      const dogsOnly: RetrievedSpan = {
        source: 'tool:check_pet_toxicity',
        text: '',
        petSafety: [{ names: ['example plant'], cats: 'toxic', dogs: 'non-toxic' }],
      };

      expect(checkGrounding('Example plant is safe for dogs.', [dogsOnly]).verdict).toBe(
        'verified'
      );
      expect(checkGrounding('Example plant is safe for cats.', [dogsOnly]).verdict).toBe(
        'ungrounded'
      );
      expect(checkGrounding('Example plant is pet-safe.', [dogsOnly]).verdict).toBe('ungrounded');
      expect(checkGrounding('Example plant is non-toxic.', [dogsOnly]).verdict).toBe('ungrounded');
    });

    it('"toxic to dogs but safe for cats" is still a safety claim about cats', () => {
      expect(checkGrounding('Pothos is toxic to dogs but safe for cats.', [POTHOS]).verdict).toBe(
        'ungrounded'
      );
    });

    it('an unnamed subject against mixed evidence blocks — the conservative reading', () => {
      expect(checkGrounding('It is safe for your cat.', [MIXED]).verdict).toBe('ungrounded');
    });

    it('blocks even when every quantitative claim in the same answer is supported', () => {
      const result = checkGrounding('Keep humidity at 50% or above. Calatheas are safe for cats.', [
        HUMIDITY_SPAN,
      ]);

      expect(result.claimsChecked).toHaveLength(1);
      expect(result.ungroundedClaims).toHaveLength(0);
      expect(result.ungroundedSafetyClaims).toEqual(['Calatheas are safe for cats.']);
      expect(result.verdict).toBe('ungrounded');
    });
  });

  describe('a safety claim the tool result supports verifies', () => {
    it.each([
      'Spider plant is safe for cats.',
      'Spider plants are non-toxic to cats and dogs per our checker.',
      'Chlorophytum is harmless to kittens.',
      'Spider plant is fine for cats.',
      'Yes — spider plant is pet-safe.',
      'Cats will be fine around a spider plant.',
      'La planta araña no es tóxica para gatos ni perros.',
      'Es segura para gatos.',
    ])('%s', (answer) => {
      const result = checkGrounding(answer, [SPIDER]);

      expect(result.verdict).toBe('verified');
      expect(result.safetyClaimsChecked).toEqual([answer]);
      expect(result.ungroundedSafetyClaims).toHaveLength(0);
    });

    it('matches the plant the clause names, not the longest name in the sentence', () => {
      expect(
        checkGrounding('Boston fern is safe for cats, unlike asparagus fern.', [FERNS]).verdict
      ).toBe('verified');
      expect(
        checkGrounding('Asparagus fern is safe for cats, unlike Boston fern.', [FERNS]).verdict
      ).toBe('ungrounded');
    });

    it('matches aliases through the same normalization the matcher uses', () => {
      expect(checkGrounding('Airplane plant is safe for cats.', [SPIDER]).verdict).toBe('verified');
      for (const entry of PET_TOXICITY) {
        for (const name of [entry.commonName, entry.scientificName, ...entry.aliases]) {
          expect(normalizeEvidenceName(name)).toBe(normalizeName(name));
        }
      }
    });

    it('checks each clause on its own terms against mixed evidence', () => {
      expect(
        checkGrounding('Calathea is safe for cats; the ZZ plant is not.', [MIXED]).verdict
      ).toBe('verified');
      expect(
        checkGrounding('ZZ plant is safe for cats; the calathea is too.', [MIXED]).verdict
      ).toBe('ungrounded');
    });
  });

  describe('what is NOT a categorical safety claim (over-block guards)', () => {
    it.each([
      'Is pothos safe for cats?',
      '¿Es seguro el potus para gatos?',
      "String of hearts isn't in our checker, so I can't confirm whether it's safe for cats — check the ASPCA list.",
      'I cannot confirm that it is safe for dogs.',
      'Pothos is not safe for cats.',
      'Pothos is unsafe for cats.',
      'Check the ASPCA toxic and non-toxic plant list or ask your vet.',
      'Consulta la lista de plantas tóxicas y no tóxicas de la ASPCA.',
      'No es seguro para gatos.',
      'No puedo confirmar si el potus es seguro para gatos.',
      'Pothos is toxic to cats, so keep it out of reach.',
      'Pothos is toxic to cats, so it is only safe out of reach.',
      'It is safe to repot now.',
      'Keep the fertilizer somewhere safe where the dog cannot get it.',
      'Bright indirect light is best for pothos.',
      'The soil is fine; water when the top inch is dry.',
      'Use the pet-safe checker at /pet-safe to confirm.',
      'If your cat is fine after an hour, keep watching her anyway.',
      'Do not assume your dog will be fine — call the vet.',
      'Please call your vet or the ASPCA Animal Poison Control Center (888-426-4435) right away rather than waiting to see if she is okay.',
    ])('%s', (answer) => {
      const result = checkGrounding(answer, [POTHOS]);

      expect(result.safetyClaimsChecked).toHaveLength(0);
      expect(result.ungroundedSafetyClaims).toHaveLength(0);
      expect(isBlockingVerdict(result)).toBe(false);
    });

    it('the danger direction is not gated: a false "toxic" is a scare, not a harm', () => {
      const result = checkGrounding('Spider plant is toxic to cats.', [SPIDER]);

      expect(result.safetyClaimsChecked).toHaveLength(0);
      expect(isBlockingVerdict(result)).toBe(false);
    });
  });

  describe('checkSafetyClaims stands alone for answers with no retrieved context', () => {
    it('finds and fails the from-memory all-clear', () => {
      expect(checkSafetyClaims('Pothos is safe for cats.', [])).toEqual({
        safetyClaimsChecked: ['Pothos is safe for cats.'],
        ungroundedSafetyClaims: ['Pothos is safe for cats.'],
      });
    });

    it('finds nothing in ordinary care advice', () => {
      expect(checkSafetyClaims('Water when the top inch of soil is dry.', [])).toEqual({
        safetyClaimsChecked: [],
        ungroundedSafetyClaims: [],
      });
    });
  });

  describe('mentionsPetSafety (decides whether a streamed turn is held)', () => {
    it.each([
      'Is a spider plant safe to keep around my cat?',
      '¿El potus es seguro para gatos?',
      'My dog just chewed a sago palm leaf',
      'Which houseplants are pet-friendly?',
      'Are orchids poisonous to kittens?',
    ])('holds: %s', (message) => {
      expect(mentionsPetSafety(message)).toBe(true);
    });

    it.each([
      'How often should I water my monstera?',
      'Why are the leaves on my calathea curling?',
      'Set up a reminder to water the pothos every 10 days.',
    ])('does not hold: %s', (message) => {
      expect(mentionsPetSafety(message)).toBe(false);
    });
  });
});
