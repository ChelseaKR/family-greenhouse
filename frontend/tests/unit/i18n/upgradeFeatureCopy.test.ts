/**
 * A locked feature with no name is a card that reads "locked.features.away_kit".
 *
 * `LockedFeature` titles itself from `locked.features.<id>`, and the i18n
 * catalog gates only compare en against es — they cannot know that a feature
 * id exists at all. So nothing stopped a new id shipping with no copy in
 * either locale, or with copy in English only. This is the missing half.
 */
import { describe, expect, it } from 'vitest';
import en from '@/i18n/locales/en/translation.json';
import es from '@/i18n/locales/es/translation.json';
import { UPGRADE_FEATURES } from '@/services/upgradeRequestService';

const catalogs = { en, es } as const;

describe('locked.features copy', () => {
  it.each(UPGRADE_FEATURES)('names %s in every locale', (feature) => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const label = (catalog.locked.features as Record<string, string | undefined>)[feature];
      expect(label, `${locale} is missing locked.features.${feature}`).toBeTruthy();
    }
  });

  it('carries no name for a feature the request vocabulary does not have', () => {
    // The other direction: dead copy for an id the server would 400 on.
    const known = new Set<string>(UPGRADE_FEATURES);
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const key of Object.keys(catalog.locked.features)) {
        expect(known.has(key), `${locale} names an unknown feature ${key}`).toBe(true);
      }
    }
  });
});
