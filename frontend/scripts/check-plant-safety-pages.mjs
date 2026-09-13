#!/usr/bin/env node
/**
 * Build gate for `/pet-safe/<slug>`: every prerendered plant page says only
 * what the curated pet-toxicity table supports, and never calls a plant safe
 * for an animal the table does not positively record as safe, with a source.
 *
 * ## Why this is a gate over the built HTML
 *
 * A pet-toxicity page that is wrong can hurt an animal, and the failure that
 * matters is quiet: a template that renders "Non-toxic" for any value that is
 * not literally `toxic` looks right for every entry in today's table and turns
 * a blank field into an all-clear the day one appears. Unit tests over the
 * component prove the component. This reads the files a crawler and a worried
 * pet owner will actually be served (`dist/pet-safe/<slug>/index.html`) and
 * re-derives, from the table and the English catalog alone, what each one is
 * allowed to say. It runs at the end of `scripts/prerender.mjs`, so every
 * build that produces the pages checks them.
 *
 * ## What it asserts, per page
 *
 *   1. SAFETY. Each animal's verdict (`data-claim="verdict"`) is the state
 *      `claimFor()` in pet-toxicity-table.mjs derives from the table. A page
 *      that shows `non-toxic` where the table does not record `non-toxic`
 *      with a per-plant listing that states it is reported as asserting
 *      safety — blank fields, missing listings and disagreements included —
 *      and the label text must be the label of the state it is marked with.
 *   2. CITATION. Every published verdict, and the note, has its ASPCA listing
 *      linked beside it, with the listing's own title; no other citation
 *      appears.
 *   3. PROVENANCE. Every piece of visible text inside `<main>` sits in an
 *      element marked `data-claim`, `data-field` or `data-chrome`, and each
 *      matches its source exactly: the table's field, or the catalog string
 *      (with the table's plant name interpolated). Text with no source — a
 *      hand-typed sentence about the plant — fails. So does a catalog string
 *      that carries safety wording (only the table can call a plant safe) or
 *      toxicity wording outside the short list below.
 *   4. HEAD. The title, description, social tags and JSON-LD are recomposed
 *      from the table and catalog and compared exactly; no JSON-LD string may
 *      carry safety wording the validated title/description does not; no
 *      `Dataset`/DCAT type appears.
 *   5. LINKS. Internal links resolve to a route App.tsx declares (and, inside
 *      a content namespace, to a published page); external links go only to
 *      this plant's listing or the ASPCA poison-control page.
 *
 * And across pages: every plant the table publishes is prerendered, and no
 * page is prerendered under `/pet-safe/` for a plant it does not publish.
 *
 * Run standalone after a build: `npm run plant-pages:check --workspace frontend`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { JSDOM } from 'jsdom';

import { declaredRoutes, matchesRoute } from '../../scripts/check-app-links.mjs';
import {
  ANIMALS,
  NOT_ASSESSED,
  PLANT_PAGE_PREFIX,
  loadPetToxicityTable,
  plantPage,
  publishedPlantPages,
} from './pet-toxicity-table.mjs';
import { FRONTEND_ROOT, SITE, publicRoutePaths } from './public-routes.mjs';

const DIST = join(FRONTEND_ROOT, 'dist');
const EN_CATALOG = join(FRONTEND_ROOT, 'src', 'i18n', 'locales', 'en', 'translation.json');

/** Must match VERDICT_LABEL_KEY in src/features/petsafe/plantSafetyPages.ts. */
export const VERDICT_LABEL_KEY = {
  toxic: 'plantSafetyPage.verdict.toxic',
  'non-toxic': 'plantSafetyPage.verdict.nonToxic',
  [NOT_ASSESSED]: 'plantSafetyPage.verdict.notAssessed',
};

/** Wording that tells a reader a plant is safe. Only a validated verdict may carry it. */
export const SAFETY_WORDING =
  /\bnon[-\s]?toxic\b|\bnontoxic\b|\bnot\s+(?:toxic|poisonous|harmful|dangerous)\b|\bsafe(?:ly|r|st|ty)?\b|\bharmless\b|\bpet[-\s]friendly\b|\bno\s+(?:known\s+)?(?:toxicity|risk|danger)\b/i;

