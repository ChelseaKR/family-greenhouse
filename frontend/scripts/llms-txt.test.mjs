#!/usr/bin/env node
/**
 * /llms.txt (llmstxt.org): a file in public/, so it ships in dist/ and
 * CloudFront serves it as a file, never the SPA shell or the 404 page.
 *
 * It is generated (scripts/build-llms-txt.mjs): a hand-kept header, then one
 * line per care guide and per pet-safety page, from the data those pages
 * render. These tests hold the committed file to the generator, the lists to
 * the published routes, each pet-safety line to the ASPCA table read
 * independently of the page rule, and the "Last updated" date to the ledger.
 *
 * The prices in it are checked against PLAN_PRICES (planPrices.ts, which its
 * own test holds to the backend catalog), so a price change that forgets this
 * file fails here instead of telling assistants a stale number.
 *
 * Each negative control applies a sabotage, asserts the sabotage changed the
 * input, and then asserts the check names the fault.
 *
 * Run: `npm run test:edge`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  LLMS_HEADER,
  careGuideLine,
  contentDigest,
  dateLine,
  expectedLlmsTxt,
  llmsBody,
  loadCareGuides,
  nextLedger,
  petSafetyLine,
  readLedger,
  readPetSafetyWords,
  withDate,
} from './build-llms-txt.mjs';
import { loadPetToxicityTable, publishedPlantPages } from './pet-toxicity-table.mjs';
import { FRONTEND_ROOT, SITE, plantPageRoutes, readCareGuides } from './public-routes.mjs';

const REPO = join(FRONTEND_ROOT, '..');
const TEXT = readFileSync(join(FRONTEND_ROOT, 'public', 'llms.txt'), 'utf8');
const DEPLOYS = [
  ['scripts/deploy.sh', 'frontend/dist/llms.txt'],
  ['.github/workflows/cd-production.yml', 'dist/llms.txt'],
  ['.github/workflows/cd-staging.yml', 'dist/llms.txt'],
];

test('llms.txt follows the format: H1, summary, then link sections', () => {
  assert.match(TEXT, /^# Family Greenhouse\n\n> \S/);
  assert.match(TEXT, /\n## Pages\n/);
  for (const path of ['/pricing', '/care', '/pet-safe', '/blog', '/help']) {
    assert.ok(TEXT.includes(`(https://familygreenhouse.net${path})`), path);
  }
});

test('llms.txt has no placeholder and makes no tracking claim', () => {
  for (const bad of [
    'TO' + 'DO',
    'T' + 'BD',
    'lorem',
    'X'.repeat(3),
    '{',
    '}',
    'undefined',
    'null',
  ]) {
    assert.ok(!TEXT.includes(bad), bad);
  }
  assert.doesNotMatch(TEXT, /no tracking/i);
});

test('llms.txt prices match the plan catalog', () => {
  const source = readFileSync(
    join(FRONTEND_ROOT, 'src', 'features', 'pricing', 'planPrices.ts'),
    'utf8'
  );
  for (const name of ['Garden', 'Greenhouse']) {
    const m = source.match(new RegExp(`name: '${name}',\\s*monthly: ([0-9.]+)`));
    assert.ok(m, `${name} monthly price in planPrices.ts`);
    assert.ok(TEXT.includes(`${name} is $${m[1]} a month`), `${name} $${m[1]}`);
  }
  assert.match(source, /name: 'Seedling', monthly: 0,/);
  const annual = source.match(/name: 'Garden',\s*monthly: [0-9.]+,\s*annual: ([0-9.]+)/);
  assert.ok(annual, 'Garden annual price in planPrices.ts');
  assert.ok(TEXT.includes(`or $${annual[1]} a year`), `Garden $${annual[1]} a year`);
});

test('llms.txt states the free limits in the pricing page\u2019s own words', () => {
  const catalog = JSON.parse(
    readFileSync(join(FRONTEND_ROOT, 'src', 'i18n', 'locales', 'en', 'translation.json'), 'utf8')
  );
  const limits = 'one home, up to 2 household members and 8 plants';
  assert.ok(catalog.pricingPage.lede.open.includes(limits), 'the pricing page lede states them');
  assert.ok(TEXT.includes(limits), 'llms.txt states them');
  // Negative control: a different cap is not found in the page's sentence.
  const stale = limits.replace('8 plants', '20 plants');
  assert.notEqual(stale, limits);
  assert.ok(!catalog.pricingPage.lede.open.includes(stale));
});

test('the CloudFront router passes /llms.txt through as a file', () => {
  const sandbox = {};
  const fn = join(REPO, 'infrastructure', 'modules', 'frontend', 'functions', 'spa-router.js');
  runInNewContext(readFileSync(fn, 'utf8'), sandbox);
  assert.equal(sandbox.handler({ request: { uri: '/llms.txt' } }).uri, '/llms.txt');
});

test('every deploy uploads llms.txt as text/plain, outside the immutable tier', () => {
  for (const [file, src] of DEPLOYS) {
    const body = readFileSync(join(REPO, file), 'utf8');
    assert.match(body, /--exclude "llms\.txt"/, `${file}: excluded from the 1-year sync`);
    const cp = body.slice(body.indexOf(`aws s3 cp ${src}`));
    assert.ok(cp.length < body.length, `${file}: copies ${src}`);
    const cmd = cp.split('\n').slice(0, 3).join('\n');
    assert.match(cmd, /--content-type "text\/plain; charset=utf-8"/, `${file}: text/plain`);
    assert.match(cmd, /--cache-control "max-age=3600,public"/, `${file}: an hour`);
  }
});

// --- Generated sections -----------------------------------------------------

/** The `- [text](url): note` lines under one `## heading`, in file order. */
function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start === -1) return null;
  const rest = text.slice(start + heading.length + 5);
  const end = rest.indexOf('\n## ');
  return (end === -1 ? rest : rest.slice(0, end))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const m = line.match(/^- \[([^\]]+)\]\((https:\/\/[^)\s]+)\)(?:: (.+))?$/);
      return m ? { line, title: m[1], url: m[2], note: m[3] ?? '' } : { line, malformed: true };
    });
}

