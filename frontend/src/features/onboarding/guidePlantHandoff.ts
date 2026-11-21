import { CARE_GUIDE_SLUGS } from '@/features/care/careGuideSlugs';
import { HOLIDAY_CARE_GUIDES } from '@/features/care/holidayGuideList';
import { COMMON_PLANTS, type CommonPlant } from './commonPlants';
import { GUIDE_HANDOFF_PLANTS } from './guideHandoffPlants';

/**
 * Carrying a plant from its care guide through sign-up.
 *
 * A visitor who clicks "Get watering reminders for your ZZ plant" on
 * `/care/zz-plant` lands on `/register?plant=zz-plant`. Before this, the
 * plant was dropped there and the first run asked them to find it again
 * (2026-10-30 audit). Now the register page keeps the slug for the visit and
 * the first run offers that plant first in its one-tap list, with the same
 * defaults the list always uses. Nothing is added for them: they still tap
 * it, or pick something else, or skip.
 *
 * Two kinds of plant are carried (IA decision D3, 2026-11-21):
 *
 *  - A PRESET plant: the first run's own plants (`COMMON_PLANTS`) and the few
 *    guide plants in `GUIDE_HANDOFF_PLANTS`, whose guides give a cited day
 *    count. The first run offers it first in its one-tap list, with that
 *    count. Pet-safety pages carry only these (`registerHrefForPlant`).
 *  - Any other published care guide (`registerHrefForGuide`): the first run
 *    fills the name field of its "Something else?" form with the guide's
 *    plant and leaves the watering rhythm to the existing "Start with a
 *    watering reminder" step, a starting point the visitor chooses. No
 *    interval is guessed for a guide that cites none.
 *
 * Any other value is ignored, both when it is read from the address and when
 * it is read back from storage. The slug itself is never shown: the pages
 * show a name looked up by a slug that has already matched a list.
 *
 * sessionStorage, as `pendingReferralCode` does it and for the same reason:
 * register → confirm-email → sign-in → household drops the query string on
 * the way, and the intent belongs to this tab and this visit. Storage access
 * is guarded, so private mode or SSR means "no plant carried", never a
 * broken sign-up.
 */
const KEY = 'fg.pendingGuidePlant';

/** The first-run plant for a slug, or undefined for anything not on the list. */
export function guidePlant(slug: string | null | undefined): CommonPlant | undefined {
  if (typeof slug !== 'string') return undefined;
  return (
    COMMON_PLANTS.find((plant) => plant.slug === slug) ??
    GUIDE_HANDOFF_PLANTS.find((plant) => plant.slug === slug)
  );
}

/** A published care-guide slug, or undefined for anything else. */
export function carriedGuideSlug(slug: string | null | undefined): string | undefined {
  return typeof slug === 'string' && CARE_GUIDE_SLUGS.has(slug) ? slug : undefined;
}

/**
 * Where a PRESET plant's sign-up link should point: `/register?plant=<slug>`
 * when the first run can offer that plant in its one-tap list, otherwise
 * plain `/register`. The pet-safety pages use this.
 */
export function registerHrefForPlant(slug: string): string {
  const plant = guidePlant(slug);
  return plant ? `/register?plant=${encodeURIComponent(plant.slug)}` : '/register';
}

/**
 * Where a care guide's sign-up links point: `/register?plant=<slug>` for every
 * published guide, so the first run starts with the plant named.
 */
export function registerHrefForGuide(slug: string): string {
  const guide = carriedGuideSlug(slug);
  return guide ? `/register?plant=${encodeURIComponent(guide)}` : '/register';
}

/**
 * Catalog keys that already hold a guide plant's translated name, for the
 * guides that are not one-tap presets (whose names are
 * `firstRun.picker.plants.<slug>`). Existing data only: the holiday-guide
 * list's names and the Boston fern in the home page's app mock-up. A guide
 * with no entry is named by its English common name in every language.
 */
const GUIDE_NAME_KEYS: ReadonlyMap<string, string> = new Map<string, string>([
  ...HOLIDAY_CARE_GUIDES.map(({ slug, nameKey }) => [slug, nameKey] as [string, string]),
  ['boston-fern', 'landing.plants.bostonFern'],
]);

/** The catalog key holding a non-preset guide plant's translated name, if any. */
export function guideNameKey(slug: string): string | undefined {
  return GUIDE_NAME_KEYS.get(slug);
}

export function setPendingGuidePlant(slug: string | null | undefined): void {
  const guide = carriedGuideSlug(slug);
  if (!guide) return;
  try {
    sessionStorage.setItem(KEY, guide);
  } catch {
    // Storage unavailable: the plant simply isn't offered first.
  }
}

/** The carried guide's slug, preset or not, or undefined. */
export function getPendingGuideSlug(): string | undefined {
  try {
    return carriedGuideSlug(sessionStorage.getItem(KEY));
  } catch {
    return undefined;
  }
}

/** The carried plant when it is a PRESET one (offered in the one-tap list). */
export function getPendingGuidePlant(): CommonPlant | undefined {
  return guidePlant(getPendingGuideSlug());
}

export function clearPendingGuidePlant(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // no-op
  }
}