/** Wording that makes a toxicity claim in either direction. */
const TOXICITY_WORDING =
  /toxic|poison|venom|harm|danger|fatal|lethal|kidney|liver|vomit|drool|diarrh|irritat|symptom|swallow|emergenc|oxalate|saponin/i;

/**
 * Catalog keys allowed to carry TOXICITY wording, and why. None may carry
 * SAFETY wording. Adding a key here is a reviewed statement that the string
 * names no plant-specific effect.
 */
export const TOXICITY_WORDING_ALLOWED = {
  'plantSafetyPage.heading': 'the question the page answers; the plant name is interpolated',
  'plantSafetyPage.metaTitle': 'the same question, as the title',
  'plantSafetyPage.emergencyBody': 'sends a reader to their vet or poison control; names no effect',
  'plantSafetyPage.poisonControlLink': 'the name of the ASPCA service it links',
};

const CLAIM_KINDS = new Set(['verdict', 'citation', 'note']);
const FIELDS = new Set(['scientificName', 'commonName']);
const FORBIDDEN_JSONLD_TYPES = /^(?:Dataset|DataCatalog|DataDownload|DataFeed|dcat:.*)$/;
const CONTENT_NAMESPACES = ['/blog/', '/care/', '/help/', PLANT_PAGE_PREFIX];

const squash = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/** The en catalog flattened to `a.b.c` keys. */
export function readCatalog(path = EN_CATALOG) {
  const out = {};
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$comment') continue;
      const at = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'string') out[at] = value;
      else if (value && typeof value === 'object') walk(value, at);
    }
  };
  walk(JSON.parse(readFileSync(path, 'utf8')), '');
  return out;
}

function interpolate(template, values) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
    if (!(name in values)) throw new Error(`catalog placeholder {{${name}}} has no value`);
    return values[name];
  });
}

/** What the head must say, recomposed from the table and the catalog. */
function expectedHead(entry, page, catalog) {
  const label = (animal) => catalog[VERDICT_LABEL_KEY[page.claims[animal].state]];
  return {
    title: interpolate(catalog['plantSafetyPage.metaTitle'], { name: entry.commonName }),
    description: interpolate(catalog['plantSafetyPage.metaDescription'], {
      name: entry.commonName,
      scientificName: entry.scientificName,
      cats: label('cats'),
      dogs: label('dogs'),
    }),
  };
}

/** Every distinct cited source on a page, keyed by URL. */
function citedSources(page) {
  const sources = new Map();
  for (const animal of ANIMALS) {
    const claim = page.claims[animal];
    if (claim.state !== NOT_ASSESSED) sources.set(claim.source.url, claim.source);
  }
  return sources;
}

/**
 * Check one prerendered plant page. Returns a list of failures (empty = pass).
 *
 * `entry` is the table entry the page is for; `aspcaOrigin` the table's URL
 * root; `routes` the paths App.tsx declares; `publishedPaths` every public
 * route. All are injectable so the negative controls in
 * tests/unit/features/PetSafePlantPage.test.tsx can feed it a sabotaged page.
 */