/** Every way `text` fails to list exactly `paths` under `heading`; empty means it passes. */
function listFaults(text, heading, paths) {
  const items = section(text, heading);
  if (items === null) return [`no "## ${heading}" section`];
  const out = items.filter((i) => i.malformed).map((i) => `not a link line: ${i.line}`);
  const listed = items.filter((i) => !i.malformed).map((i) => i.url.replace(SITE, ''));
  for (const path of paths) {
    const n = listed.filter((p) => p === path).length;
    if (n !== 1) out.push(`${path} is listed ${n} times`);
  }
  for (const path of listed) if (!paths.includes(path)) out.push(`${path} is not a published page`);
  return out;
}

const CARE_PATHS = [...readCareGuides().keys()].map((slug) => `/care/${slug}`);
const PET_PATHS = plantPageRoutes().map((route) => route.path);

test('the committed llms.txt is exactly what the generator writes', () => {
  const expected = expectedLlmsTxt();
  assert.equal(expected.error, undefined);
  assert.equal(TEXT, expected.text);
  // The hand-kept header comes through byte for byte; only the date line is added to it.
  const undated = TEXT.replace(`\n${dateLine(readLedger().lastmod)}\n`, '');
  assert.notEqual(undated, TEXT);
  assert.ok(
    undated.startsWith(`${readFileSync(LLMS_HEADER, 'utf8').trimEnd()}\n\n## Care guides\n`)
  );
});

test('every published care guide and pet-safety page is listed once, and nothing else', () => {
  assert.ok(CARE_PATHS.length >= 64, `${CARE_PATHS.length} care guides`);
  assert.ok(PET_PATHS.length >= 56, `${PET_PATHS.length} pet-safety pages`);
  assert.deepEqual(listFaults(TEXT, 'Care guides', CARE_PATHS), []);
  assert.deepEqual(listFaults(TEXT, 'Pet safety pages', PET_PATHS), []);
});

