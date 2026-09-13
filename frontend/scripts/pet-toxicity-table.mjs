/**
 * The curated pet-toxicity table, as the build scripts read it, and the rule
 * that decides what a `/pet-safe/<slug>` page is allowed to claim.
 *
 * ## One table, read at build time
 *
 * `backend/src/models/petToxicity.ts` is the only toxicity source this product
 * has (ADR 0011: "a second source is how two sources drift apart"). The
 * `/pet-safe/<slug>` page imports it through Vite; the sitemap, the prerender
 * route list and the page gate read it through `loadPetToxicityTable()` below.
 * Nothing about a plant is restated in these scripts or in the page template.
 *
 * Other scripts here read TypeScript manifests with regexes, for the reason
 * `public-routes.mjs` gives. That trade is acceptable for a blog slug and not
 * for a safety verdict: a regex that silently stops matching `cats:` would
 * read as "no verdict" at best. So the file is transpiled with the TypeScript
 * compiler (types stripped, not checked; `typecheck` owns that) and evaluated
 * in an isolated context. It imports nothing, and that is asserted, because an
 * import would make this evaluation fail in a way that looks like an empty
 * table.
 *
 * ## What a page may claim
 *
 * `claimFor()` is the whole rule, and it is deliberately narrow. A verdict for
 * an animal is published only when all of these hold:
 *
 *   1. the table's field for that animal is exactly `toxic` or `non-toxic` —
 *      blank, missing or anything else is NOT ASSESSED, never "safe";
 *   2. the entry records its own ASPCA listing (`aspcaListing`) with a
 *      well-formed path — a table-wide "grounded in ASPCA" is not a source
 *      for one plant's verdict;
 *   3. that listing states a verdict for that animal; and
 *   4. the verdict it states is the table's verdict.
 *
 * Anything else renders "not assessed" for that animal. A plant with no
 * published verdict gets no page. The note, which speaks about both animals,
 * is shown only when every animal's verdict is published.
 *
 * `frontend/src/features/petsafe/plantSafetyPages.ts` implements the same rule
 * for the page itself. The duplication is the point: `check-plant-safety-pages.mjs`
 * compares what the page rendered against THIS implementation, and
 * `tests/unit/features/plantSafetyPages.test.ts` asserts the two agree on every
 * entry and on the malformed ones the table cannot currently express.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);

/** Absolute path to the curated table. Not imported from public-routes.mjs, which imports this module. */
export const TABLE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'backend',
  'src',
  'models',
  'petToxicity.ts'
);

export const ANIMALS = ['cats', 'dogs'];
export const VERDICTS = ['toxic', 'non-toxic'];
export const NOT_ASSESSED = 'not-assessed';

/** Where a published plant page lives. */
export const PLANT_PAGE_PREFIX = '/pet-safe/';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LISTING_PATH = /^\/toxic-and-non-toxic-plants\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Transpile and evaluate the table. Returns `{ entries, aspcaOrigin }`.
 *
 * THROWS on an empty or unreadable table. Twenty-nine entries parsed as zero
 * means the loader broke, and the silent version of that failure is a sitemap
 * that quietly stops advertising every plant page.
 */
export function loadPetToxicityTable(source = readFileSync(TABLE_PATH, 'utf8')) {
  const ts = require('typescript');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: 'petToxicity.ts',
  });
  if (/\brequire\(/.test(outputText)) {
    throw new Error(
      `${TABLE_PATH} now imports another module. The build scripts evaluate it in isolation; ` +
        'keep the table dependency-free, or teach loadPetToxicityTable() to resolve the import.'
    );
  }

  const module = { exports: {} };
  runInNewContext(outputText, { module, exports: module.exports }, { filename: TABLE_PATH });
  const { PET_TOXICITY, ASPCA_ANIMAL_POISON_CONTROL_URL } = module.exports;

  if (!Array.isArray(PET_TOXICITY) || PET_TOXICITY.length === 0) {
    throw new Error(`${TABLE_PATH} evaluated to no PET_TOXICITY entries.`);
  }
  if (typeof ASPCA_ANIMAL_POISON_CONTROL_URL !== 'string' || !ASPCA_ANIMAL_POISON_CONTROL_URL) {
    throw new Error(`${TABLE_PATH} does not export ASPCA_ANIMAL_POISON_CONTROL_URL.`);
  }
  return { entries: PET_TOXICITY, aspcaOrigin: ASPCA_ANIMAL_POISON_CONTROL_URL };
}

