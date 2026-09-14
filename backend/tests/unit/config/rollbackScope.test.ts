/**
 * The auto-rollback must not "restore" a deploy that never changed anything.
 *
 * `cd-production.yml`'s `rollback` job fires whenever the post-deploy smoke did
 * not succeed, which includes every way the deploy can fail before the smoke
 * runs at all. One of those ways is the `terraform` job failing at its PLAN:
 * a precondition refusing the apply, an expired credential, an unreadable
 * snapshot. In that case production's infrastructure is untouched — and the
 * rollback job still ran a targeted
 *
 *     terraform plan -target=module.auth.aws_cognito_user_pool.main
 *     terraform apply rollback-auth.tfplan
 *
 * against the live Cognito pool, to undo a change nobody made. It then failed
 * for the same reason the original plan had, `verify_rollback` failed with it,
 * and the run finished by telling the operator that "production may be running
 * broken code".
 *
 * That is measurable, not hypothetical: the v0.24.0 tag failed at Terraform
 * Plan and its run ends with "Verify rollback outcome" red, and the v0.3.0 and
 * v0.23.3 tags failed in `validate` with the same shape of report. The loudest
 * message this pipeline has is reserved for the least dangerous failure it can
 * have.
 *
 * The marker that fixes it — `apply_attempted` — is set in its own step BEFORE
 * the apply, and that placement is the whole correctness argument: an apply
 * that fails part way HAS mutated production, and that is precisely when the
 * restore must still run. Marking success instead of attempt would have turned
 * the most dangerous case into a skipped recovery, so this file asserts the
 * ordering as well as the condition.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url);
const WORKFLOW = new URL('.github/workflows/cd-production.yml', ROOT);

const workflow = readFileSync(WORKFLOW, 'utf8');

/** The body of one `- name:` step, from its header to the next step's. */
export function stepBody(source: string, name: string): string | null {
  const header = source.indexOf(`- name: ${name}`);
  if (header === -1) return null;
  const rest = source.slice(header + 1);
  const next = rest.search(/\n {6}- name: /u);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Comment lines removed, so a rule reads the workflow rather than its prose. */
export function code(block: string): string {
  return block
    .split('\n')
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n');
}

describe('the production rollback only restores what a deploy could have moved', () => {
  it('answers three states, not two', () => {
    expect(stepBody(workflow, 'Record that an apply is about to run')).not.toBeNull();
    expect(stepBody(workflow, 'Note that no apply has run yet')).not.toBeNull();
    // `true` from the step before the apply, `false` from the one after init,
    // and absent when the job died before either — the fallback is what keeps
    // those last two distinguishable.
    expect(workflow).toMatch(
      /apply_attempted: \$\{\{ steps\.apply_attempted\.outputs\.attempted \|\| steps\.apply_not_yet\.outputs\.attempted \}\}/u
    );
  });

  it('reads an absent marker as unknown, never as "nothing was applied"', () => {
    // The dangerous direction. If the terraform job failed before it could say
    // either way, the restore must still be attempted and the operator must
    // still get the loud message; only an explicit `false` is reassuring.
    const restore = code(stepBody(workflow, 'Restore Cognito registration policy') as string);
    expect(restore).toMatch(/apply_attempted != 'false'/u);
    expect(restore).not.toMatch(/apply_attempted == 'true'/u);

    for (const name of [
      'Verify rollback outcome',
      'Report successful rollback',
      'Deployment notification',
    ]) {
      const body = code(stepBody(workflow, name) as string);
      expect(body).toMatch(/APPLY_ATTEMPTED"? ?(=|==) "?false/u);
      expect(body).not.toMatch(/APPLY_ATTEMPTED"? ?!= "?true/u);
    }
  });

  it('sets the marker BEFORE the apply, so a partial apply still gets restored', () => {
    const marker = workflow.indexOf('- name: Record that an apply is about to run');
    const apply = workflow.indexOf('- name: Terraform Apply');
    expect(marker).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(-1);
    expect(marker).toBeLessThan(apply);
  });

  it('skips the Cognito restore when the job says no apply ran', () => {
    const body = code(stepBody(workflow, 'Restore Cognito registration policy') as string);
    expect(body).toMatch(/needs\.terraform\.outputs\.apply_attempted != 'false'/u);
  });

  it('does not fail the rollback for a restore it deliberately skipped', () => {
    const body = code(stepBody(workflow, 'Verify rollback outcome') as string);
    expect(body).toMatch(/APPLY_ATTEMPTED/u);
    // The skip branch has to come first, or the `!= success` test below it
    // turns the skip into the failure this change exists to remove.
    expect(body.indexOf('APPLY_ATTEMPTED" = "false"')).toBeLessThan(
      body.indexOf('REGISTRATION_OUTCOME" != "success"')
    );
  });

  it('tells the operator production is untouched rather than rolled back', () => {
    const body = code(stepBody(workflow, 'Deployment notification') as string);
    expect(body).toMatch(/failed before anything was applied/u);
    expect(body).toMatch(/still running the previous release/u);
    // And it is still a failed run: nothing here turns a failed deploy green.
    expect(body.match(/exit 1/gu)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('is not vacuous: the rules reject the text they replaced', () => {
    const before = [
      '      - name: Restore Cognito registration policy',
      '        id: restore_registration',
      "        if: ${{ always() && steps.checkout.outcome == 'success' }}",
      '      - name: Verify rollback outcome',
      '        run: |',
      '          if [ "$REGISTRATION_OUTCOME" != "success" ]; then',
      '            failed=1',
      '          fi',
    ].join('\n');

    const restore = code(stepBody(before, 'Restore Cognito registration policy') as string);
    expect(restore).not.toMatch(/apply_attempted/u);

    const verify = code(stepBody(before, 'Verify rollback outcome') as string);
    expect(verify).not.toMatch(/APPLY_ATTEMPTED/u);
  });
});
