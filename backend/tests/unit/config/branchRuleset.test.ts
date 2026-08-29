/**
 * Lockout guard: `.github/rulesets/main.json` must not be a lockout waiting to be
 * applied.
 *
 * Why this exists: the committed ruleset is documented in
 * `.github/rulesets/README.md` with an apply/regenerate procedure that posts the file
 * as it stands (`gh api ... /rulesets --input .github/rulesets/main.json`). The file
 * carried `"bypass_actors": []` from the day it was written, and nothing in this repo
 * read it, so following this repository's own instructions was enough to leave `main`
 * with no break-glass path at all. That is not hypothetical: applying a no-bypass
 * ruleset locked the owner out across eighteen repositories in this portfolio, and
 * GitHub returns 201 for such an apply, so nothing warns you.
 *
 * Correcting the file once is not the fix, because the file can regress. This module is
 * the fix: the empty list, and every other shape that drops the owner's bypass, is now
 * a failing test in the required `Test Backend` gate.
 *
 * Every check here fails closed. `lockoutRisk` is a pure function of a parsed document
 * so it can be run against documents it MUST reject as well as against the committed
 * one, and `loadRuleset` refuses a missing or unparseable file rather than returning
 * something empty that the assertions below would read as "nothing wrong". A guard that
 * passes when its subject is absent is the defect it exists to catch — and the parse is
 * what catches it, because a truncated JSON file still contains the literal string
 * `bypass_actors` and a grep would wave it through.
 *
 * Deliberate divergence from the vendored `docs/standards/CI-CD-STANDARD.md`: CICD-15
 * and §5.1 ask for `bypass_mode: "pull_request"` on a named user, and for an empty
 * bypass list under the solo-maintainer profile. Both are refused here and the reasons
 * are recorded in `.github/rulesets/README.md`.
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url);
const RULESET = new URL('.github/rulesets/main.json', ROOT);
const RULESET_DOC = new URL('.github/rulesets/README.md', ROOT);

/**
 * The repository owner's standing bypass, and the only entry this file may carry.
 *
 * `RepositoryRole` 5 is admin. `bypass_mode: 'always'` rather than CICD-15's suggested
 * `pull_request`, because a bypass that only works inside a pull request is no use when
 * the thing that is wedged is the pull request itself.
 */
const OWNER_BYPASS = {
  actor_id: 5,
  actor_type: 'RepositoryRole',
  bypass_mode: 'always',
} as const;

