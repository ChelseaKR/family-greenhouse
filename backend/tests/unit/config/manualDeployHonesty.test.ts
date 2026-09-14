/**
 * The manual deploy path must not report success it did not have.
 *
 * `scripts/deploy.sh` is the third copy of the deploy sequence, next to
 * `cd-production.yml` and `cd-staging.yml`, and the only one a person runs by
 * hand — which is to say, the one that gets run when something is already
 * wrong. It had drifted from the other two in four ways, each of which ends
 * with the script printing "Deployment to production complete!":
 *
 *   1. `aws lambda update-function-code ... 2>/dev/null` inside an `if`, whose
 *      else branch printed `✗` and `continue`d. A run that failed to update
 *      every one of the sixteen functions still exited 0, having thrown away
 *      the one line that said why.
 *   2. The archive of the published zip carried `|| true`. That object IS the
 *      rollback: `cd-production.yml` restores a previous version by fetching
 *      exactly that key, so a silent failure here leaves a live Lambda version
 *      the auto-rollback cannot go back to.
 *   3. A missing bundle printed "Skipping" and carried on, so a half-built
 *      `dist/` deployed a partial release and announced a whole one.
 *   4. The hashed-asset sync still passed `--delete`. cd-production.yml removed
 *      it deliberately: a tab open across a release holds the previous index
 *      chunk, which names a `<Route>-<hash>.js` the sync had just deleted, and
 *      the next lazy navigation fails with "The page's code couldn't be
 *      fetched" — observed on /confirm-email.
 *
 * None of that is visible in CI, because this script is never executed there.
 * The assertions below are what keeps the manual path from drifting back, in
 * the same spirit as `scripts/check-well-known.mjs`, which already asserts one
 * property across all three deploy paths. Each predicate is a pure function of
 * the script text, exercised against text it MUST reject as well as against the
 * committed file.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url);
const SCRIPT = new URL('scripts/deploy.sh', ROOT);

/** The Lambda deploy loop, from the HANDLERS array to the `done`. */
export function lambdaLoop(script: string): string {
  const start = script.indexOf('HANDLERS=(');
  if (start === -1) return '';
  const end = script.indexOf('\ndone', start);
  return end === -1 ? script.slice(start) : script.slice(start, end);
}

/** The immutable-asset sync, from its `aws s3 sync` to the blank line after it. */
export function immutableAssetSync(script: string): string {
  const marker = 'max-age=31536000,public';
  const at = script.indexOf(marker);
  if (at === -1) return '';
  const start = script.lastIndexOf('aws s3 sync', at);
  const end = script.indexOf('\n\n', at);
  return script.slice(start, end === -1 ? undefined : end);
}

/** The shell of a block, with comment lines removed. */
export function code(block: string): string {
  return block
    .split('\n')
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n');
}

/**
 * Ways this script can end up reporting a deploy it did not complete.
 *
 * Comments are stripped first. A rule that matches prose is a rule that passes
 * or fails on what a file SAYS rather than what it does — the mistake that let
 * four conformance checks across this portfolio pass by matching tool names in
 * comments, and the one the first draft of this file made by naming the old
 * "Skipping" message in the comment explaining why it is gone.
 */
