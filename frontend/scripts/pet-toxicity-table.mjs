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
let cachedTable = null;

/**
 * Transpile and evaluate the table. With no argument it reads TABLE_PATH once
 * per process and reuses the result: the page gate needs the whole table per
 * page (to resolve similar and related plants), and transpiling it per call
 * made a 39-page check spend most of its time in the TypeScript compiler.
 */
export function loadPetToxicityTable(source) {
  if (source === undefined) {
    cachedTable ??= evaluateTable(readFileSync(TABLE_PATH, 'utf8'));
    return cachedTable;
  }
  return evaluateTable(source);
}

function evaluateTable(source) {
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
  const {
    PET_TOXICITY,
    ASPCA_ANIMAL_POISON_CONTROL_URL,
    ASPCA_PLANT_LIST_URL,
    EXTENSION_SOURCE_ORIGINS,
  } = module.exports;

  if (!Array.isArray(PET_TOXICITY) || PET_TOXICITY.length === 0) {
    throw new Error(`${TABLE_PATH} evaluated to no PET_TOXICITY entries.`);
  }
  if (typeof ASPCA_ANIMAL_POISON_CONTROL_URL !== 'string' || !ASPCA_ANIMAL_POISON_CONTROL_URL) {
    throw new Error(`${TABLE_PATH} does not export ASPCA_ANIMAL_POISON_CONTROL_URL.`);
  }
  if (typeof ASPCA_PLANT_LIST_URL !== 'string' || !ASPCA_PLANT_LIST_URL.startsWith('https://')) {
    throw new Error(`${TABLE_PATH} does not export ASPCA_PLANT_LIST_URL.`);
  }
  if (!Array.isArray(EXTENSION_SOURCE_ORIGINS) || EXTENSION_SOURCE_ORIGINS.length === 0) {
    throw new Error(`${TABLE_PATH} does not export EXTENSION_SOURCE_ORIGINS.`);
  }
  return {
    entries: PET_TOXICITY,
    aspcaOrigin: ASPCA_ANIMAL_POISON_CONTROL_URL,
    plantListUrl: ASPCA_PLANT_LIST_URL,
    extensionOrigins: [...EXTENSION_SOURCE_ORIGINS],
  };
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

/**
 * Animals a page shows only where the plant's own listing states a verdict.
 * They use claimFor() unchanged, so the same double-entry rule holds; they are
 * kept out of ANIMALS so they never decide whether a page is published, whether
 * its note shows, or whether it may carry a shop link.
 */
export const OPTIONAL_ANIMALS = ['horses'];

/** Fields of an ASPCA listing a detailed page quotes, in display order. */
export const LISTING_FIELDS = ['toxicPrinciples', 'clinicalSigns', 'listingNote'];

/** Fields of an extension source a detailed page quotes, in display order. */
export const EXTENSION_FIELDS = ['poisonSeverity', 'poisonSymptoms', 'poisonToxicPrinciple'];

const ALL_ANIMALS = [...ANIMALS, ...OPTIONAL_ANIMALS];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const squashText = (value) => String(value).replace(/\s+/g, ' ').trim();

/**
 * What a detailed page shows beyond its verdicts, derived from the table alone.
 * Must match plantSafetyDetails() in src/features/petsafe/plantSafetyPages.ts
 * (tests/unit/features/plantSafetyPages.test.ts compares them on every entry).
 *
 * A page is "detailed" only when its listing records `detailsRead`. Then:
 *   - `horses`: the horse claim, shown only when cited (claimFor rule);
 *   - `listing`: the listing's quoted fields that are non-blank text;
 *   - `extension`: the extension source, only when it is well formed and its
 *     URL sits under an allowed origin; `tags` keeps an animal only where
 *     the ASPCA claim for that animal is a cited "non-toxic";
 *   - `alternatives`: listed slugs whose own pages cite "non-toxic" for both
 *     cats and dogs; anything else is dropped;
 *   - `related`: listed slugs that are published, not this page, and not
 *     already an alternative.
 * Returns null for a page that is not detailed.
 */
export function plantDetails(entry, table) {
  const page = plantPage(entry, table.aspcaOrigin);
  const listing = listingOf(entry);
  if (
    !page.published ||
    !listing ||
    !text(listing.detailsRead) ||
    !ISO_DATE.test(listing.detailsRead)
  ) {
    return null;
  }

  const horses = claimFor(entry, 'horses', table.aspcaOrigin);
  const listingFields = LISTING_FIELDS.filter((f) => text(listing[f])).map((f) => ({
    field: f,
    value: squashText(listing[f]),
  }));

  let extension = null;
  const ext = entry.extensionSource;
  if (
    ext !== null &&
    typeof ext === 'object' &&
    ['publisher', 'title', 'database', 'read'].every((f) => text(ext[f])) &&
    typeof ext.url === 'string' &&
    /^https:\/\/\S+$/.test(ext.url) &&
    table.extensionOrigins.some(
      (origin) => ext.url.startsWith(origin) && ext.url.length > origin.length
    )
  ) {
    const tagged = ext.tagged !== null && typeof ext.tagged === 'object' ? ext.tagged : {};
    extension = {
      publisher: ext.publisher,
      title: ext.title,
      database: ext.database,
      url: ext.url,
      fields: EXTENSION_FIELDS.filter((f) => text(ext[f])).map((f) => ({
        field: f,
        value: squashText(ext[f]),
      })),
      tags: ALL_ANIMALS.filter(
        (animal) =>
          tagged[animal] === 'non-toxic' &&
          claimFor(entry, animal, table.aspcaOrigin).state === 'non-toxic'
      ),
    };
    if (extension.fields.length === 0 && extension.tags.length === 0) extension = null;
  }

  const pages = publishedPagesBySlug(table);
  const slugs = (value) => (Array.isArray(value) ? value.filter((s) => typeof s === 'string') : []);
  const alternatives = [];
  for (const slug of slugs(entry.alternatives)) {
    const target = pages.get(slug);
    if (!target || slug === entry.slug || alternatives.includes(target)) continue;
    if (ANIMALS.every((a) => target.claims[a].state === 'non-toxic')) alternatives.push(target);
  }
  const related = [];
  for (const slug of slugs(entry.related)) {
    const target = pages.get(slug);
    if (
      !target ||
      slug === entry.slug ||
      alternatives.includes(target) ||
      related.includes(target)
    ) {
      continue;
    }
    related.push(target);
  }

  return {
    horses,
    listing: listingFields,
    extension,
    alternatives,
    related,
    anyToxic: ANIMALS.some((a) => page.claims[a].state === 'toxic'),
  };
}

const pagesBySlug = new WeakMap();

/** Published pages keyed by slug, computed once per table entries array. */
export function publishedPagesBySlug(table) {
  let pages = pagesBySlug.get(table.entries);
  if (!pages) {
    pages = new Map(publishedPlantPages(table).map((p) => [p.slug, p]));
    pagesBySlug.set(table.entries, pages);
  }
  return pages;
}

/**
 * The plant's name mid-question: `sentenceName(headName(commonName))` from
 * src/features/care/plantNames.ts and plantSafetyPages.ts ("aloe vera",
 * "Christmas cactus"). Must match both.
 */
export function faqName(commonName) {
  const KEEP_CASE = new Set(['African', 'English', 'Chinese', 'Boston', 'Christmas']);
  return commonName
    .replace(/\s*\([^)]*\)\s*$/, '')
    .split(' ')
    .map((w) => (KEEP_CASE.has(w) || /^[A-Z]{2,}$/.test(w) ? w : w.toLowerCase()))
    .join(' ');
}