export function checkPlantSafetyPageHtml({
  html,
  entry,
  aspcaOrigin,
  catalog = readCatalog(),
  routes = declaredRoutes().paths,
  publishedPaths = publicRoutePaths(),
}) {
  const page = plantPage(entry, aspcaOrigin);
  const where = page.path;
  const failures = [];
  const fail = (message) => failures.push(`${where}: ${message}`);

  const { window } = new JSDOM(html);
  const doc = window.document;
  const main = doc.querySelector('main');
  if (!main || doc.querySelectorAll('main').length !== 1) {
    fail('expected exactly one <main>');
    return failures;
  }
  const articles = main.querySelectorAll('article[data-plant-safety]');
  if (articles.length !== 1 || articles[0].getAttribute('data-plant-safety') !== entry.slug) {
    fail(`expected one <article data-plant-safety="${entry.slug}">, found ${articles.length}`);
  }

  // 3. Provenance: no text without a source.
  const walker = doc.createTreeWalker(main, window.NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = squash(node.textContent);
    if (!text) continue;
    const owner = node.parentElement?.closest('[data-claim], [data-field], [data-chrome]');
    if (!owner || !main.contains(owner)) {
      fail(
        `text that no table field or catalog string accounts for: "${text.slice(0, 160)}". ` +
          'Every line on a plant page comes from the table (data-claim / data-field) or the ' +
          'catalog (data-chrome); a sentence typed into the template is not allowed.'
      );
    }
  }
  for (const el of main.querySelectorAll('[data-claim], [data-field], [data-chrome]')) {
    if (el.parentElement?.closest('[data-claim], [data-field], [data-chrome]')) {
      fail(`a marked element is nested inside another (${el.outerHTML.slice(0, 120)})`);
    }
  }

  const values = { name: entry.commonName, scientificName: entry.scientificName };
  for (const el of main.querySelectorAll('[data-chrome]')) {
    const key = el.getAttribute('data-chrome');
    const template = catalog[key];
    if (typeof template !== 'string') {
      fail(`data-chrome="${key}" is not a string in the en catalog`);
      continue;
    }
    const safety = template.match(SAFETY_WORDING);
    if (safety) {
      fail(
        `catalog string ${key} asserts safety ("${safety[0]}") in template copy. Only a verdict ` +
          'the table records, with its listing, may say a plant is safe.'
      );
    }
    const toxicity = template.match(TOXICITY_WORDING);
    if (toxicity && !(key in TOXICITY_WORDING_ALLOWED)) {
      fail(
        `catalog string ${key} carries toxicity wording ("${toxicity[0]}") that is not a table ` +
          'claim. Plant effects come from the table note; add the key to ' +
          'TOXICITY_WORDING_ALLOWED only if it names no effect.'
      );
    }
    let expected;
    try {
      expected = interpolate(template, values);
    } catch (error) {
      fail(`${key}: ${error.message}`);
      continue;
    }
    if (squash(el.textContent) !== squash(expected)) {
      fail(
        `${key} renders "${squash(el.textContent)}", but the catalog says "${squash(expected)}"`
      );
    }
  }

  for (const el of main.querySelectorAll('[data-field]')) {
    const field = el.getAttribute('data-field');
    if (!FIELDS.has(field)) fail(`data-field="${field}" is not a field this gate knows`);
    else if (squash(el.textContent) !== squash(entry[field])) {
      fail(`${field} renders "${squash(el.textContent)}", the table says "${entry[field]}"`);
    }
  }

  for (const el of main.querySelectorAll('[data-claim]')) {
    const kind = el.getAttribute('data-claim');
    if (!CLAIM_KINDS.has(kind)) fail(`data-claim="${kind}" is not a claim kind this gate checks`);
  }

  // 1 + 2. Verdicts, each with its citation beside it.
  const sources = citedSources(page);
  for (const animal of ANIMALS) {
    const expected = page.claims[animal];
    const tableSays =
      expected.state === NOT_ASSESSED ? expected.reason : `the table records ${expected.state}`;
    const verdicts = main.querySelectorAll(`[data-claim="verdict"][data-animal="${animal}"]`);
    if (verdicts.length !== 1) {
      fail(`expected one ${animal} verdict, found ${verdicts.length}`);
      continue;
    }
    const el = verdicts[0];
    const shown = el.getAttribute('data-state');
    const text = squash(el.textContent);
    const nonToxicLabel = catalog[VERDICT_LABEL_KEY['non-toxic']];

    if ((shown === 'non-toxic' || text === nonToxicLabel) && expected.state !== 'non-toxic') {
      fail(
        `ASSERTS SAFETY for ${animal} ("${text}"), but the table does not positively record ` +
          `${entry.slug}.${animal} as non-toxic with a source: ${tableSays}.`
      );
    } else if (shown !== expected.state) {
      fail(`shows ${animal} as "${shown}", but ${tableSays}`);
    }
    const label = catalog[VERDICT_LABEL_KEY[shown]];
    if (label === undefined) fail(`${animal} verdict has an unknown data-state "${shown}"`);
    else if (text !== squash(label)) {
      fail(`${animal} verdict reads "${text}" while marked "${shown}", whose label is "${label}"`);
    }

    const group = el.closest(`[data-claim-group="${animal}"]`);
    const beside = group ? [...group.querySelectorAll('a[data-claim="citation"]')] : [];
    if (expected.state !== NOT_ASSESSED) {
      if (!beside.some((a) => a.getAttribute('href') === expected.source.url)) {
        fail(`the ${animal} verdict has no citation beside it linking ${expected.source.url}`);
      }
    } else if (beside.length > 0) {
      fail(`the ${animal} verdict is not assessed but carries a citation beside it`);
    }
  }

  for (const el of main.querySelectorAll('[data-claim="citation"]')) {
    const href = el.getAttribute('href');
    const source = sources.get(href);
    if (el.tagName !== 'A' || !source) {
      fail(`cites ${href ?? '(no href)'}, which is not a listing this page's verdicts rest on`);
      continue;
    }
    const expected = interpolate(catalog['plantSafetyPage.citation'], {
      title: source.title,
      scientificName: source.scientificName,
    });
    if (squash(el.textContent) !== squash(expected)) {
      fail(`citation for ${href} reads "${squash(el.textContent)}", expected "${expected}"`);
    }
  }

  const notes = main.querySelectorAll('[data-claim="note"]');
  if (page.showNote) {
    if (notes.length !== 1) fail(`expected the table note once, found ${notes.length}`);
    else {
      if (squash(notes[0].textContent) !== squash(entry.note)) {
        fail(`the note differs from the table: "${squash(notes[0].textContent).slice(0, 160)}"`);
      }
      const section = notes[0].closest('section');
      const cited = section ? [...section.querySelectorAll('a[data-claim="citation"]')] : [];
      if (![...sources.keys()].every((url) => cited.some((a) => a.getAttribute('href') === url))) {
        fail('the note has no citation beside it for every listing it rests on');
      }
    }
  } else if (notes.length > 0) {
    fail('shows the table note, but the table does not cite a verdict for every animal');
  }

  // 5. Links.
  const published = new Set(publishedPaths);
  const allowedExternal = new Set([...sources.keys(), aspcaOrigin]);
  for (const a of main.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (href.startsWith('/')) {
      const path = href.split(/[?#]/)[0];
      if (!matchesRoute(path, routes)) fail(`links ${href}, which no route in App.tsx matches`);
      else if (CONTENT_NAMESPACES.some((ns) => path.startsWith(ns)) && !published.has(path)) {
        fail(`links ${href}, which is not a published page`);
      }
    } else if (!allowedExternal.has(href)) {
      fail(`links off-site to ${href}, which is neither this plant's listing nor poison control`);
    }
  }

  // 4. Head.
  const head = expectedHead(entry, page, catalog);
  for (const key of ['plantSafetyPage.metaTitle', 'plantSafetyPage.metaDescription']) {
    const safety = catalog[key]?.match(SAFETY_WORDING);
    if (safety) fail(`catalog string ${key} asserts safety ("${safety[0]}") in template copy`);
  }
  const meta = (selector) => doc.querySelector(selector)?.getAttribute('content');
  const headValues = [
    ['<title>', squash(doc.querySelector('title')?.textContent), head.title],
    ['meta description', meta('meta[name="description"]'), head.description],
    ['og:title', meta('meta[property="og:title"]'), head.title],
    ['og:description', meta('meta[property="og:description"]'), head.description],
    ['twitter:title', meta('meta[name="twitter:title"]'), head.title],
    ['twitter:description', meta('meta[name="twitter:description"]'), head.description],
    [
      'canonical',
      doc.querySelector('link[rel="canonical"]')?.getAttribute('href'),
      `${SITE}${where}`,
    ],
    ['robots', meta('meta[name="robots"]'), 'index, follow'],
  ];
  for (const [label, actual, expected] of headValues) {
    if (actual !== expected) fail(`${label} is "${actual}", expected "${expected}"`);
  }

  const graph = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent);
      graph.push(...(Array.isArray(data['@graph']) ? data['@graph'] : [data]));
    } catch {
      fail('a JSON-LD block does not parse');
    }
  }
  const validated = new Set([head.title, head.description]);
  const visit = (node) => {
    if (typeof node === 'string') {
      // URLs are compared structurally below (canonical, citations); their
      // slugs — `/pet-safe/…`, ASPCA's `toxic-and-non-toxic-plants/…` — are
      // addresses, not wording a reader is told.
      if (/^https?:\/\//.test(node)) return;
      const safety = node.match(SAFETY_WORDING);
      if (safety && !validated.has(node)) {
        fail(
          `JSON-LD carries safety wording ("${safety[0]}") outside the validated title/description: "${node.slice(0, 120)}"`
        );
      }
    } else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === '@type' && [value].flat().some((t) => FORBIDDEN_JSONLD_TYPES.test(String(t)))) {
          fail(
            `JSON-LD declares @type ${value}; Dataset/DCAT markup is out of scope for these pages`
          );
        }
        visit(value);
      }
    }
  };
  visit(graph);
  const webPage = graph.find((node) => node?.['@type'] === 'WebPage');
  if (!webPage) fail('JSON-LD has no WebPage node');
  else {
    if (webPage.name !== head.title) fail('JSON-LD WebPage.name differs from the title');
    if (webPage.description !== head.description) fail('JSON-LD WebPage.description differs');
    if (webPage.url !== `${SITE}${where}`) fail('JSON-LD WebPage.url is not the canonical URL');
    if (webPage.about?.name !== entry.commonName) fail('JSON-LD WebPage.about is not this plant');
    const cited = [webPage.citation ?? []]
      .flat()
      .map((c) => c?.url)
      .sort();
    if (JSON.stringify(cited) !== JSON.stringify([...sources.keys()].sort())) {
      fail(`JSON-LD citations ${JSON.stringify(cited)} are not the page's listings`);
    }
  }

  return failures;
}

