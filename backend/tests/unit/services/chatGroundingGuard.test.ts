import { describe, it, expect } from 'vitest';
import { checkGrounding, type RetrievedSpan } from '../../../src/services/chat/groundingGuard.js';

const HUMIDITY_SPAN: RetrievedSpan = {
  source: 'humidity-tropicals.md',
  text: 'Calatheas, marantas, ctenanthes (prayer plants): 50%+ minimum, ideally 60-70%. They crisp up below 40%.',
};

const FERTILIZING_SPAN: RetrievedSpan = {
  source: 'fertilizing.md',
  text: 'Growing season (spring + summer): every 2-4 weeks at half the recommended strength.',
};

describe('checkGrounding (AIEV-12 citation/grounding guard)', () => {
  it('is vacuously grounded when the answer makes no quantitative claim', () => {
    const result = checkGrounding('Bright indirect light is best for most tropical houseplants.', [
      HUMIDITY_SPAN,
    ]);
    expect(result.grounded).toBe(true);
    expect(result.claimsChecked).toHaveLength(0);
    expect(result.ungroundedClaims).toHaveLength(0);
  });

  it('passes a claim whose number is lifted verbatim from a retrieved span', () => {
    const result = checkGrounding('Your calathea wants at least 50% humidity to stay happy.', [
      HUMIDITY_SPAN,
    ]);
    expect(result.grounded).toBe(true);
    expect(result.claimsChecked).toHaveLength(1);
  });

  it('passes a frequency claim ("every N weeks") lifted from a retrieved span', () => {
    const result = checkGrounding('Fertilize every 2-4 weeks during the growing season.', [
      FERTILIZING_SPAN,
    ]);
    expect(result.grounded).toBe(true);
  });

  it('flags a fabricated numeric claim with no support in any retrieved span', () => {
    // 92% never appears anywhere in the corpus fixture below — a model that
    // states it anyway is exactly the failure class this guard exists to
    // catch (the "missing-data-as-false-answer" bug family from #170/#171,
    // generalized from "missing" to "invented").
    const result = checkGrounding('Your fern needs 92% humidity or it will die within a day.', [
      HUMIDITY_SPAN,
    ]);
    expect(result.grounded).toBe(false);
    expect(result.ungroundedClaims).toHaveLength(1);
    expect(result.ungroundedClaims[0]).toMatch(/92%/);
  });

  it('requires every number in a claim to be supported, not merely one of them', () => {
    const result = checkGrounding(
      'Keep humidity above 50%, and raise it to 92% whenever the leaves curl.',
      [HUMIDITY_SPAN]
    );
    expect(result.grounded).toBe(false);
    expect(result.ungroundedClaims[0]).toMatch(/92%/);
  });

  it('flags a numeric claim when there are no retrieved spans at all (no data, asserted anyway)', () => {
    const result = checkGrounding('Water it every 9 days without fail.', []);
    expect(result.grounded).toBe(false);
    expect(result.ungroundedClaims).toHaveLength(1);
  });

  it('checks multiple sentences independently — one grounded, one not', () => {
    const answer =
      'Calatheas want 50% humidity or more. Also, misting once will permanently fix it for 365 days.';
    const result = checkGrounding(answer, [HUMIDITY_SPAN]);
    expect(result.claimsChecked).toHaveLength(2);
    expect(result.grounded).toBe(false);
    expect(result.ungroundedClaims).toHaveLength(1);
    expect(result.ungroundedClaims[0]).toMatch(/365 days/);
  });

  it('is scoped to numeric/quantitative claims only — a qualitative overstatement is not caught (documented limitation)', () => {
    // "the best plant ever" is an unverifiable qualitative claim; this
    // starter-version heuristic does not attempt semantic entailment (that's
    // the full RAGAS/FActScore-class check this repo has waived — see
    // docs/RESPONSIBLE-TECH-AUDITS.md).
    const result = checkGrounding('This is the best houseplant in the entire world.', []);
    expect(result.grounded).toBe(true);
  });
});
