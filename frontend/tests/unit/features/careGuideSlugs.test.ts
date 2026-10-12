import { describe, expect, it } from 'vitest';
import { CARE_GUIDES } from '@/features/care/careGuides';
import { CARE_GUIDE_SLUGS, hasCareGuide } from '@/features/care/careGuideSlugs';

/** The light slug list must name exactly the published guides, or links rot. */
describe('CARE_GUIDE_SLUGS', () => {
  it('matches CARE_GUIDES exactly', () => {
    expect([...CARE_GUIDE_SLUGS].sort()).toEqual(CARE_GUIDES.map((g) => g.slug).sort());
  });

  it('answers membership', () => {
    expect(hasCareGuide('pothos')).toBe(true);
    expect(hasCareGuide('lily')).toBe(false);
  });
});