export function silentFailures(script: string): string[] {
  const loop = code(lambdaLoop(script));
  const found: string[] = [];

  if (/update-function-code[\s\S]*?2>\/dev\/null/u.test(loop)) {
    found.push('the Lambda update discards stderr, so a failure cannot say why');
  }
  if (/lambda-versions\/[^\n]*\n?[^\n]*\|\| true/u.test(loop)) {
    found.push('the rollback archive is wrapped in `|| true`');
  }
  if (/Skipping/u.test(loop)) {
    found.push('a missing bundle is skipped rather than recorded as a failure');
  }
  if (!/FAILED_HANDLERS/u.test(code(script))) {
    found.push('nothing accumulates the functions that did not deploy');
  } else if (!/\$\{#FAILED_HANDLERS\[@\]\} -gt 0[\s\S]*?exit 1/u.test(code(script))) {
    found.push('failed functions are collected but the script still exits 0');
  }
  return found;
}

const script = readFileSync(SCRIPT, 'utf8');

describe('scripts/deploy.sh reports what it actually did', () => {
  it('has a Lambda loop to examine', () => {
    expect(lambdaLoop(script)).not.toBe('');
  });

  it('leaves no way to finish green after a function failed to deploy', () => {
    expect(silentFailures(script)).toEqual([]);
  });

  it('waits for each function to become active, as both CD workflows do', () => {
    expect(lambdaLoop(script)).toMatch(/aws lambda wait function-updated-v2/u);
  });

  it('proves the API is serving before it calls the deploy complete', () => {
    // The last `done` is the Lambda loop's; the last `complete!` is the line
    // the script ends on. Both are read from the end so a comment mentioning
    // either cannot stand in for the code.
    const tail = script.slice(script.lastIndexOf('\ndone'));
    expect(tail).toMatch(/curl[^\n]*\/health/u);
    expect(tail.search(/curl[^\n]*\/health/u)).toBeLessThan(tail.lastIndexOf('complete!'));
  });

  it('does not --delete the hashed assets an open tab is still using', () => {
    const sync = immutableAssetSync(script);
    expect(sync).not.toBe('');
    expect(sync).not.toMatch(/--delete/u);
  });

  it('is not vacuous: every rule rejects the text it replaced', () => {
    const before = [
      'HANDLERS=(auth plants)',
      'for handler in "${HANDLERS[@]}"; do',
      '    if [[ ! -f "$SRC" ]]; then',
      '        echo "  Skipping ${handler}: ${SRC} not found"',
      '        continue',
      '    fi',
      '    if PUBLISHED_VER=$(aws lambda update-function-code \\',
      "        --publish --query 'Version' --output text 2>/dev/null); then",
      '        echo "  ✓ ${FUNCTION_NAME} (v${PUBLISHED_VER})"',
      '    else',
      '        echo "  ✗ ${FUNCTION_NAME} (not found or update failed)"',
      '        continue',
      '    fi',
      '    aws s3 cp "$ZIP" \\',
      '        "s3://${ARTIFACT_BUCKET}/lambda-versions/${handler}-v${PUBLISHED_VER}.zip" \\',
      '        --region us-east-1 --only-show-errors || true',
      'done',
      '',
      'echo "Deployment to $ENVIRONMENT complete!"',
    ].join('\n');

    expect(silentFailures(before)).toEqual([
      'the Lambda update discards stderr, so a failure cannot say why',
      'the rollback archive is wrapped in `|| true`',
      'a missing bundle is skipped rather than recorded as a failure',
      'nothing accumulates the functions that did not deploy',
    ]);

    // And the rules read code, not prose: a comment that merely NAMES the old
    // shapes must report nothing.
    const commentsOnly = [
      'HANDLERS=(auth plants)',
      'for handler in "${HANDLERS[@]}"; do',
      '    # this used to print "Skipping" and used 2>/dev/null on',
      '    # update-function-code, and the lambda-versions archive ended in || true',
      '    :',
      'done',
      'FAILED_HANDLERS=()',
      'if [[ ${#FAILED_HANDLERS[@]} -gt 0 ]]; then exit 1; fi',
    ].join('\n');
    expect(silentFailures(commentsOnly)).toEqual([]);

    const oldSync = [
      'aws s3 sync frontend/dist "s3://${FRONTEND_BUCKET}" \\',
      '    --delete \\',
      '    --cache-control "max-age=31536000,public" \\',
      '    --exclude "*.html"',
      '',
    ].join('\n');
    expect(immutableAssetSync(oldSync)).toMatch(/--delete/u);
  });
});
