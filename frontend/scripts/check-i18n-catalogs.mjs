#!/usr/bin/env node
/**
 * i18n catalog gates — merge-blocking, run by `npm run i18n:check` locally and
 * by the CI `i18n` job (STANDARDS/INTERNATIONALIZATION-STANDARD.md §4; gate
 * numbers below reference that table). Conventions live in docs/i18n.md.
 *
 *   G1  UTF-8: every git-tracked text file decodes as strict UTF-8.
 *   G3  BCP-47: every locale directory name (and the index.html root `lang`)
 *       is a well-formed BCP-47 tag.
 *   G5  Placeholder parity: for every key, the set of `{{placeholder}}`
 *       interpolation variables is identical in every locale (plural forms
 *       compare per-category against the English category, falling back to
 *       English `_other` for categories English doesn't have).
 *   G5  Plural categories: every plural group carries exactly the CLDR
 *       categories its locale requires (`Intl.PluralRules`, e.g. es needs
 *       one/many/other while en needs one/other).
 *   G6  Key parity: every logical key (plural suffixes collapsed) exists in
 *       every locale; symmetric difference must be empty.
 *   TODO markers: a non-English value that is byte-identical to the English
 *       source must be declared in `translation.todo.json` (`todo` = pending
 *       translation, `intentionallyEqual` = correct translation happens to
 *       match English). Undeclared English values and stale markers both fail
 *       — there are no silent English fallbacks the gate can't see.
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOCALES_DIR = path.join(FRONTEND_DIR, 'src', 'i18n', 'locales');
const SOURCE_LOCALE = 'en';
const NAMESPACES = ['translation'];
const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];

const errors = [];
const fail = (msg) => errors.push(msg);

// ---------------------------------------------------------------- helpers

function flatten(tree, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(tree)) {
    if (key === '$comment') continue;
    const p = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[p] = value;
    else if (value && typeof value === 'object') flatten(value, p, out);
    else fail(`${p}: catalog values must be strings or nested objects (got ${typeof value})`);
  }
  return out;
}

/** "importPlants.submit_one" -> { base: "importPlants.submit", category: "one" } */
function splitPlural(key) {
  const m = key.match(new RegExp(`^(.*)_(${PLURAL_SUFFIXES.join('|')})$`));
  return m ? { base: m[1], category: m[2] } : { base: key, category: null };
}

function placeholders(value) {
  return [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)]
    .map((m) => m[1].split(',')[0].trim())
    .sort();
}

function setEq(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ------------------------------------------------- load + G3 BCP-47 validity

const localeDirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

if (!localeDirs.includes(SOURCE_LOCALE)) {
  console.error(`No '${SOURCE_LOCALE}' locale directory under ${LOCALES_DIR} — nothing to gate.`);
  process.exit(1);
}

for (const tag of localeDirs) {
  try {
    const [canonical] = Intl.getCanonicalLocales(tag);
    // Directory names are the authored form; require them already canonical
    // so runtime lookups (localStorage `i18nextLng`, Accept-Language
    // fallbacks) never miss on case/format drift.
    if (canonical !== tag)
      fail(`G3: locale dir '${tag}' is not canonical BCP-47 (want '${canonical}')`);
  } catch {
    fail(`G3: locale dir '${tag}' is not a well-formed BCP-47 language tag`);
  }
}

const indexHtml = readFileSync(path.join(FRONTEND_DIR, 'index.html'), 'utf8');
const langMatch = indexHtml.match(/<html[^>]*\blang="([^"]*)"/);
if (!langMatch) {
  fail('G3: frontend/index.html <html> element has no lang attribute (WCAG 3.1.1)');
} else {
  try {
    Intl.getCanonicalLocales(langMatch[1]);
  } catch {
    fail(`G3: frontend/index.html lang="${langMatch[1]}" is not well-formed BCP-47`);
  }
}

