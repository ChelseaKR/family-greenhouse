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
 *      this plant's listing or the ASPCA poison-control page. The one other
 *      off-site link allowed is the optional paid shop link (ADR 0038): it
 *      must sit in the `data-plant-shop` block, point exactly where
 *      plantShopLinks.json and config/affiliateLinks.json say, carry
 *      rel="sponsored noopener" and a visible "Paid link" label, and appear
 *      only on a page whose every verdict is a cited "non-toxic".
 *   7. DETAIL. On a page whose listing records `detailsRead`
 *      (pet-toxicity-table.mjs `plantDetails()`): a horse verdict appears
 *      only where cited, under the same rule as cats and dogs; every quoted
 *      listing and extension field is the table's text, in order, beside its
 *      source; an extension "non-toxic" tag appears only where the ASPCA
 *      verdict for that animal is a cited "non-toxic"; every linked plant is
 *      named by its own entry and shown with its own cited verdicts, and an
 *      "alternative" is only a plant whose own page cites "non-toxic" for
 *      cats and dogs; the FAQ, visible and as FAQPage JSON-LD, is exactly the
 *      one plantFaq() composes from the table and catalog. On any other page
 *      none of these elements may appear.
 *   6. EMERGENCY. The page opens with one `<aside data-plant-emergency>`: no
 *      text in `<main>` comes before it, so it precedes the verdicts on every
 *      page, "Not assessed" ones included. It lists both POISON_HOTLINES in
 *      order, each a `tel:` link whose visible digits are the dialed number
 *      and whose text and fee sentence are the hotline's catalog strings. Its
 *      only links are those two; nothing in it is affiliate, sponsored or paid.
 *      `tel:` links anywhere else on the page fail.
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
  faqName,
  loadPetToxicityTable,
  plantDetails,
  plantFaq,
  plantPage,
  publishedPagesBySlug,
  publishedPlantPages,
} from './pet-toxicity-table.mjs';
import { FRONTEND_ROOT, SITE, publicRoutePaths } from './public-routes.mjs';

const DIST = join(FRONTEND_ROOT, 'dist');
const EN_CATALOG = join(FRONTEND_ROOT, 'src', 'i18n', 'locales', 'en', 'translation.json');
const AFFILIATE_CONFIG = join(FRONTEND_ROOT, 'src', 'config', 'affiliateLinks.json');
const PLANT_SHOP_LINKS = join(FRONTEND_ROOT, 'src', 'features', 'plantShop', 'plantShopLinks.json');

/** Must match MERCHANTS, IMPACT_TRACKING_LINK and affiliateHref in src/features/plantShop/plantShop.ts. */
const MERCHANTS = ['theSill', 'bloomscape'];
const IMPACT_TRACKING_LINK = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+\/c\/\d+\/\d+\/\d+$/;

/** The shop config and the checked product pages, as the build read them. */
export function loadPlantShop({
  config = JSON.parse(readFileSync(AFFILIATE_CONFIG, 'utf8')),
  links = JSON.parse(readFileSync(PLANT_SHOP_LINKS, 'utf8')).links,
} = {}) {
  return { config, links };
}

/**
 * The one shop link `slug` may carry, or null — the same answer
 * resolvePlantShopLink gives in the app: the first merchant with a valid
 * tracking link and a checked product page for this plant.
 */
export function expectedShopHref(slug, { config, links }) {
  const listed = Object.hasOwn(links, slug) ? links[slug] : [];
  for (const merchant of MERCHANTS) {
    const tracking = config[merchant];
    if (typeof tracking !== 'string' || !IMPACT_TRACKING_LINK.test(tracking)) continue;
    const entry = listed.find((e) => e.merchant === merchant);
    if (entry) return { href: `${tracking}?u=${encodeURIComponent(entry.url)}`, merchant };
  }
  return null;
}

/** Must match VERDICT_LABEL_KEY in src/features/petsafe/plantSafetyPages.ts. */
export const VERDICT_LABEL_KEY = {
  toxic: 'plantSafetyPage.verdict.toxic',
  'non-toxic': 'plantSafetyPage.verdict.nonToxic',
  [NOT_ASSESSED]: 'plantSafetyPage.verdict.notAssessed',
};

/** Wording that tells a reader a plant is safe. Only a validated verdict may carry it. */
export const SAFETY_WORDING =
  /\bnon[-\s]?toxic\b|\bnontoxic\b|\bnot\s+(?:toxic|poisonous|harmful|dangerous)\b|\bsafe(?:ly|r|st|ty)?\b|\bharmless\b|\bpet[-\s]friendly\b|\bno\s+(?:known\s+)?(?:toxicity|risk|danger)\b/i;

