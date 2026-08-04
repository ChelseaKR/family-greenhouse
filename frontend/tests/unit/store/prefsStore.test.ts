/**
 * Device-local UI preferences. The migration is the interesting part: dark
 * mode was removed, and any `theme` still sitting in a returning user's
 * localStorage has to be dropped rather than rehydrated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { applyDensity, usePrefsStore } from '@/store/prefsStore';

const STORAGE_KEY = 'fg.prefs';

function reset() {
  usePrefsStore.setState({
    density: 'cozy',
    language: 'en',
    welcomeSeen: false,
    dndStart: '',
    dndEnd: '',
    sharedCarePulseDismissedUntil: {},
  });
}

beforeEach(() => {
  localStorage.clear();
  reset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-density');
  await i18n.changeLanguage('en');
});

describe('usePrefsStore', () => {
  it('starts cozy, English, and un-welcomed', () => {
    const state = usePrefsStore.getState();

    expect(state.density).toBe('cozy');
    expect(state.welcomeSeen).toBe(false);
    expect(state.dndStart).toBe('');
    expect(state.sharedCarePulseDismissedUntil).toEqual({});
  });

  it('persists density changes', () => {
    usePrefsStore.getState().setDensity('compact');

    expect(usePrefsStore.getState().density).toBe('compact');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) as string)).toMatchObject({
      state: { density: 'compact' },
    });
  });

  it('switches the i18next language alongside the stored preference', () => {
    const changeLanguage = vi.spyOn(i18n, 'changeLanguage');

    usePrefsStore.getState().setLanguage('es');

    expect(changeLanguage).toHaveBeenCalledWith('es');
    expect(usePrefsStore.getState().language).toBe('es');
  });

  it('records the welcome flow and the quiet-hours window', () => {
    usePrefsStore.getState().setWelcomeSeen(true);
    usePrefsStore.getState().setDnd('22:00', '07:00');

    expect(usePrefsStore.getState()).toMatchObject({
      welcomeSeen: true,
      dndStart: '22:00',
      dndEnd: '07:00',
    });
  });

  it('keeps shared-care-pulse dismissals scoped per household', () => {
    const { dismissSharedCarePulse } = usePrefsStore.getState();

    dismissSharedCarePulse('hh-1', '2026-09-01');
    dismissSharedCarePulse('hh-2', '2026-10-01');
    dismissSharedCarePulse('hh-1', '2026-11-01');

    expect(usePrefsStore.getState().sharedCarePulseDismissedUntil).toEqual({
      'hh-1': '2026-11-01',
      'hh-2': '2026-10-01',
    });
  });
});

describe('persisted-state migration', () => {
  it('drops a stale theme preference from a v0 payload', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { theme: 'dark', density: 'compact' }, version: 0 })
    );
    vi.resetModules();

    const { usePrefsStore: migrated } = await import('@/store/prefsStore');
    await migrated.persist.rehydrate();

    const state = migrated.getState() as unknown as Record<string, unknown>;
    expect(state).not.toHaveProperty('theme');
    expect(state.density).toBe('compact');
  });

  it('leaves a payload with no theme untouched', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { density: 'compact', welcomeSeen: true }, version: 0 })
    );
    vi.resetModules();

    const { usePrefsStore: migrated } = await import('@/store/prefsStore');
    await migrated.persist.rehydrate();

    expect(migrated.getState()).toMatchObject({ density: 'compact', welcomeSeen: true });
  });
});

describe('applyDensity', () => {
  it('writes the density attribute CSS reacts to', () => {
    applyDensity('compact');
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');

    applyDensity('cozy');
    expect(document.documentElement.getAttribute('data-density')).toBe('cozy');
  });
});
