import { COMMON_PLANTS, type CommonPlant } from './commonPlants';
import { isLastWateredBucket, type LastWateredBucket } from '@/features/care/nextWatering';

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
/**
 * The answer to the care guide tool's "When did you last water it?", when
 * the visitor answered before following its email link
 * (`/register?plant=<slug>&last=<bucket>`). Kept the same way as the plant,
 * only beside a carried plant, and only one of `LAST_WATERED_BUCKETS`, so the
 * first run can pre-select it.
 */
const LAST_KEY = 'fg.pendingGuideLastWatered';

/** The first-run plant for a slug, or undefined for anything not on the list. */
export function guidePlant(slug: string | null | undefined): CommonPlant | undefined {
  if (typeof slug !== 'string') return undefined;
  return COMMON_PLANTS.find((plant) => plant.slug === slug);
}

/**
 * Where a guide's sign-up link should point: `/register?plant=<slug>` when the
 * first run can offer that plant, otherwise plain `/register`. With the
 * tool's answer, `&last=<bucket>` follows the plant; without a carried plant
 * there is nothing for it to describe, so it is dropped.
 */
export function registerHrefForPlant(slug: string, last?: LastWateredBucket): string {
  const plant = guidePlant(slug);
  if (!plant) return '/register';
  const href = `/register?plant=${encodeURIComponent(plant.slug)}`;
  return isLastWateredBucket(last) ? `${href}&last=${last}` : href;
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

/** Keep the tool's answer for this visit, only beside a plant that was carried. */
export function setPendingGuideLastWatered(
  slug: string | null | undefined,
  last: string | null | undefined
): void {
  if (!guidePlant(slug) || !isLastWateredBucket(last)) return;
  try {
    sessionStorage.setItem(LAST_KEY, last);
  } catch {
    // Storage unavailable: the first run simply asks.
  }
}

export function getPendingGuideLastWatered(): LastWateredBucket | undefined {
  try {
    const value = sessionStorage.getItem(LAST_KEY);
    return isLastWateredBucket(value) ? value : undefined;
  } catch {
    return undefined;
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
    sessionStorage.removeItem(LAST_KEY);
  } catch {
    // no-op
  }
}
