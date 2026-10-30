import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingGuidePlant,
  getPendingGuidePlant,
  guidePlant,
  registerHrefForPlant,
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
