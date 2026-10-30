import { COMMON_PLANTS, type CommonPlant } from './commonPlants';

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
 * Only the first run's own plants (`COMMON_PLANTS`) can be carried, because
 * those are the plants it already knows how to add in one tap, with the
 * guide's own watering range. Any other value, including a real guide that
 * is not in that list, is ignored, both when it is read from the address and
 * when it is read back from storage. The slug itself is never shown: the
 * page shows the plant's translated name, looked up by a slug that has
 * already matched the list.
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
  return COMMON_PLANTS.find((plant) => plant.slug === slug);
}

/**
 * Where a guide's sign-up link should point: `/register?plant=<slug>` when the
 * first run can offer that plant, otherwise plain `/register`.
 */
export function registerHrefForPlant(slug: string): string {
  const plant = guidePlant(slug);
  return plant ? `/register?plant=${encodeURIComponent(plant.slug)}` : '/register';
}

export function setPendingGuidePlant(slug: string | null | undefined): void {
  const plant = guidePlant(slug);
  if (!plant) return;
  try {
    sessionStorage.setItem(KEY, plant.slug);
  } catch {
    // Storage unavailable: the plant simply isn't offered first.
  }
}

export function getPendingGuidePlant(): CommonPlant | undefined {
  try {
    return guidePlant(sessionStorage.getItem(KEY));
  } catch {
    return undefined;
  }
}

export function clearPendingGuidePlant(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // no-op
  }
}