function fill(template, values) {
  if (typeof template !== 'string') throw new Error('FAQ catalog string is missing');
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
    if (!(name in values)) throw new Error(`FAQ placeholder {{${name}}} has no value`);
    return values[name];
  });
}

/**
 * The FAQ a detailed page prints and publishes as FAQPage, composed from the
 * table and a flattened catalog (`a.b.c` keys). One question per cited animal
 * (cats, dogs, then horses when cited), then what to do. Must match
 * plantSafetyFaq() in src/features/petsafe/plantSafetyPages.ts.
 */
export function plantFaq(entry, details, catalog, aspcaOrigin) {
  if (!details) return [];
  const name = faqName(entry.commonName);
  const listing = Object.fromEntries(details.listing.map((f) => [f.field, f.value]));
  const items = [];
  for (const animal of ALL_ANIMALS) {
    const claim = animal === 'horses' ? details.horses : claimFor(entry, animal, aspcaOrigin);
    if (claim.state === NOT_ASSESSED) continue;
    const animalWord = catalog[`plantSafetyPage.faq.animal.${animal}`];
    const lead = fill(
      catalog[
        claim.state === 'toxic'
          ? 'plantSafetyPage.faq.answerToxic'
          : 'plantSafetyPage.faq.answerNonToxic'
      ],
      { title: claim.source.title, scientificName: claim.source.scientificName, animal: animalWord }
    );
    const parts = [lead];
    if (claim.state === 'toxic' && listing.toxicPrinciples && listing.clinicalSigns) {
      parts.push(
        fill(catalog['plantSafetyPage.faq.answerDetails'], {
          principles: listing.toxicPrinciples,
          signs: listing.clinicalSigns.replace(/\.$/, ''),
        })
      );
    }
    if (claim.state === 'non-toxic' && ANIMALS.includes(animal)) {
      parts.push(catalog['plantSafetyPage.faq.answerAnyPlant']);
    }
    items.push({
      id: animal,
      question: fill(catalog['plantSafetyPage.faq.question'], { name, animal: animalWord }),
      answer: parts.join(' '),
    });
  }
  items.push({
    id: 'whatToDo',
    question: fill(catalog['plantSafetyPage.faq.whatToDoQuestion'], { name }),
    answer: catalog['plantSafetyPage.faq.whatToDoAnswer'],
  });
  return items;
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
  const {
    slug,
    commonName,
    scientificName,
    cats,
    dogs,
    note,
    aspcaListing,
    horses,
    extensionSource,
    alternatives,
    related,
  } = entry;
  // The last four are left out of the digest when absent (canonicalJson drops
  // undefined keys), so adding them to some entries moves only those pages' dates.
  const shown = {
    slug,
    commonName,
    scientificName,
    cats,
    dogs,
    note,
    aspcaListing,
    horses,
    extensionSource,
    alternatives,
    related,
  };
  return `sha256-${createHash('sha256').update(canonicalJson(shown)).digest('hex')}`;
}

/** Where the committed lastmod ledger lives. */
export const LASTMOD_LEDGER = join(
  dirname(fileURLToPath(import.meta.url)),
  'plant-pages-lastmod.json'
);