/**
 * The one question the head description may ask outright. The word "safe"
 * here is the searcher's own phrasing ("poisonous or safe for pets?"), asked
 * and not answered: the answer is the two verdict labels after it, which come
 * from the table. The exemption is this exact question, ending in its question
 * mark, so rewording it into a statement ("safe for pets.") fails the gate.
 */
export const HEAD_QUESTION = /\bpoisonous or safe for pets\?/gi;

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
  'plantSafetyPage.emergencyBody':
    'sends a reader to a poison hotline, their vet or an emergency clinic; names no effect',
  'plantSafetyPage.hotline.aspca': 'the name and number of the ASPCA hotline it dials',
  'plantSafetyPage.hotline.petPoisonHelpline': 'the name and number of the hotline it dials',
  'plantSafetyPage.listingField.toxicPrinciples':
    'the label of a quoted ASPCA listing field; the value beside it is the table text',
  'plantSafetyPage.extensionField.poisonSeverity':
    'the label of a quoted extension field; the value beside it is the table text',
  'plantSafetyPage.extensionField.poisonSymptoms':
    'the label of a quoted extension field; the value beside it is the table text',
  'plantSafetyPage.extensionField.poisonToxicPrinciple':
    'the label of a quoted extension field; the value beside it is the table text',
  'plantSafetyPage.listCaveat':
    'quotes the ASPCA plant list on every plant, linked beside it; names no plant',
  'plantSafetyPage.extensionCaveat':
    'says the rating is not a dose guide and sends a reader to a hotline or vet; names no effect',
};

/**
 * The emergency aside's hotlines, in order. Must match POISON_HOTLINES in
 * src/features/petsafe/plantSafetyPages.ts (a unit test compares them).
 */
export const POISON_HOTLINES = [
  {
    id: 'aspca',
    tel: 'tel:+18884264435',
    callKey: 'plantSafetyPage.hotline.aspca',
    feeKey: 'plantSafetyPage.hotlineFee.aspca',
  },
  {
    id: 'petPoisonHelpline',
    tel: 'tel:+18557647661',
    callKey: 'plantSafetyPage.hotline.petPoisonHelpline',
    feeKey: 'plantSafetyPage.hotlineFee.petPoisonHelpline',
  },
];

/** Catalog strings the emergency aside must carry besides the hotlines. */
export const EMERGENCY_KEYS = [
  'plantSafetyPage.emergencyHeading',
  'plantSafetyPage.emergencyBody',
  'plantSafetyPage.hotlinesChecked',
  'plantSafetyPage.emergencyListingNote',
];

/** Markers of a monetized link or block; none may appear inside the emergency aside. */
const MONETIZED_MARKERS = /affiliate|sponsor|paid link|commission|\?tag=|utm_|\/c\/\d+\/\d+\/\d+/i;

/** The digits a tel: href dials, without the leading +1. */
const telDigits = (href) =>
  href
    .replace(/^tel:/, '')
    .replace(/\D/g, '')
    .replace(/^1(?=\d{10}$)/, '');

/**
 * Check the emergency aside of one page's `<main>` (assertion 6). Returns
 * failure messages without the page prefix.
 */