test('negative control: a dropped, a doubled and an unpublished line are each named', () => {
  const lines = TEXT.split('\n');
  const at = lines.findIndex((line) => line.includes(`(${SITE}/care/monstera)`));
  assert.ok(at > 0);

  const dropped = lines.filter((_, i) => i !== at).join('\n');
  assert.notEqual(dropped, TEXT);
  assert.deepEqual(listFaults(dropped, 'Care guides', CARE_PATHS), [
    '/care/monstera is listed 0 times',
  ]);

  const doubled = [...lines.slice(0, at), lines[at], ...lines.slice(at)].join('\n');
  assert.notEqual(doubled, TEXT);
  assert.deepEqual(listFaults(doubled, 'Care guides', CARE_PATHS), [
    '/care/monstera is listed 2 times',
  ]);

  const invented = TEXT.replace(`(${SITE}/pet-safe/monstera)`, `(${SITE}/pet-safe/no-such-plant)`);
  assert.notEqual(invented, TEXT);
  assert.deepEqual(listFaults(invented, 'Pet safety pages', PET_PATHS), [
    '/pet-safe/monstera is listed 0 times',
    '/pet-safe/no-such-plant is not a published page',
  ]);
});

test('after the first H2 the file is only file lists, as the format requires', () => {
  const after = TEXT.slice(TEXT.indexOf('\n## '));
  for (const line of after.split('\n')) {
    if (line.trim() === '') continue;
    assert.match(
      line,
      /^(## \S.*|- \[[^\]]+\]\(https:\/\/familygreenhouse\.net\/[^)\s]*\)(: .+)?)$/
    );
  }
});

/** The words the table's states are shown as. Written out, not read from the generator. */
const WORDS = { toxic: 'Toxic', 'non-toxic': 'Non-toxic' };

/** What the ASPCA table itself supports for one animal, independent of claimFor(). */
function tableWord(entry, animal) {
  const recorded = entry[animal];
  const listed = entry.aspcaListing?.listed?.[animal];
  return (recorded === 'toxic' || recorded === 'non-toxic') && listed === recorded
    ? WORDS[recorded]
    : 'Not assessed';
}

/** Every fault in the pet-safety lines of `text`; empty means they pass. */
function petLineFaults(text) {
  const entries = new Map(loadPetToxicityTable().entries.map((entry) => [entry.slug, entry]));
  const out = [];
  for (const item of section(text, 'Pet safety pages') ?? []) {
    if (item.malformed) continue;
    const slug = item.url.split('/').pop();
    const entry = entries.get(slug);
    if (!entry) {
      out.push(`${slug}: not in the table`);
      continue;
    }
    const m = item.note.match(
      /^(.+)\. Cats: ([^.]+)\. Dogs: ([^.]+)\. Source: ASPCA plant list\.$/
    );
    if (!m) {
      out.push(`${slug}: not "<name>. Cats: … Dogs: … Source: ASPCA plant list."`);
      continue;
    }
    if (m[1] !== entry.scientificName.replace(/\.+$/, ''))
      out.push(`${slug}: wrong scientific name`);
    for (const [animal, shown] of [
      ['cats', m[2]],
      ['dogs', m[3]],
    ]) {
      const expected = tableWord(entry, animal);
      if (shown !== expected)
        out.push(`${slug}: ${animal} reads "${shown}", the table says "${expected}"`);
    }
    // The words a reader is told, not the address: every URL here is under /pet-safe/.
    if (/\bsafe\b/i.test(`${item.title} ${item.note}`)) out.push(`${slug}: the line says "safe"`);
  }
  return out;
}

test('each pet-safety line says what the ASPCA table says, and never "safe"', () => {
  // Counted first: with no section there are no lines, and no lines have no faults.
  assert.ok((section(TEXT, 'Pet safety pages') ?? []).length >= 56);
  assert.deepEqual(petLineFaults(TEXT), []);
});

test('negative control: a softened verdict and the word "safe" are each named', () => {
  const softened = TEXT.replace(
    /(\/pet-safe\/peace-lily\): [^\n]*?)Cats: Toxic\./,
    '$1Cats: Non-toxic.'
  );
  assert.notEqual(softened, TEXT);
  assert.deepEqual(petLineFaults(softened), [
    'peace-lily: cats reads "Non-toxic", the table says "Toxic"',
  ]);

  const safe = TEXT.replace(
    /\[[^\]]+\](\(https:\/\/familygreenhouse\.net\/pet-safe\/spider-plant\))/,
    '[Spider plant is safe for pets]$1'
  );
  assert.notEqual(safe, TEXT);
  assert.deepEqual(petLineFaults(safe), ['spider-plant: the line says "safe"']);
});