/** The committed ruleset, or a thrown failure. Never a silent empty document. */
function loadRuleset(source: URL = RULESET): Record<string, unknown> {
  const path = fileURLToPath(source);
  let raw: string;
  try {
    raw = readFileSync(source, 'utf8');
  } catch (err) {
    throw new Error(
      `${path} could not be read, and the committed ruleset is the whole subject of this ` +
        `check: ${String(err)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${path} is not parseable JSON, so nothing can vouch for it — note that a truncated ` +
        `file still contains the string "bypass_actors": ${String(err)}`
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** True only for the owner's exact standing bypass, mode included. */
function isOwnerBypass(actor: unknown): boolean {
  if (actor === null || typeof actor !== 'object' || Array.isArray(actor)) return false;
  const entry = actor as Record<string, unknown>;
  return (
    entry.actor_id === OWNER_BYPASS.actor_id &&
    entry.actor_type === OWNER_BYPASS.actor_type &&
    entry.bypass_mode === OWNER_BYPASS.bypass_mode
  );
}

/**
 * Why applying this ruleset would lock the owner out, or `null` if it would not.
 *
 * A pure function of a document, so it can be exercised against the documents it must
 * reject and not only against the one committed here.
 */
function lockoutRisk(document: unknown): string | null {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return `the ruleset is ${Array.isArray(document) ? 'an array' : typeof document}, not a JSON object`;
  }

  const doc = document as Record<string, unknown>;
  if (!('bypass_actors' in doc)) {
    return 'no bypass_actors key at all, which GitHub reads as an empty list';
  }

  const actors = doc.bypass_actors;
  if (!Array.isArray(actors)) {
    return `bypass_actors is ${actors === null ? 'null' : typeof actors}, not a list`;
  }
  if (actors.length === 0) {
    return (
      'bypass_actors is empty, so applying this leaves no break-glass path and the owner ' +
      'cannot merge, push, or delete the ruleset that is blocking them'
    );
  }
  if (!actors.some(isOwnerBypass)) {
    return (
      `bypass_actors does not carry the owner's standing bypass ` +
      `${JSON.stringify(OWNER_BYPASS)}; it carries ${JSON.stringify(actors)}`
    );
  }
  return null;
}

describe('committed branch ruleset', () => {
  it('would not lock the owner out if it were applied as committed', () => {
    // The whole point. This is the assertion the empty list has to fail.
    const risk = lockoutRisk(loadRuleset());
    expect(
      risk,
      'applying .github/rulesets/main.json as committed would lock the repository owner ' +
        `out: ${risk}. See .github/rulesets/README.md, "Bypass actors: the repository ` +
        'owner, and nobody else".'
    ).toBeNull();
  });

  it('names the repository owner as its only bypass actor', () => {
    // One actor. A second entry widens who can skip every rule, and is a real finding.
    expect(loadRuleset().bypass_actors).toEqual([OWNER_BYPASS]);
  });

  it('is documented by a README that names the same actor the file carries', () => {
    // The apply procedure is prose, and prose drifts. If the file and the instructions
    // for reading it disagree, the instructions are the ones a person follows.
    const doc = readFileSync(RULESET_DOC, 'utf8');
    for (const fragment of ['"actor_id": 5', 'RepositoryRole', 'always', 'CICD-15']) {
      expect(doc, `.github/rulesets/README.md does not name ${fragment}`).toContain(fragment);
    }
  });
});

describe('lockoutRisk', () => {
  // Five ways to lose the bypass, each of which GitHub accepts with a 201 like any
  // other apply. The empty list is the one that was committed; `pull_request` on the
  // right actor is the shape the LIVE ruleset is in today and the shape CICD-15 asks
  // for, which is exactly why it has to be refused here.
  it.each([
    ['empty', { bypass_actors: [] }, 'is empty'],
    ['absent', {}, 'no bypass_actors key'],
    ['wrong type', { bypass_actors: {} }, 'not a list'],
    [
      'wrong actor',
      { bypass_actors: [{ actor_id: 1, actor_type: 'Integration', bypass_mode: 'always' }] },
      'does not carry the owner',
    ],
    [
      'pull_request mode on the right actor',
      { bypass_actors: [{ ...OWNER_BYPASS, bypass_mode: 'pull_request' }] },
      'does not carry the owner',
    ],
  ])('refuses a ruleset with %s', (_label, document, expected) => {
    const risk = lockoutRisk(document);
    expect(risk, `${JSON.stringify(document)} should be refused`).not.toBeNull();
    expect(risk).toContain(expected);
  });

  it('accepts the shape it should, so it cannot pass by refusing everything', () => {
    // The positive control for the table above.
    expect(lockoutRisk({ bypass_actors: [OWNER_BYPASS] })).toBeNull();
  });
});

describe('loadRuleset', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ruleset-guard-'));

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('fails when the ruleset file is missing rather than vouching for nothing', () => {
    expect(() => loadRuleset(new URL(`file://${join(scratch, 'absent.json')}`))).toThrow(
      /could not be read/
    );
  });

  it('fails on a truncated file that a grep for bypass_actors would wave through', () => {
    const path = join(scratch, 'truncated.json');
    writeFileSync(path, '{\n  "name": "protect-main",\n  "bypass_actors": [{ "actor_id": 5,');
    expect(readFileSync(path, 'utf8')).toContain('bypass_actors');
    expect(() => loadRuleset(new URL(`file://${path}`))).toThrow(/not parseable JSON/);
  });

  it('fails when the file parses to something other than a JSON object', () => {
    const path = join(scratch, 'array.json');
    writeFileSync(path, '[{ "bypass_actors": [] }]');
    expect(() => loadRuleset(new URL(`file://${path}`))).toThrow(/not a JSON object/);
  });
});
