/**
 * Every DynamoDB index the backend reads must be one the table Terraform
 * actually defines (#400).
 *
 * Why this exists: `apiKeys.lookupApiKey` queried `IndexName: 'GSI3'` for
 * months. `infrastructure/modules/database/main.tf` has only ever declared
 * `GSI1` and `GSI2`, and nothing else in `infrastructure/` created a third —
 * confirmed against the live production table, which carries exactly two.
 *
 * A `Query` naming an index that does not exist is not a degraded read. It
 * raises `ValidationException` before returning a single item, so every
 * public-API authentication failed closed from the day the feature shipped.
 * The service's own unit tests could not see it: they mock the DynamoDB
 * client, so the query never met a real table schema, and the test named
 * "returns null when GSI3 returns no match" asserted the shape of a call
 * against an index that was not there. It was a check that could not fail for
 * the failure that mattered.
 *
 * This is the cheap half of the integration test #400 asks for. It needs no
 * local DynamoDB and no AWS call — the table schema is committed HCL and the
 * index names are string literals, so the whole invariant is syntactic. It
 * runs in `npm run verify` and in CI's required Test Backend job, which means
 * a phantom index now fails a build instead of production.
 *
 * Two directions are checked, because the original bug was present on both:
 *
 *   1. READ  — every `IndexName: '…'` in `backend/src` names a declared index.
 *   2. WRITE — every `GSInPK`/`GSInSK` attribute the source writes or filters
 *      on is a declared `attribute` on the table. DynamoDB silently accepts an
 *      item carrying an attribute no index projects, so the write half of a
 *      phantom index leaves no trace at runtime at all.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const TABLE_TF = 'infrastructure/modules/database/main.tf';
const SRC_DIR = join(ROOT, 'backend/src');

const tf = readFileSync(join(ROOT, TABLE_TF), 'utf8');

/** `global_secondary_index { name = "GSI1" … }` → the set of index names. */
function declaredIndexes(hcl: string): Set<string> {
  const names = new Set<string>();
  for (const block of hcl.matchAll(/global_secondary_index\s*\{([\s\S]*?)\n\s*\}/gu)) {
    const name = /\bname\s*=\s*"([^"]+)"/u.exec(block[1]);
    if (name) names.add(name[1]);
  }
  return names;
}

/** `attribute { name = "GSI1PK" … }` → the set of declared attribute names. */
function declaredAttributes(hcl: string): Set<string> {
  const names = new Set<string>();
  for (const block of hcl.matchAll(/\battribute\s*\{([\s\S]*?)\n\s*\}/gu)) {
    const name = /\bname\s*=\s*"([^"]+)"/u.exec(block[1]);
    if (name) names.add(name[1]);
  }
  return names;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') && !/\.(test|spec)\.ts$/u.test(entry)) out.push(full);
  }
  return out;
}

const files = sourceFiles(SRC_DIR).map((path) => ({
  rel: path.slice(ROOT.length),
  text: readFileSync(path, 'utf8'),
}));

describe('DynamoDB index contract', () => {
  it('parses the committed table definition', () => {
    // Guards the guard: if the Terraform is reshaped so these regexes match
    // nothing, every assertion below would pass vacuously against an empty
    // set. An empty set here is a broken parser, not a table with no indexes.
    expect(declaredIndexes(tf).size).toBeGreaterThan(0);
    expect(declaredAttributes(tf).size).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThan(0);
  });

  it('declares exactly the indexes this repo believes exist', () => {
    // Pinned, not just non-empty. Adding a GSI is a live-table change with a
    // backfill and a cost, so it should be a deliberate edit here too.
    expect([...declaredIndexes(tf)].sort()).toEqual(['GSI1', 'GSI2']);
  });

  it('never queries an index the table does not define', () => {
    const declared = declaredIndexes(tf);
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      for (const use of text.matchAll(/IndexName:\s*'([^']+)'/gu)) {
        if (!declared.has(use[1])) offenders.push(`${rel}: IndexName: '${use[1]}'`);
      }
    }
    expect(
      offenders,
      `These reads name an index ${TABLE_TF} does not define. DynamoDB answers ` +
        `such a Query with ValidationException, so the read fails 100% of the ` +
        `time in every environment. Either add the index to the table (a live ` +
        `change: new attribute blocks, a backfill, and ongoing cost) or re-key ` +
        `onto one of [${[...declared].sort().join(', ')}].`
    ).toEqual([]);
  });

  it('never writes a GSI key attribute the table does not declare', () => {
    const declared = declaredAttributes(tf);
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      for (const use of text.matchAll(/\b(GSI\d+(?:PK|SK))\b/gu)) {
        if (!declared.has(use[1])) offenders.push(`${rel}: ${use[1]}`);
      }
    }
    expect(
      [...new Set(offenders)],
      `These attributes are written or filtered on but are not declared in ` +
        `${TABLE_TF}, so no index projects them. DynamoDB accepts the item ` +
        `anyway and nothing fails at write time — the row simply never becomes ` +
        `findable, which is how #400 stayed invisible on the write side.`
    ).toEqual([]);
  });
});