const text = (value) => typeof value === 'string' && value.trim().length > 0;

function listingOf(entry) {
  const listing = entry?.aspcaListing;
  if (listing === null || typeof listing !== 'object') return null;
  if (!text(listing.title) || !text(listing.scientificName)) return null;
  if (typeof listing.path !== 'string' || !LISTING_PATH.test(listing.path)) return null;
  if (listing.listed === null || typeof listing.listed !== 'object') return null;
  return listing;
}

/**
 * What a page may say about one animal: `{ state: 'toxic' | 'non-toxic', source }`
 * or `{ state: 'not-assessed', reason }`. See the module header for the rule.
 */
export function claimFor(entry, animal, aspcaOrigin) {
  const recorded = entry?.[animal];
  if (!VERDICTS.includes(recorded)) {
    return { state: NOT_ASSESSED, reason: `the table records ${JSON.stringify(recorded ?? null)}` };
  }
  const listing = listingOf(entry);
  if (!listing) {
    return { state: NOT_ASSESSED, reason: 'the table records no per-plant ASPCA listing' };
  }
  const listed = listing.listed[animal];
  if (listed === undefined) {
    return { state: NOT_ASSESSED, reason: `its ASPCA listing records no verdict for ${animal}` };
  }
  if (listed !== recorded) {
    return {
      state: NOT_ASSESSED,
      reason: `the table says ${recorded} but its ASPCA listing says ${JSON.stringify(listed)}`,
    };
  }
  return {
    state: recorded,
    source: {
      title: listing.title,
      scientificName: listing.scientificName,
      url: `${aspcaOrigin}${listing.path}`,
    },
  };
}

/** The page an entry would get: its claims, whether it is published, whether its note shows. */
export function plantPage(entry, aspcaOrigin) {
  const claims = Object.fromEntries(ANIMALS.map((a) => [a, claimFor(entry, a, aspcaOrigin)]));
  const cited = ANIMALS.filter((a) => claims[a].state !== NOT_ASSESSED);
  return {
    slug: entry?.slug,
    path: `${PLANT_PAGE_PREFIX}${entry?.slug}`,
    claims,
    published: typeof entry?.slug === 'string' && SLUG.test(entry.slug) && cited.length > 0,
    showNote: cited.length === ANIMALS.length && text(entry?.note),
  };
}

/** Every published page, in table order, each carrying its entry. */
export function publishedPlantPages(table = loadPetToxicityTable()) {
  return table.entries
    .map((entry) => ({ ...plantPage(entry, table.aspcaOrigin), entry }))
    .filter((page) => page.published);
}

/** JSON with object keys sorted at every depth, so a digest cannot depend on key order. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * A digest of everything the page shows from one entry. `plant-pages-lastmod.json`
 * pins each page's `<lastmod>` to this: the date moves when, and only when,
 * the digest does. Aliases are left out because the page does not show them.
 */
export function pageContentDigest(entry) {
  const { slug, commonName, scientificName, cats, dogs, note, aspcaListing } = entry;
  const shown = { slug, commonName, scientificName, cats, dogs, note, aspcaListing };
  return `sha256-${createHash('sha256').update(canonicalJson(shown)).digest('hex')}`;
}

/** Where the committed lastmod ledger lives. */
export const LASTMOD_LEDGER = join(
  dirname(fileURLToPath(import.meta.url)),
  'plant-pages-lastmod.json'
);