export function checkEmergencyAside(main, window) {
  const failures = [];
  const asides = main.querySelectorAll('aside[data-plant-emergency]');
  if (asides.length !== 1) {
    failures.push(`expected one <aside data-plant-emergency>, found ${asides.length}`);
    return failures;
  }
  const aside = asides[0];

  const walker = main.ownerDocument.createTreeWalker(main, window.NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!squash(node.textContent)) continue;
    if (!aside.contains(node)) {
      failures.push(
        `the emergency aside is not first: "${squash(node.textContent).slice(0, 80)}" comes before it`
      );
    }
    break;
  }
  for (const verdict of main.querySelectorAll('[data-claim="verdict"]')) {
    if (!(aside.compareDocumentPosition(verdict) & window.Node.DOCUMENT_POSITION_FOLLOWING)) {
      failures.push('a verdict comes before the emergency aside');
    }
  }

  for (const key of EMERGENCY_KEYS) {
    if (aside.querySelectorAll(`[data-chrome="${key}"]`).length !== 1) {
      failures.push(`the emergency aside does not carry ${key} once`);
    }
  }

  const telLinks = [...aside.querySelectorAll('a[href^="tel:"]')];
  const shown = telLinks.map((a) => a.getAttribute('href'));
  const expected = POISON_HOTLINES.map((h) => h.tel);
  if (JSON.stringify(shown) !== JSON.stringify(expected)) {
    failures.push(
      `the emergency aside dials ${JSON.stringify(shown)}, expected ${JSON.stringify(expected)}`
    );
  }
  for (const hotline of POISON_HOTLINES) {
    const link = telLinks.find((a) => a.getAttribute('href') === hotline.tel);
    if (!link) continue;
    if (link.getAttribute('data-chrome') !== hotline.callKey) {
      failures.push(`the ${hotline.id} link text is not ${hotline.callKey}`);
    }
    const visible = squash(link.textContent).replace(/\D/g, '');
    if (!visible.endsWith(telDigits(hotline.tel))) {
      failures.push(
        `the ${hotline.id} link dials ${hotline.tel} but shows "${squash(link.textContent)}"`
      );
    }
    const item = link.closest('li') ?? aside;
    if (item.querySelectorAll(`[data-chrome="${hotline.feeKey}"]`).length !== 1) {
      failures.push(`the ${hotline.id} hotline has no fee sentence (${hotline.feeKey}) beside it`);
    }
  }

  for (const a of aside.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? '';
    if (!href.startsWith('tel:')) failures.push(`the emergency aside links ${href || '(no href)'}`);
  }
  for (const el of [aside, ...aside.querySelectorAll('*')]) {
    const rel = el.getAttribute('rel') ?? '';
    const attrs = [...el.attributes].map((attr) => `${attr.name}=${attr.value}`).join(' ');
    if (
      /\bsponsored\b/.test(rel) ||
      el.hasAttribute('data-plant-shop') ||
      MONETIZED_MARKERS.test(attrs)
    ) {
      failures.push(
        `the emergency aside carries a monetized element (${el.outerHTML.slice(0, 100)})`
      );
    }
  }
  const text = squash(aside.textContent);
  const monetized = text.match(MONETIZED_MARKERS);
  if (monetized) failures.push(`the emergency aside reads as monetized ("${monetized[0]}")`);

  for (const a of main.querySelectorAll('a[href^="tel:"]')) {
    if (!aside.contains(a))
      failures.push(`dials ${a.getAttribute('href')} outside the emergency aside`);
  }
  return failures;
}

const CLAIM_KINDS = new Set([
  'verdict',
  'citation',
  'note',
  'listing-field',
  'list-citation',
  'extension-field',
  'extension-tag',
  'extension-citation',
  'linked-plant',
  'linked-verdict',
  'faq-question',
  'faq-answer',
]);
/** Claim kinds that exist only on a detailed page. */
const DETAIL_CLAIMS = [...CLAIM_KINDS].filter((k) => !['verdict', 'citation', 'note'].includes(k));
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

/** Must match headName in src/features/petsafe/plantSafetyPages.ts. */
const headName = faqName;

