import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { getVariant, useHeroVariant, HERO_EXPERIMENT } from '@/lib/experiment';
import { LandingPage } from '@/features/landing/LandingPage';

const KEY = `fg_exp_${HERO_EXPERIMENT}`;

describe('experiment bucketing', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('buckets a draw < 0.5 to A and >= 0.5 to B', () => {
    localStorage.setItem(KEY, '0.1');
    expect(getVariant(HERO_EXPERIMENT)).toBe('A');
    localStorage.setItem(KEY, '0.9');
    expect(getVariant(HERO_EXPERIMENT)).toBe('B');
  });

  it('is stable across repeated calls and persists the draw', () => {
    // No seed: the first call draws and persists; every later call must agree.
    const first = getVariant(HERO_EXPERIMENT);
    const persisted = localStorage.getItem(KEY);
    expect(persisted).not.toBeNull();
    for (let i = 0; i < 25; i++) {
      expect(getVariant(HERO_EXPERIMENT)).toBe(first);
    }
    // The persisted draw is never rewritten once set.
    expect(localStorage.getItem(KEY)).toBe(persisted);
  });

  it('ignores a corrupt stored value and re-draws a valid one', () => {
    localStorage.setItem(KEY, 'not-a-number');
    const v = getVariant(HERO_EXPERIMENT);
    expect(v === 'A' || v === 'B').toBe(true);
    const draw = Number.parseFloat(localStorage.getItem(KEY) as string);
    expect(Number.isFinite(draw)).toBe(true);
    expect(draw).toBeGreaterThanOrEqual(0);
    expect(draw).toBeLessThan(1);
  });

  it('useHeroVariant returns the persisted assignment', () => {
    localStorage.setItem(KEY, '0.8');
    let seen: string | undefined;
    function Probe() {
      seen = useHeroVariant();
      return null;
    }
    render(<Probe />);
    expect(seen).toBe('B');
  });
});

describe('LandingPage renders both hero variants', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function renderLanding() {
    return render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    );
  }

  it('renders the control (A) household hero', () => {
    localStorage.setItem(KEY, '0.2');
    renderLanding();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('I thought');
    // CTAs survive in both variants.
    expect(screen.getAllByRole('link', { name: /sign up free/i }).length).toBeGreaterThan(0);
  });

  it('renders the solo-first (B) hero', () => {
    localStorage.setItem(KEY, '0.8');
    renderLanding();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Keep');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('plant alive');
    expect(screen.getAllByRole('link', { name: /sign up free/i }).length).toBeGreaterThan(0);
  });
});
