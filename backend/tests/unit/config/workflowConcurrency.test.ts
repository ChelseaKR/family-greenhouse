/**
 * Verdict-loss guard: a commit pushed to `main` must get a CI run of its own.
 *
 * Why this exists: a GitHub `concurrency` group holds **one running run and exactly one
 * pending run**. A third arrival evicts the pending one, and the evicted run never
 * dispatches a single job. A group keyed on the ref alone --
 *
 *     concurrency:
 *       group: ${{ github.workflow }}-${{ github.ref }}
 *
 * -- gives *every commit on `main`* the same slot, because `github.ref` is
 * `refs/heads/main` for all of them. This repository merges in bursts; on 2026-09-06
 * alone `main` took a run of pull requests back to back. Under a shared slot some of
 * those commits got no run at all.
 *
 * What makes it worth a permanent test rather than a one-time edit is that the loss is
 * **silent**. A dropped run reads as `cancelled`, or as simply absent, and never as a
 * failure. Nothing goes red, no annotation appears, and no notification names the commit
 * that went unverified. A repository can therefore look fully green while commits on its
 * default branch were never checked -- and this repository has taken real card payments
 * since 2026-09-01, so "looked green, never ran" is not a cosmetic problem.
 *
 * `cancel-in-progress` does not decide whether this happens, only whether the loss is
 * visible: `true` cancels the run the earlier commit was still executing, `false`
 * silently evicts the later one from the pending slot. Both lose a verdict. Nothing here
 * asserts anything about it, and the change that added this file left every workflow's
 * value exactly as it found it.
 *
 * The key must vary per commit on a push while staying per-ref on a pull request, so
 * that branch supersession -- the thing the group exists for -- still works:
 *
 *     group: <name>-${{ github.event_name == 'pull_request' && 'pr' || github.sha }}
 *
 * Like `branchRuleset.test.ts`, every check here fails closed, and `slotRisk` is a pure
 * function of a workflow's text so it can be run against documents it MUST reject as
 * well as against the committed ones. A guard that only ever sees passing input is a
 * guard nobody has tested.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url);
const WORKFLOWS = new URL('.github/workflows/', ROOT);
const RULESET = new URL('.github/rulesets/main.json', ROOT);

/**
 * Workflows allowed to key on the ref alone because successive runs converge on one
 * answer, as `{filename: reason}`.
 *
 * An OpenSSF Scorecard result is a property of the *repository* -- branch protection,
 * token permissions, the dependency graph -- not of a commit. The newest run is the
 * answer, and the run it replaced was not a different answer, so evicting the older one
 * loses nothing. This is the only exemption, and
 * `every converging exemption still earns its place` below refuses to let it stand if
 * scorecard ever stops running on push or starts gating a merge.
 */
const CONVERGING_WORKFLOWS: Record<string, string> = {
  'scorecard.yml': 'an OpenSSF score is a property of the repository, not of a commit',
};

/**
 * Workflows that must still be found on a branch push. Every rule below is vacuous
 * against an empty sweep, so a rename or a trigger change has to fail loudly here rather
 * than quietly reduce this file to checking nothing.
 */
const EXPECTED_ON_BRANCH_PUSH = [
  'ci.yml',
  'gradle-wrapper-validation.yml',
  'scorecard.yml',
  'zizmor.yml',
] as const;

/**
 * Pushed for tags only, so a ref-only key is already per-release: every tag is a unique
 * ref. Named here only so the *derivation* can be shown to discriminate -- never to
 * grant an exemption, which is why it is asserted absent from the sweep rather than
 * skipped inside it.
 */
const EXPECTED_TAGS_ONLY = ['cd-production.yml'] as const;

/** The body of a top-level `key:` mapping, or `null`. */
function topLevelBlock(text: string, key: string): string | null {
  const match = new RegExp(`^${key}:[ \\t]*\\n((?:[ \\t]+[^\\n]*\\n|[ \\t]*\\n)*)`, 'm').exec(text);
  return match ? match[1] : null;
}

/** The body of the `push:` trigger, or `null` when the workflow has no push trigger. */
function pushBlock(text: string): string | null {
  const on = topLevelBlock(text, 'on');
  if (on === null) return null;
  const match = /^([ \t]+)push:[ \t]*\n((?:\1[ \t]+[^\n]*\n|[ \t]*\n)*)/m.exec(on);
  if (match === null) {
    // Flow style (`on: [push, pull_request]`) carries no filter, so it fires everywhere.
    return /^on:.*\bpush\b/m.test(text) ? '' : null;
  }
  return match[2];
}

/**
 * Whether a push trigger can fire for a branch rather than only for a tag.
 *
 * A bare `push:` with no filter fires for every branch, so the *absence* of a `tags:`
 * key is the permissive case, not the exempt one. Getting this backwards would exempt
 * everything and leave the suite green, which is what `the tags-only exemption is narrow`
 * exists to catch.
 */