/**
 * Check every prerendered plant page in `dist`. THROWS with the full report on
 * any failure; returns the counts on success.
 */
export function checkPlantSafetyPages({ dist = DIST } = {}) {
  const table = loadPetToxicityTable();
  const catalog = readCatalog();
  const routes = declaredRoutes().paths;
  const publishedPaths = publicRoutePaths();
  const published = publishedPlantPages(table);
  const failures = [];

  const dir = join(dist, ...PLANT_PAGE_PREFIX.split('/').filter(Boolean));
  const rendered = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];
  const publishedSlugs = new Set(published.map((page) => page.slug));

  for (const page of published) {
    const file = join(dir, page.slug, 'index.html');
    if (!existsSync(file)) {
      failures.push(`${page.path}: the table publishes it, but no page was prerendered`);
      continue;
    }
    failures.push(
      ...checkPlantSafetyPageHtml({
        html: readFileSync(file, 'utf8'),
        entry: page.entry,
        aspcaOrigin: table.aspcaOrigin,
        catalog,
        routes,
        publishedPaths,
      })
    );
  }
  for (const slug of rendered) {
    if (!publishedSlugs.has(slug)) {
      failures.push(
        `${PLANT_PAGE_PREFIX}${slug}: prerendered, but the table publishes no verdict for it`
      );
    }
  }

  const combinations = published.length * ANIMALS.length;
  const notAssessed = published.reduce(
    (n, page) => n + ANIMALS.filter((a) => page.claims[a].state === NOT_ASSESSED).length,
    0
  );

  if (failures.length > 0) {
    throw new Error(
      [
        `Plant safety page check FAILED (${failures.length} problem${failures.length === 1 ? '' : 's'}):`,
        ...failures.map((f) => `  ✗ ${f}`),
      ].join('\n')
    );
  }

  const counts = {
    pages: published.length,
    tableEntries: table.entries.length,
    verdicts: combinations - notAssessed,
    notAssessed,
  };
  console.log(
    `plant safety pages: ${counts.pages} pages / ${counts.tableEntries} plants in the table; ` +
      `${counts.verdicts} cited verdicts, ${counts.notAssessed} plant×animal not assessed; ` +
      'every line traced to the table or the catalog.'
  );
  return counts;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    checkPlantSafetyPages();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