/** What the head must say, recomposed from the table and the catalog. */
function expectedHead(entry, page, catalog) {
  const label = (animal) => catalog[VERDICT_LABEL_KEY[page.claims[animal].state]];
  return {
    title: interpolate(catalog['plantSafetyPage.metaTitle'], { name: headName(entry.commonName) }),
    description: interpolate(catalog['plantSafetyPage.metaDescription'], {
      name: headName(entry.commonName),
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

const texts = (els) => [...els].map((el) => squash(el.textContent));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Assertion 7 over one page's `<main>`. Returns failure messages without the
 * page prefix. `details` and `faq` are what the table and catalog allow
 * (plantDetails / plantFaq); null details means no detail element may appear.
 */
export function checkDetails({ main, entry, page, details, faq, catalog, table }) {
  const failures = [];
  const fail = (message) => failures.push(message);
  const label = (state) => catalog[VERDICT_LABEL_KEY[state]];
  const pages = publishedPagesBySlug(table);

  // Horses: shown only where cited, with its citation beside it.
  const horseVerdicts = main.querySelectorAll('[data-claim="verdict"][data-animal="horses"]');
  const horses = details?.horses ?? { state: NOT_ASSESSED };
  if (horses.state === NOT_ASSESSED) {
    for (const el of horseVerdicts) {
      fail(
        `${el.getAttribute('data-state') === 'non-toxic' ? 'ASSERTS SAFETY' : 'shows a verdict'} ` +
          `for horses ("${squash(el.textContent)}"), but the table cites no horse verdict for ${entry.slug}`
      );
    }
  } else if (horseVerdicts.length !== 1) {
    fail(`expected one horses verdict, found ${horseVerdicts.length}`);
  } else {
    const el = horseVerdicts[0];
    if (
      el.getAttribute('data-state') !== horses.state ||
      squash(el.textContent) !== label(horses.state)
    ) {
      fail(`shows horses as "${squash(el.textContent)}", but the table cites ${horses.state}`);
    }
    const group = el.closest('[data-claim-group="horses"]');
    const beside = group ? [...group.querySelectorAll('a[data-claim="citation"]')] : [];
    if (!beside.some((a) => a.getAttribute('href') === horses.source.url)) {
      fail(`the horses verdict has no citation beside it linking ${horses.source.url}`);
    }
  }

  if (!details) {
    for (const kind of DETAIL_CLAIMS) {
      if (main.querySelector(`[data-claim="${kind}"]`)) {
        fail(`carries data-claim="${kind}", but the table records no details for ${entry.slug}`);
      }
    }
    return failures;
  }

  // Quoted ASPCA listing fields, in order, beside the listing.
  const listingEls = main.querySelectorAll('[data-claim="listing-field"]');
  const shownListing = [...listingEls].map((el) => [
    el.getAttribute('data-listing-field'),
    squash(el.textContent),
  ]);
  if (
    !same(
      shownListing,
      details.listing.map((f) => [f.field, f.value])
    )
  ) {
    fail(`quoted listing fields ${JSON.stringify(shownListing)} are not the table's`);
  }
  if (listingEls.length > 0) {
    const section = listingEls[0].closest('section');
    const cited = section ? [...section.querySelectorAll('a[data-claim="citation"]')] : [];
    const urls = ANIMALS.map((a) => page.claims[a])
      .filter((c) => c.state !== NOT_ASSESSED)
      .map((c) => c.source.url);
    if (!urls.every((url) => cited.some((a) => a.getAttribute('href') === url))) {
      fail('the quoted listing fields have no citation beside them');
    }
  }
  const listCitations = main.querySelectorAll('[data-claim="list-citation"]');
  if (listCitations.length !== 1) {
    fail(`expected the ASPCA plant list cited once, found ${listCitations.length}`);
  } else {
    const a = listCitations[0];
    if (a.tagName !== 'A' || a.getAttribute('href') !== table.plantListUrl) {
      fail(`the plant list citation links ${a.getAttribute('href')}, not ${table.plantListUrl}`);
    }
    if (squash(a.textContent) !== squash(catalog['plantSafetyPage.listCitation'])) {
      fail(`the plant list citation reads "${squash(a.textContent)}"`);
    }
    const caveat = a.parentElement?.querySelector('[data-chrome="plantSafetyPage.listCaveat"]');
    if (!caveat) fail('the plant list citation is not beside the line it supports');
  }

  // Extension source.
  const ext = details.extension;
  const extFields = [...main.querySelectorAll('[data-claim="extension-field"]')].map((el) => [
    el.getAttribute('data-extension-field'),
    squash(el.textContent),
  ]);
  if (!same(extFields, ext ? ext.fields.map((f) => [f.field, f.value]) : [])) {
    fail(`quoted extension fields ${JSON.stringify(extFields)} are not the table's`);
  }
  for (const el of main.querySelectorAll('[data-claim="extension-tag"]')) {
    const animal = el.getAttribute('data-animal');
    const aspca = animal === 'horses' ? horses : page.claims[animal];
    if (aspca?.state !== 'non-toxic') {
      fail(
        `ASSERTS SAFETY for ${animal} from a second source ("${squash(el.textContent)}"), but the ` +
          `ASPCA verdict for ${animal} is not a cited "non-toxic"`
      );
    }
  }
  const tags = [...main.querySelectorAll('[data-claim="extension-tag"]')].map((el) => [
    el.getAttribute('data-animal'),
    el.getAttribute('data-state'),
    squash(el.textContent),
  ]);
  if (
    !same(
      tags,
      (ext?.tags ?? []).map((a) => [a, 'non-toxic', label('non-toxic')])
    )
  ) {
    fail(`extension tags ${JSON.stringify(tags)} are not the ones the table allows`);
  }
  const extCitations = main.querySelectorAll('[data-claim="extension-citation"]');
  if (!ext && extCitations.length > 0) fail('cites an extension source the table does not record');
  if (ext) {
    if (extCitations.length !== 1)
      fail(`expected the extension source cited once, found ${extCitations.length}`);
    else {
      const a = extCitations[0];
      const expected = interpolate(catalog['plantSafetyPage.extensionCitation'], {
        publisher: ext.publisher,
        title: ext.title,
        database: ext.database,
      });
      if (a.tagName !== 'A' || a.getAttribute('href') !== ext.url) {
        fail(`the extension citation links ${a.getAttribute('href')}, not ${ext.url}`);
      }
      if (squash(a.textContent) !== squash(expected)) {
        fail(`the extension citation reads "${squash(a.textContent)}", expected "${expected}"`);
      }
    }
  }

  // Linked plants: named by their own entry, with their own cited verdicts.
  const sectionSlugs = (id) =>
    [...main.querySelectorAll(`#${id}`)].flatMap((h) =>
      [...(h.closest('section')?.querySelectorAll('[data-linked-plant]') ?? [])].map((li) =>
        li.getAttribute('data-linked-plant')
      )
    );
  if (
    !same(
      sectionSlugs('plant-safety-alternatives'),
      details.alternatives.map((p) => p.slug)
    )
  ) {
    fail(
      `lists alternatives ${JSON.stringify(sectionSlugs('plant-safety-alternatives'))}; the table ` +
        `allows ${JSON.stringify(details.alternatives.map((p) => p.slug))}`
    );
  }
  if (
    !same(
      sectionSlugs('plant-safety-related'),
      details.related.map((p) => p.slug)
    )
  ) {
    fail(
      `lists related plants ${JSON.stringify(sectionSlugs('plant-safety-related'))}, not the table's`
    );
  }
  for (const li of main.querySelectorAll('[data-linked-plant]')) {
    const slug = li.getAttribute('data-linked-plant');
    const target = pages.get(slug);
    if (!target) {
      fail(`links plant "${slug}", which has no published page`);
      continue;
    }
    if (li.closest('section')?.querySelector('#plant-safety-alternatives')) {
      if (!ANIMALS.every((a) => target.claims[a].state === 'non-toxic')) {
        fail(
          `ASSERTS SAFETY by offering ${slug} as an alternative without a cited "non-toxic" for cats and dogs`
        );
      }
    }
    const links = li.querySelectorAll('[data-claim="linked-plant"]');
    if (links.length !== 1) fail(`${slug}: expected one link, found ${links.length}`);
    else {
      const a = links[0];
      if (a.getAttribute('href') !== `${PLANT_PAGE_PREFIX}${slug}`) {
        fail(`${slug}: links ${a.getAttribute('href')}`);
      }
      if (squash(a.textContent) !== squash(target.entry.commonName)) {
        fail(
          `${slug}: named "${squash(a.textContent)}", its entry says "${target.entry.commonName}"`
        );
      }
    }
    const verdicts = [...li.querySelectorAll('[data-claim="linked-verdict"]')].map((el) => [
      el.getAttribute('data-animal'),
      el.getAttribute('data-state'),
      squash(el.textContent),
    ]);
    const expected = ANIMALS.map((a) => [a, target.claims[a].state, label(target.claims[a].state)]);
    if (!same(verdicts, expected)) {
      fail(
        `${slug}: shows verdicts ${JSON.stringify(verdicts)}, its own page cites ${JSON.stringify(expected)}`
      );
    }
  }
  for (const el of main.querySelectorAll(
    '[data-claim="linked-verdict"], [data-claim="linked-plant"]'
  )) {
    if (!el.closest('[data-linked-plant]'))
      fail('a linked-plant claim sits outside a linked plant');
  }

  // FAQ.
  const questions = main.querySelectorAll('[data-claim="faq-question"]');
  const answers = main.querySelectorAll('[data-claim="faq-answer"]');
  if (
    !same(
      texts(questions),
      faq.map((i) => squash(i.question))
    )
  ) {
    fail(`FAQ questions ${JSON.stringify(texts(questions))} are not the composed ones`);
  }
  if (
    !same(
      texts(answers),
      faq.map((i) => squash(i.answer))
    )
  ) {
    fail('FAQ answers differ from the ones the table and catalog compose');
  }
  return failures;
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
  table = loadPetToxicityTable(),
  catalog = readCatalog(),
  routes = declaredRoutes().paths,
  publishedPaths = publicRoutePaths(),
  shop = loadPlantShop(),
}) {
  const page = plantPage(entry, aspcaOrigin);
  const details = plantDetails(entry, { ...table, aspcaOrigin });
  const faq = plantFaq(entry, details, catalog, aspcaOrigin);
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

  const values = {
    name: entry.commonName,
    questionName: headName(entry.commonName),
    scientificName: entry.scientificName,
  };
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
  if (details) allowedExternal.add(table.plantListUrl);
  if (details?.extension) allowedExternal.add(details.extension.url);
  const shopBlocks = main.querySelectorAll('[data-plant-shop]');
  const shopEligible = ANIMALS.every((animal) => page.claims[animal].state === 'non-toxic');
  const shopExpected = expectedShopHref(entry.slug, shop);
  if (shopBlocks.length > 0 && !shopEligible) {
    fail('carries a paid shop link, but not every verdict on the page is a cited "non-toxic"');
  }
  if (shopBlocks.length > 1) fail(`carries ${shopBlocks.length} paid shop blocks, expected one`);
  for (const block of shopBlocks) {
    if (block.getAttribute('data-plant-shop') !== entry.slug) {
      fail(`shop block is for "${block.getAttribute('data-plant-shop')}", not this plant`);
    }
    const anchors = block.querySelectorAll('a[href]');
    if (anchors.length !== 1) fail(`shop block has ${anchors.length} links, expected one`);
    if (!block.querySelector('[data-chrome="plantShop.paidLink"]')) {
      fail('shop link has no visible "Paid link" label beside it');
    }
    for (const a of anchors) {
      const rel = new Set((a.getAttribute('rel') ?? '').split(/\s+/));
      if (!rel.has('sponsored') || !rel.has('noopener')) {
        fail(`shop link rel is "${a.getAttribute('rel') ?? ''}", expected "sponsored noopener"`);
      }
      if (!shopExpected || a.getAttribute('href') !== shopExpected.href) {
        fail(`shop link points at ${a.getAttribute('href')}, not the configured product page`);
      } else if (a.getAttribute('data-chrome') !== `plantShop.buy.${shopExpected.merchant}`) {
        fail(`shop link text is not plantShop.buy.${shopExpected.merchant}`);
      }
    }
  }
  for (const a of main.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (a.closest('[data-plant-shop]')) continue; // checked above
    if (href.startsWith('/')) {
      const path = href.split(/[?#]/)[0];
      if (!matchesRoute(path, routes)) fail(`links ${href}, which no route in App.tsx matches`);
      else if (CONTENT_NAMESPACES.some((ns) => path.startsWith(ns)) && !published.has(path)) {
        fail(`links ${href}, which is not a published page`);
      }
    } else if (href.startsWith('tel:')) {
      continue; // checked by checkEmergencyAside
    } else if (!allowedExternal.has(href)) {
      fail(`links off-site to ${href}, which is neither this plant's listing nor poison control`);
    }
  }

  // 7. Detail sections.
  for (const message of checkDetails({ main, entry, page, details, faq, catalog, table })) {
    fail(message);
  }

  // 6. Emergency aside.
  for (const message of checkEmergencyAside(main, window)) fail(message);

  // 4. Head.
  const head = expectedHead(entry, page, catalog);
  for (const key of ['plantSafetyPage.metaTitle', 'plantSafetyPage.metaDescription']) {
    const safety = catalog[key]?.replace(HEAD_QUESTION, '').match(SAFETY_WORDING);
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
  const validated = new Set([
    head.title,
    head.description,
    ...faq.flatMap((item) => [item.question, item.answer]),
  ]);
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
    const expectedCited = [
      ...sources.keys(),
      ...(details?.extension ? [details.extension.url] : []),
    ];
    if (JSON.stringify(cited) !== JSON.stringify(expectedCited.sort())) {
      fail(`JSON-LD citations ${JSON.stringify(cited)} are not the page's sources`);
    }
  }
  const faqNodes = graph.filter((node) => node?.['@type'] === 'FAQPage');
  if (faq.length === 0 && faqNodes.length > 0)
    fail('JSON-LD has a FAQPage, but the page has no FAQ');
  if (faq.length > 0) {
    if (faqNodes.length !== 1) fail(`expected one FAQPage in JSON-LD, found ${faqNodes.length}`);
    else {
      const published = [faqNodes[0].mainEntity ?? []].flat().map((q) => ({
        question: q?.name,
        answer: q?.acceptedAnswer?.text,
      }));
      const expected = faq.map(({ question, answer }) => ({ question, answer }));
      if (JSON.stringify(published) !== JSON.stringify(expected)) {
        fail('JSON-LD FAQPage differs from the FAQ the table and catalog compose');
      }
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
        table,
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