/** locale -> namespace -> flat { key: value } */
const catalogs = {};
for (const tag of localeDirs) {
  catalogs[tag] = {};
  for (const ns of NAMESPACES) {
    const file = path.join(LOCALES_DIR, tag, `${ns}.json`);
    if (!existsSync(file)) {
      fail(`G6: ${tag}/${ns}.json is missing — every locale ships every namespace`);
      catalogs[tag][ns] = {};
      continue;
    }
    catalogs[tag][ns] = flatten(JSON.parse(readFileSync(file, 'utf8')));
  }
}

// ------------------------------------------------------------- G1 UTF-8

const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.avif',
  '.svgz',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.pdf',
  '.zip',
  '.gz',
  '.br',
  '.mp4',
  '.webm',
]);
const repoRoot = execSync('git rev-parse --show-toplevel', {
  cwd: FRONTEND_DIR,
  encoding: 'utf8',
}).trim();
const tracked = execSync('git ls-files -z', { cwd: repoRoot, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const utf8 = new TextDecoder('utf-8', { fatal: true });
let utf8Checked = 0;
for (const rel of tracked) {
  if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue;
  const abs = path.join(repoRoot, rel);
  if (!existsSync(abs)) continue; // deleted in working tree
  try {
    utf8.decode(readFileSync(abs));
    utf8Checked += 1;
  } catch {
    fail(`G1: ${rel} is not valid UTF-8`);
  }
}

// ----------------------------------------- G6 key parity (logical keys)

/**
 * namespace -> logical structure per locale:
 *   locale -> Map(base -> { plain: value|null, categories: Map(cat -> value) })
 */
function logicalKeys(flat, locale, ns) {
  const map = new Map();
  for (const [key, value] of Object.entries(flat)) {
    const { base, category } = splitPlural(key);
    if (!map.has(base)) map.set(base, { plain: null, categories: new Map() });
    const entry = map.get(base);
    if (category) entry.categories.set(category, value);
    else entry.plain = value;
  }
  for (const [base, entry] of map) {
    if (entry.plain !== null && entry.categories.size > 0) {
      fail(
        `G6: ${locale}/${ns} '${base}' mixes a bare key with plural-suffixed keys — ` +
          `use explicit _one/_other forms only`
      );
    }
  }
  return map;
}

const logical = {};
for (const ns of NAMESPACES) {
  logical[ns] = {};
  for (const tag of localeDirs) logical[ns][tag] = logicalKeys(catalogs[tag][ns], tag, ns);
}

for (const ns of NAMESPACES) {
  const source = logical[ns][SOURCE_LOCALE];
  for (const tag of localeDirs) {
    if (tag === SOURCE_LOCALE) continue;
    const target = logical[ns][tag];
    for (const base of source.keys()) {
      if (!target.has(base)) fail(`G6: ${tag}/${ns} is missing key '${base}'`);
    }
    for (const base of target.keys()) {
      if (!source.has(base)) fail(`G6: ${tag}/${ns} has key '${base}' that ${SOURCE_LOCALE} lacks`);
    }
    for (const [base, srcEntry] of source) {
      const tgtEntry = target.get(base);
      if (!tgtEntry) continue;
      const srcPlural = srcEntry.categories.size > 0;
      const tgtPlural = tgtEntry.categories.size > 0;
      if (srcPlural !== tgtPlural) {
        fail(
          `G6: '${base}' is ${srcPlural ? 'plural' : 'plain'} in ${SOURCE_LOCALE} but not in ${tag}`
        );
      }
    }
  }
}

// -------------------------------------- G5 plural-category completeness

for (const ns of NAMESPACES) {
  for (const tag of localeDirs) {
    const required = new Intl.PluralRules(tag).resolvedOptions().pluralCategories.sort();
    for (const [base, entry] of logical[ns][tag]) {
      if (entry.categories.size === 0) continue;
      const have = [...entry.categories.keys()].sort();
      for (const cat of required) {
        if (!have.includes(cat)) {
          fail(
            `G5: ${tag}/${ns} '${base}' is missing required plural category '${cat}' (CLDR for ${tag}: ${required.join('/')})`
          );
        }
      }
      for (const cat of have) {
        if (!required.includes(cat)) {
          fail(`G5: ${tag}/${ns} '${base}_${cat}' is dead — CLDR ${tag} never selects '${cat}'`);
        }
      }
    }
  }
}

// -------------------------------------------- G5 placeholder parity

/** English value a target key is measured against (same category, else _other). */
function englishReference(ns, base, category) {
  const entry = logical[ns][SOURCE_LOCALE].get(base);
  if (!entry) return null;
  if (category === null) return entry.plain;
  return entry.categories.get(category) ?? entry.categories.get('other') ?? null;
}

for (const ns of NAMESPACES) {
  for (const tag of localeDirs) {
    if (tag === SOURCE_LOCALE) continue;
    for (const [base, entry] of logical[ns][tag]) {
      const forms =
        entry.categories.size > 0 ? [...entry.categories.entries()] : [[null, entry.plain]];
      for (const [category, value] of forms) {
        const ref = englishReference(ns, base, category);
        if (ref === null || value === null) continue;
        const want = placeholders(ref);
        const got = placeholders(value);
        // `_one` forms may drop {{count}} in either language ("1 plant" vs
        // "{{count}} plant") — that asymmetry is only legal for count itself.
        const wantCmp = category === 'one' ? want.filter((p) => p !== 'count') : want;
        const gotCmp = category === 'one' ? got.filter((p) => p !== 'count') : got;
        if (!setEq(wantCmp, gotCmp)) {
          const key = category === null ? base : `${base}_${category}`;
          fail(
            `G5: ${tag}/${ns} '${key}' placeholders {${got.join(', ')}} != ` +
              `${SOURCE_LOCALE} {${want.join(', ')}}`
          );
        }
      }
    }
  }
}

// --------------------------------- TODO-translation sidecar (docs/i18n.md)

let todoCount = 0;
for (const tag of localeDirs) {
  if (tag === SOURCE_LOCALE) continue;
  for (const ns of NAMESPACES) {
    const sidecarPath = path.join(LOCALES_DIR, tag, `${ns}.todo.json`);
    const sidecar = existsSync(sidecarPath)
      ? JSON.parse(readFileSync(sidecarPath, 'utf8'))
      : { todo: [], intentionallyEqual: [] };
    const todo = new Set(sidecar.todo ?? []);
    const equal = new Set(sidecar.intentionallyEqual ?? []);
    todoCount += todo.size;

    for (const key of todo) {
      if (equal.has(key))
        fail(`TODO: ${tag}/${ns} '${key}' is in both 'todo' and 'intentionallyEqual'`);
    }
    const flat = catalogs[tag][ns];
    for (const key of [...todo, ...equal]) {
      if (!(key in flat))
        fail(`TODO: ${tag}/${ns}.todo.json lists '${key}' but the catalog has no such key`);
    }
    for (const [key, value] of Object.entries(flat)) {
      const { base, category } = splitPlural(key);
      const ref = englishReference(ns, base, category);
      if (ref === null) continue;
      const marked = todo.has(key) || equal.has(key);
      if (value === ref && !marked) {
        fail(
          `TODO: ${tag}/${ns} '${key}' equals the English source but is not declared in ` +
            `${ns}.todo.json — add it to 'todo' (pending translation) or 'intentionallyEqual'`
        );
      }
      if (value !== ref && marked) {
        fail(
          `TODO: ${tag}/${ns} '${key}' is marked in ${ns}.todo.json but no longer matches English — remove the stale marker`
        );
      }
    }
  }
}

// ------------------------------------------------------------------ report

const keyCounts = localeDirs
  .map(
    (tag) => `${tag}=${NAMESPACES.reduce((n, ns) => n + Object.keys(catalogs[tag][ns]).length, 0)}`
  )
  .join(' ');

if (errors.length > 0) {
  console.error(
    `i18n catalog gates FAILED (${errors.length} problem${errors.length === 1 ? '' : 's'}):\n`
  );
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(
  `i18n catalog gates passed: locales [${localeDirs.join(', ')}], keys ${keyCounts}, ` +
    `${todoCount} TODO-translation markers, ${utf8Checked} files UTF-8-clean.`
);