function pushesToABranch(block: string): boolean {
  const hasTags = /^[ \t]*tags(-ignore)?:/m.test(block);
  const hasBranches = /^[ \t]*branches(-ignore)?:/m.test(block);
  return hasBranches || !hasTags;
}

/** The workflow-level concurrency group expression, or `null`. */
function concurrencyGroup(text: string): string | null {
  const block = topLevelBlock(text, 'concurrency');
  if (block === null) return null;
  const match = /^[ \t]*group:[ \t]*(.+?)[ \t]*$/m.exec(block);
  return match ? match[1] : null;
}

/**
 * Why this workflow can lose a commit's verdict, or `null` if it cannot.
 *
 * A pure function of a workflow's text, so the table below can exercise it against the
 * shapes it must reject and not only against the files committed here.
 */
function slotRisk(text: string): string | null {
  const block = pushBlock(text);
  if (block === null) return null; // never runs on push: no queue, nothing to evict
  if (!pushesToABranch(block)) return null; // tags only: every tag is its own ref
  const group = concurrencyGroup(text);
  // No group at all means no shared slot, so no run can be evicted from one. That is a
  // different shape from a bad group and is deliberately not a finding.
  if (group === null) return null;
  if (!group.includes('github.sha')) {
    return (
      `keys its concurrency group on the ref alone (${group}), so every commit pushed ` +
      'to main competes for one slot and a burst of merges drops a verdict with no run ' +
      'to show for it -- an absent check, not a red one'
    );
  }
  if (!group.includes('pull_request')) {
    return (
      `varies its group per commit but does not keep pull requests on a per-ref group ` +
      `(${group}), so two pushes to one branch would both run instead of the later ` +
      'superseding the earlier'
    );
  }
  return null;
}

/** Every workflow file, as `{filename: text}`. Throws rather than returning nothing. */
function workflows(): Record<string, string> {
  const dir = fileURLToPath(WORKFLOWS);
  const names = readdirSync(dir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'));
  if (names.length === 0) {
    throw new Error(`no workflow files under ${dir}; this suite would assert nothing`);
  }
  return Object.fromEntries(names.map((n) => [n, readFileSync(`${dir}${n}`, 'utf8')]));
}

/** Only the workflows that run on a push to a branch. */
function branchPushWorkflows(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(workflows()).filter(([, text]) => {
      const block = pushBlock(text);
      return block !== null && pushesToABranch(block);
    })
  );
}

