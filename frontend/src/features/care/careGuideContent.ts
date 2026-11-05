import type { CareGuide } from './careGuides';
import type { CareGuideIndexEntry } from './careGuideIndex';
import { CARE_GUIDE_INDEX, bundledCareGuide } from './careGuideSource';

/**
 * Care-guide content for the pages that render it.
 *
 * Why this layer exists: the guides are ~230 kB of prose. Bundled, they were
 * one 53 kB (brotli) chunk shared by /care, /care/:slug and /pet-safe, so a
 * reader of one guide downloaded all of them, and the All-JS-combined budget
 * carried every word. Now the browser bundle holds only CARE_GUIDE_INDEX, and
 * a guide page gets its one guide from:
 *
 *   1. the bundle, in the dev server, the tests and the SSR prerender;
 *   2. the JSON the prerender wrote into that page's HTML, when the reader
 *      landed on the page (the case every crawler and most readers are); or
 *   3. a fetch of that prerendered HTML, when the reader navigated in from
 *      another page of the app.
 *
 * The prerendered markup itself is unchanged: the SSR build renders from (1).
 */

export { CARE_GUIDE_INDEX };
export type { CareGuideIndexEntry };

export function findCareGuideEntry(slug: string): CareGuideIndexEntry | undefined {
  return CARE_GUIDE_INDEX.find((entry) => entry.slug === slug);
}

/** `id` of the element in a prerendered /care/:slug page that carries its guide. */
export const CARE_GUIDE_DATA_ID = 'care-guide-data';

/**
 * The element the prerender writes after #root on a guide page.
 *
 * Every `<` in the JSON is written as `<`, which JSON.parse turns back
 * into `<`. The script body therefore cannot contain `</script` or `<!--`, so
 * no guide text can end the element early, and parseCareGuideData can take
 * the body as "everything up to the next `<`".
 */
export function careGuideDataElement(guide: CareGuide): string {
  const json = JSON.stringify(guide).replace(/</g, '\\u003c');
  return `<script type="application/json" id="${CARE_GUIDE_DATA_ID}" data-slug="${guide.slug}">${json}</script>`;
}

const DATA_ELEMENT = new RegExp(
  `<script type="application/json" id="${CARE_GUIDE_DATA_ID}" data-slug="([^"]*)">([^<]*)</script>`
);

/** The guide in a prerendered page's HTML, if the page carries the one asked for. */
export function parseCareGuideData(html: string, slug: string): CareGuide | undefined {
  const match = DATA_ELEMENT.exec(html);
  if (!match || match[1] !== slug) return undefined;
  return JSON.parse(match[2]!) as CareGuide;
}

function embeddedCareGuide(slug: string): CareGuide | undefined {
  if (typeof document === 'undefined') return undefined;
  const element = document.getElementById(CARE_GUIDE_DATA_ID);
  if (!element || element.dataset.slug !== slug || !element.textContent) return undefined;
  return JSON.parse(element.textContent) as CareGuide;
}

async function fetchCareGuide(slug: string): Promise<CareGuide> {
  // The prerendered page, by its file name: CloudFront, `vite preview` and
  // the native shells all serve it as a file, whatever they do for `/care/x`.
  const response = await fetch(`/care/${slug}/index.html`);
  if (!response.ok) throw new Error(`Care guide ${slug}: HTTP ${response.status}`);
  const guide = parseCareGuideData(await response.text(), slug);
  if (!guide) throw new Error(`Care guide ${slug}: the page carries no guide data`);
  return guide;
}

/**
 * A promise React's `use` reads without suspending: React checks `status`
 * and `value` on a thenable before it waits on it.
 */
function settled(guide: CareGuide): Promise<CareGuide> {
  return Object.assign(Promise.resolve(guide), { status: 'fulfilled', value: guide });
}

const resources = new Map<string, Promise<CareGuide>>();

/**
 * The full guide for a published slug, for React's `use`. One promise per
 * slug, so a re-render reads the same one. A failed fetch is forgotten, so
 * the next render (a retry, or the next visit to the page) asks again.
 */
export function careGuideResource(slug: string): Promise<CareGuide> {
  const cached = resources.get(slug);
  if (cached) return cached;

  const local = bundledCareGuide(slug) ?? embeddedCareGuide(slug);
  const resource = local ? settled(local) : fetchCareGuide(slug);
  resources.set(slug, resource);
  resource.catch(() => resources.delete(slug));
  return resource;
}

/** Test seam: forget every cached guide. */
export function resetCareGuideResources(): void {
  resources.clear();
}
