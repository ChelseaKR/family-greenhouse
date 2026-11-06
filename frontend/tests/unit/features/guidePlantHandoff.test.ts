import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingGuidePlant,
  getPendingGuideLastWatered,
  getPendingGuidePlant,
  guidePlant,
  registerHrefForPlant,
  setPendingGuideLastWatered,
  setPendingGuidePlant,
} from '@/features/onboarding/guidePlantHandoff';
import { COMMON_PLANTS } from '@/features/onboarding/commonPlants';

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('guidePlantHandoff', () => {
  it('knows every first-run plant and nothing else', () => {
    for (const plant of COMMON_PLANTS) expect(guidePlant(plant.slug)).toBe(plant);
    for (const value of [
      null,
      undefined,
      '',
      'bird-of-paradise', // a real guide, but not a one-tap first-run plant
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
    expect(registerHrefForPlant('not a plant & more')).toBe('/register');
  });

  it('adds the care guide tool’s answer only beside a carried plant', () => {
    expect(registerHrefForPlant('zz-plant', 'week')).toBe('/register?plant=zz-plant&last=week');
    expect(registerHrefForPlant('orchid', 'unsure')).toBe('/register?plant=orchid&last=unsure');
    expect(registerHrefForPlant('bird-of-paradise', 'today')).toBe('/register');
    expect(registerHrefForPlant('zz-plant', 'yesterday' as never)).toBe('/register?plant=zz-plant');
  });

  it('keeps the tool’s answer for the visit only beside a known plant', () => {
    setPendingGuideLastWatered('bird-of-paradise', 'week');
    expect(getPendingGuideLastWatered()).toBeUndefined();
    setPendingGuideLastWatered('zz-plant', '"><script>');
    expect(getPendingGuideLastWatered()).toBeUndefined();
    setPendingGuideLastWatered('zz-plant', 'two_weeks');
    expect(getPendingGuideLastWatered()).toBe('two_weeks');
    // A tampered stored value reads back as nothing.
    sessionStorage.setItem('fg.pendingGuideLastWatered', 'often');
    expect(getPendingGuideLastWatered()).toBeUndefined();
    setPendingGuideLastWatered('zz-plant', 'today');
    clearPendingGuidePlant();
    expect(getPendingGuideLastWatered()).toBeUndefined();
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
