import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  carriedGuideSlug,
  clearPendingGuidePlant,
  getPendingGuidePlant,
  getPendingGuideSlug,
  guidePlant,
  registerHrefForGuide,
  registerHrefForPlant,
  setPendingGuidePlant,
} from '@/features/onboarding/guidePlantHandoff';
import { CARE_GUIDES } from '@/features/care/careGuides';
import { COMMON_PLANTS } from '@/features/onboarding/commonPlants';
import { GUIDE_HANDOFF_PLANTS } from '@/features/onboarding/guideHandoffPlants';

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('guidePlantHandoff', () => {
  it('knows every first-run plant and nothing else', () => {
    for (const plant of COMMON_PLANTS) expect(guidePlant(plant.slug)).toBe(plant);
    for (const plant of GUIDE_HANDOFF_PLANTS) expect(guidePlant(plant.slug)).toBe(plant);
    for (const value of [
      null,
      undefined,
      '',
      'bird-of-paradise', // a real guide, but not a one-tap first-run plant
      'air-plant', // a real guide with a cited interval, held back (guideHandoffPlants.ts)
      'ZZ-PLANT',
      ' zz-plant',
      'zz-plant/../admin',
      '"><script>alert(1)</script>',
    ]) {
      expect(guidePlant(value), String(value)).toBeUndefined();
    }
  });

  it('links a first-run plant to /register?plant=<slug>, and anything else to /register', () => {
    expect(registerHrefForPlant('zz-plant')).toBe('/register?plant=zz-plant');
    expect(registerHrefForPlant('aloe-vera')).toBe('/register?plant=aloe-vera');
    expect(registerHrefForPlant('bird-of-paradise')).toBe('/register');
    expect(registerHrefForPlant('rosemary')).toBe('/register?plant=rosemary');
    expect(registerHrefForPlant('air-plant')).toBe('/register');
    expect(registerHrefForPlant('not a plant & more')).toBe('/register');
  });

  it('links every published guide to /register?plant=<slug> (IA decision D3)', () => {
    expect(CARE_GUIDES.length).toBeGreaterThanOrEqual(64);
    for (const guide of CARE_GUIDES) {
      expect(registerHrefForGuide(guide.slug), guide.slug).toBe(`/register?plant=${guide.slug}`);
      expect(carriedGuideSlug(guide.slug), guide.slug).toBe(guide.slug);
    }
    for (const value of ['not-a-guide', 'ZZ-PLANT', '"><script>', '']) {
      expect(registerHrefForGuide(value), value).toBe('/register');
      expect(carriedGuideSlug(value), value).toBeUndefined();
    }
  });

  it('keeps a guide without a cited day count for the visit, but never as a preset', () => {
    setPendingGuidePlant('bird-of-paradise');
    expect(getPendingGuideSlug()).toBe('bird-of-paradise');
    // No one-tap preset, so no interval: the first run names it instead.
    expect(getPendingGuidePlant()).toBeUndefined();
    clearPendingGuidePlant();
    expect(getPendingGuideSlug()).toBeUndefined();
  });

  it('keeps a known plant for the visit and reads it back', () => {
    setPendingGuidePlant('monstera');
    expect(getPendingGuidePlant()?.slug).toBe('monstera');
    clearPendingGuidePlant();
    expect(getPendingGuidePlant()).toBeUndefined();
  });

  it('never stores an unknown value, and ignores one stored by anything else', () => {
    setPendingGuidePlant('<b>hi</b>');
    expect(sessionStorage.getItem('fg.pendingGuidePlant')).toBeNull();
    sessionStorage.setItem('fg.pendingGuidePlant', 'javascript:alert(1)');
    expect(getPendingGuidePlant()).toBeUndefined();
    expect(getPendingGuideSlug()).toBeUndefined();
  });

  it('degrades to "no plant" when storage throws', () => {
    const refuse = () => {
      throw new Error('private mode');
    };
    vi.stubGlobal('sessionStorage', { setItem: refuse, getItem: refuse, removeItem: refuse });
    try {
      expect(() => setPendingGuidePlant('zz-plant')).not.toThrow();
      expect(getPendingGuidePlant()).toBeUndefined();
      expect(() => clearPendingGuidePlant()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