/** The check names a workflow's jobs report under, which is how a ruleset names them. */
function jobNames(text: string): string[] {
  const body = text.split('\njobs:')[1] ?? '';
  const names: string[] = [];
  for (const block of body.matchAll(
    /^ {2}([a-z0-9][a-z0-9_-]*):\n((?: {4}.*)?(?:\n(?: {4}.*)?)*)/gm
  )) {
    const named = /^ {4}name:\s*(.+?)\s*$/m.exec(block[2]);
    names.push(named ? named[1].replace(/^['"]|['"]$/g, '') : block[1]);
  }
  return names;
}

/** Contexts the committed ruleset requires before a pull request may merge. */
function requiredContexts(): string[] {
  const doc = JSON.parse(readFileSync(RULESET, 'utf8')) as {
    rules: { type: string; parameters?: { required_status_checks?: { context: string }[] } }[];
  };
  const rule = doc.rules.find((r) => r.type === 'required_status_checks');
  if (!rule?.parameters?.required_status_checks) {
    throw new Error('the committed ruleset requires no status checks at all');
  }
  return rule.parameters.required_status_checks.map((c) => c.context);
}

describe('the push-workflow sweep', () => {
  it('still finds the workflows it is meant to police', () => {
    // Guard first: everything below passes vacuously against an empty set.
    const found = Object.keys(branchPushWorkflows());
    for (const name of EXPECTED_ON_BRANCH_PUSH) {
      expect(
        found,
        `${name} no longer runs on a branch push. Either it was renamed or its trigger ` +
          `changed; until EXPECTED_ON_BRANCH_PUSH is updated, the rules below would ` +
          `pass by checking nothing. Found: ${found.join(', ')}`
      ).toContain(name);
    }
  });

  it('keeps the tags-only exemption narrow', () => {
    // The guard on the derivation itself. If `pushesToABranch` ever returned false by
    // accident, every workflow would be silently exempt and this suite would stay green.
    const swept = Object.keys(branchPushWorkflows());
    for (const name of EXPECTED_TAGS_ONLY) {
      expect(Object.keys(workflows())).toContain(name);
      expect(
        swept,
        `${name} pushes on tags only and should not be swept in; that it was means the ` +
          'trigger changed or the classifier is wrong'
      ).not.toContain(name);
    }
    expect(
      swept.length,
      'the classifier exempted every workflow, so nothing is checked'
    ).toBeGreaterThan(0);
  });

  it('has no branch-push workflow that escapes the checks below', () => {
    // EXPECTED_ON_BRANCH_PUSH is hand-written, so a newly added workflow would otherwise
    // never be examined at all.
    const unpoliced = Object.keys(branchPushWorkflows()).filter(
      (n) => !(EXPECTED_ON_BRANCH_PUSH as readonly string[]).includes(n)
    );
    expect(
      unpoliced,
      `${unpoliced.join(', ')} now run on a branch push but are not listed in ` +
        'EXPECTED_ON_BRANCH_PUSH, so nothing here checks their concurrency key'
    ).toEqual([]);
  });
});

describe('a commit pushed to main gets a concurrency slot of its own', () => {
  const committed = branchPushWorkflows();

  it.each(
    EXPECTED_ON_BRANCH_PUSH.filter((n) => !(n in CONVERGING_WORKFLOWS)).map((n) => [n] as const)
  )('%s', (name) => {
    const risk = slotRisk(committed[name]);
    expect(risk, `${name} ${risk}`).toBeNull();
  });
});

describe('every converging exemption still earns its place', () => {
  // An exception list is only safe while every entry is still true.
  it.each(Object.entries(CONVERGING_WORKFLOWS))('%s', (name, reason) => {
    const push = branchPushWorkflows();
    expect(push, `${name} is exempt but no longer runs on push`).toHaveProperty(name);
    expect(reason, `${name} is exempt with no reason recorded`).toBeTruthy();

    // The test CI-CD-STANDARD 11c gives for this exemption: the workflow must produce no
    // required status check. An exempt workflow that became a merge gate would keep its
    // exemption and start dropping verdicts that block merges.
    const required = requiredContexts();
    const gating = jobNames(push[name]).filter((j) => required.includes(j));
    expect(
      gating,
      `${name} is exempt from the per-commit key, but ${gating.join(', ')} is a required ` +
        'status check, so a dropped run blocks a merge'
    ).toEqual([]);
  });
});

describe('slotRisk', () => {
  // The negative controls, kept permanently rather than run once by hand. Each of these
  // is a shape GitHub accepts happily and that silently drops runs.
  const withGroup = (group: string, push = '  push:\n    branches: [main]\n') =>
    `name: x\n\non:\n${push}  pull_request:\n\nconcurrency:\n  group: ${group}\n  cancel-in-progress: true\n\njobs:\n  a:\n    runs-on: ubuntu-latest\n`;

  it.each([
    ['ref only', '${{ github.workflow }}-${{ github.ref }}', 'ref alone'],
    ['bare ref', '${{ github.ref }}', 'ref alone'],
    ['a constant', 'ci', 'ref alone'],
    ['ref_name only', 'ci-${{ github.ref_name }}', 'ref alone'],
    ['sha but no pull-request arm', 'ci-${{ github.sha }}', 'per-ref group'],
  ])('refuses a group keyed on %s', (_label, group, expected) => {
    const risk = slotRisk(withGroup(group));
    expect(risk, `${group} should be refused`).not.toBeNull();
    expect(risk).toContain(expected);
  });

  it('accepts the fixed shape, so it cannot pass by refusing everything', () => {
    // The positive control for the table above.
    expect(
      slotRisk(
        withGroup(
          "${{ github.workflow }}-${{ github.ref }}-${{ github.event_name == 'pull_request' && 'pr' || github.sha }}"
        )
      )
    ).toBeNull();
  });

  it('ignores a ref-only group on a workflow pushed only for tags', () => {
    // Every tag is a unique ref, so this shape is already per-release.
    expect(slotRisk(withGroup('${{ github.ref }}', "  push:\n    tags: ['v*']\n"))).toBeNull();
  });

  it('ignores a workflow that does not run on push at all', () => {
    expect(
      slotRisk('name: x\n\non:\n  schedule:\n    - cron: "0 6 * * 1"\n\nconcurrency:\n  group: x\n')
    ).toBeNull();
  });

  it('ignores a push workflow that declares no group, because it shares no slot', () => {
    expect(slotRisk('name: x\n\non:\n  push:\n    branches: [main]\n\njobs:\n  a:\n')).toBeNull();
  });

  it('does not mistake a job-level concurrency block for the workflow-level one', () => {
    // A `concurrency:` nested in a job is a different thing with different consequences.
    // Reading it as the top-level key would let a bad workflow-level group hide.
    const text =
      'name: x\n\non:\n  push:\n    branches: [main]\n\njobs:\n  a:\n    concurrency:\n      group: inner-${{ github.sha }}\n    runs-on: ubuntu-latest\n';
    expect(slotRisk(text)).toBeNull(); // no top-level group at all -> no shared slot
    expect(concurrencyGroup(text)).toBeNull();
  });
});
