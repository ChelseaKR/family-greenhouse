/**
 * The App Store description in `store-assets/metadata/en-US.json` must agree
 * with the build it describes and with the App Review notes (Guideline 2.3):
 * the iPhone app sells Garden and Greenhouse through In-App Purchase, so the
 * description may not say it sells nothing, it must carry Apple's renewal
 * terms and the Terms of Use link (3.1.2), and what each plan adds must be the
 * catalog's numbers (3.1.2(c)). The Google Play app still sells nothing
 * (2026-10-29 decision), and its text is left alone.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const metadata = JSON.parse(read('store-assets/metadata/en-US.json')) as {
  appStore: { description: string; keywords: string; name: string; subtitle: string };
  googlePlay: { fullDescription: string };
};
const plans = read('backend/src/models/plans.ts');
const tier = (id: string) => plans.match(new RegExp(`\\n  ${id}: \\{[\\s\\S]*?\\n  \\},`))![0];
const limit = (id: string, field: string) => tier(id).match(new RegExp(`${field}: (\\d+)`))![1];

describe('App Store description', () => {
  const description = metadata.appStore.description;

  it('no longer says the app sells nothing', () => {
    expect(description).not.toMatch(/does not sell subscriptions|collects no payment/);
    expect(description).not.toMatch(/read-only information/);
  });

  it('names In-App Purchase, the renewal terms and the Terms of Use', () => {
    expect(description).toContain('available in the app through In-App Purchase');
    expect(description).toContain(
      'A subscription renews automatically unless it is cancelled at least 24 hours before the end of the current period.'
    );
    expect(description).toContain('Terms of Use: https://familygreenhouse.net/legal/terms');
  });

  it('says what each plan adds, with the catalog’s numbers', () => {
    expect(description).toContain(
      `the free Seedling plan covers one home with up to ${limit('seedling', 'members')} people and ${limit('seedling', 'plants')} plants`
    );
    expect(description).toContain(
      `Garden is billed yearly or monthly, and adds up to ${limit('garden', 'plants')} plants, any number of people, the plant care assistant, and sitter links of up to ${limit('garden', 'sitterLinkMaxDays')} days.`
    );
    expect(description).toContain('Greenhouse is billed monthly, and adds any number of homes.');
  });

  it('does not promise identification (Garden includes none, ADR 0042)', () => {
    expect(description).not.toMatch(/identif/i);
  });

  it('never claims there is no tracking', () => {
    expect(description).not.toMatch(/no tracking|does not track/i);
  });
});

describe('Google Play description', () => {
  it('still says that app sells nothing', () => {
    expect(metadata.googlePlay.fullDescription).toContain(
      'This app does not sell subscriptions and collects no payment.'
    );
  });
});

describe('App Store keywords', () => {
  // Approved 2026-11-17 for the submission already planned for January: the
  // existing eleven words, then `water`. "Watering" is in the subtitle, and
  // the bare word was in none of the three fields Apple indexes.
  const KEYWORDS =
    'houseplant,tracker,schedule,reminder,roommate,housemate,chores,indoor,garden,sitter,journal,water';
  const keywords = metadata.appStore.keywords;

  it('is the approved list, within Apple’s 100 characters', () => {
    expect(keywords).toBe(KEYWORDS);
    expect(keywords.length).toBe(97);
    expect(keywords.length).toBeLessThanOrEqual(100);
  });

  it('adds one word and changes nothing else in the field', () => {
    const words = keywords.split(',');
    expect(words.at(-1)).toBe('water');
    expect(words.slice(0, -1).join(',')).toBe(
      'houseplant,tracker,schedule,reminder,roommate,housemate,chores,indoor,garden,sitter,journal'
    );
    expect(new Set(words).size).toBe(words.length);
    for (const word of words) expect(word, word).toBe(word.trim().toLowerCase());
  });

  it('repeats no word of the name or the subtitle, which Apple already indexes', () => {
    expect(metadata.appStore.name).toBe('Family Greenhouse: Plant Care');
    expect(metadata.appStore.subtitle).toBe('Shared watering for households');
    const indexed = `${metadata.appStore.name} ${metadata.appStore.subtitle}`
      .toLowerCase()
      .split(' ')
      .map((word) => word.replace(':', ''));
    for (const word of keywords.split(',')) expect(indexed, word).not.toContain(word);
  });

  it('is the list docs/APP-STORE.md tells the submitter to paste', () => {
    const doc = read('docs/APP-STORE.md');
    expect(doc).toContain(`\`${KEYWORDS}\` (97/100 chars)`);
  });
});