test('an animal the page does not assess reads "Not assessed", never a verdict', () => {
  const words = readPetSafetyWords();
  const [page] = publishedPlantPages();
  const unlisted = {
    ...page,
    claims: { ...page.claims, dogs: { state: 'not-assessed' } },
  };
  assert.notDeepEqual(unlisted.claims, page.claims);
  assert.match(petSafetyLine(unlisted, words), / Dogs: Not assessed\. Source: ASPCA plant list\.$/);
  // No state at all is refused, not printed as a blank or a default.
  assert.throws(
    () => petSafetyLine({ ...page, claims: { cats: page.claims.cats } }, words),
    /no verdict state for dogs/
  );
});

test('each care guide line carries that guide\u2019s own name, water line and light line', () => {
  const items = section(TEXT, 'Care guides');
  const guides = loadCareGuides();
  assert.equal(items.length, guides.length);
  guides.forEach((guide, i) => {
    assert.equal(items[i].url, `${SITE}/care/${guide.slug}`);
    assert.equal(items[i].title, guide.heading ?? `${guide.commonName} care`);
    for (const fact of [guide.scientificName, guide.quickFacts.water, guide.quickFacts.light]) {
      assert.ok(items[i].note.includes(fact.replace(/\.+$/, '')), `${guide.slug}: ${fact}`);
    }
  });
});

test('negative control: a guide with no water line is refused, not listed with a blank', () => {
  const [guide] = loadCareGuides();
  const blank = { ...guide, quickFacts: { ...guide.quickFacts, water: '' } };
  assert.notEqual(blank.quickFacts.water, guide.quickFacts.water);
  assert.throws(() => careGuideLine(blank), /has no quickFacts\.water/);
  assert.throws(() => loadCareGuides('export const CARE_GUIDES = [];'), /no CARE_GUIDES entries/);
});

// --- The "Last updated" date ------------------------------------------------

test('llms.txt carries one "Last updated" line, above ## Pages, with the ledger\u2019s date', () => {
  const ledger = readLedger();
  assert.match(ledger.lastmod, /^\d{4}-\d{2}-\d{2}$/);
  const dated = TEXT.match(/^Last updated: .*$/gm);
  assert.deepEqual(dated, [dateLine(ledger.lastmod)]);
  assert.ok(TEXT.indexOf(dated[0]) < TEXT.indexOf('\n## Pages\n'));
  assert.equal(ledger.content, contentDigest(llmsBody()));
});

test('the date moves when the text does, and only then', () => {
  const body = llmsBody();
  const digest = contentDigest(body);
  const first = nextLedger({}, digest, '2026-11-11');
  assert.equal(first.lastmod, '2026-11-11');
  // Same text on a later day: the date is kept.
  assert.equal(nextLedger(first, digest, '2027-01-02').lastmod, '2026-11-11');
  // Changed text: the date moves to the day it changed.
  const edited = contentDigest(`${body}- [New](${SITE}/care/new)\n`);
  assert.notEqual(edited, digest);
  assert.equal(nextLedger(first, edited, '2027-01-02').lastmod, '2027-01-02');
});

test('negative control: a ledger that does not match the text yields no date, not today', () => {
  const body = llmsBody();
  const stale = { content: contentDigest(`${body} `), lastmod: '2026-11-11' };
  assert.notEqual(stale.content, contentDigest(body));
  const result = expectedLlmsTxt({ body, ledger: stale });
  assert.equal(result.text, undefined);
  assert.match(result.error, /npm run llms/);
  assert.equal(expectedLlmsTxt({ body, ledger: {} }).text, undefined);
  assert.throws(() => withDate(body, undefined), /no date to print/);
});
