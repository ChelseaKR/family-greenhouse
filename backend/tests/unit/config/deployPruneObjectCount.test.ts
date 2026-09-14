/**
 * The production prune step must not count the bucket with a JMESPath
 * aggregate.
 *
 * ## What went wrong
 *
 * `cd-production.yml`'s "Prune superseded assets past the grace period" step
 * guards itself against deleting the live site: it refuses when the prune list
 * covers more than half the bucket. That guard needs a total, and the total was
 *
 *     total=$(aws s3api list-objects-v2 --bucket "$B" \
 *       --query 'length(Contents)' --output text)
 *
 * The AWS CLI paginates `list-objects-v2` at 1,000 keys and applies `--query`
 * to **each page**, concatenating the results. A filter or a projection
 * survives that: every page contributes its own rows. An aggregate does not —
 * past 1,000 objects this prints one count per page, so `total` becomes
 * `"1000\n523"` and the guard evaluates `$(( 1000\n523 / 2 ))`.
 *
 * Under the step's own `set -euo pipefail` that bash arithmetic error fails the
 * step. The consequences run downhill from there and none of them mentions
 * pagination: `deploy-frontend` fails, `smoke-tests` (which needs it) is
 * skipped, and the `rollback` job fires on any smoke result that is not
 * `success`. So a release that was fine — already synced to S3 by the step
 * above — is reverted, and the run reports a deployment failure.
 *
 * The trigger is the object count alone. The asset sync deliberately no longer
 * passes `--delete`, and this prune only removes objects that are both absent
 * from the build and older than the grace period, so the bucket grows with
 * every release and crosses 1,000 on a date nobody chooses.
 *
 * This is the second instance of the same trap in this file. The first broke
 * the v0.23.4 deploy through `list-versions-by-function`, whose `max_by(...)`
 * returned one maximum per page; the comment there still explains why
 * `| sort -n | tail -1` is load-bearing. That one was found by a deploy
 * failing. This test is so the third one is found here.
 *
 * ## Why a test rather than only a fix
 *
 * The fix is one step of one workflow, and nothing else in the repository would
 * notice it being written back the old way — the step runs only on a `v*` tag,
 * against a bucket whose size decides whether it misbehaves. `deployPrune`
 * below is a pure function of the workflow text, so it is exercised here
 * against the text that MUST be rejected as well as against the committed one.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../../', import.meta.url);
const WORKFLOW = new URL('.github/workflows/cd-production.yml', ROOT);

const PRUNE_STEP = 'Prune superseded assets past the grace period';

/**
 * JMESPath functions that collapse a page of results into a single value, and
 * are therefore wrong against a paginated listing: the CLI emits one value per
 * page and the shell sees them all.
 */
const AGGREGATE = /\b(length|sum|avg|max|min|max_by|min_by)\s*\(/g;

/** The body of one `- name:` step, from its header to the next step's. */
export function stepBody(workflow: string, name: string): string | null {
  const header = workflow.indexOf(`- name: ${name}`);
  if (header === -1) return null;
  const rest = workflow.slice(header + 1);
  const next = rest.search(/\n {6}- name: /u);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Every `--query` in `body` that asks for an aggregate. */
export function aggregateQueries(body: string): string[] {
  const found: string[] = [];
  for (const line of body.split('\n')) {
    if (!/--query/u.test(line) && !/^\s*--query/u.test(line)) continue;
    AGGREGATE.lastIndex = 0;
    if (AGGREGATE.test(line)) found.push(line.trim());
  }
  return found;
}

const workflow = readFileSync(WORKFLOW, 'utf8');

describe('the production prune step counts the bucket safely', () => {
  it('still has the step this test is about', () => {
    expect(stepBody(workflow, PRUNE_STEP)).not.toBeNull();
  });

  it('asks for no aggregate that pagination would repeat', () => {
    expect(aggregateQueries(stepBody(workflow, PRUNE_STEP) as string)).toEqual([]);
  });

  it('derives the total from the listing it already fetched', () => {
    const body = stepBody(workflow, PRUNE_STEP) as string;
    // A line count is one integer however many pages the listing took.
    expect(body).toMatch(/total=\$\(wc -l < \/tmp\/objects\.tsv[^)]*\)/u);
    expect(body).toMatch(/aws s3api list-objects-v2[\s\S]*?--output text > \/tmp\/objects\.tsv/u);
  });

  it('refuses a listing that came back empty instead of dividing by it', () => {
    const body = stepBody(workflow, PRUNE_STEP) as string;
    expect(body).toMatch(/if \[ "\$total" -eq 0 \]/u);
  });

  it('is not vacuous: the rule rejects the text this replaced', () => {
    const beforeTheFix = [
      '- name: Prune superseded assets past the grace period',
      '        run: |',
      '          set -euo pipefail',
      '          total=$(aws s3api list-objects-v2 --bucket "${FRONTEND_BUCKET}" \\',
      "            --query 'length(Contents)' --output text)",
      '          if [ "$count" -gt $(( total / 2 )) ]; then',
      '            exit 1',
      '          fi',
    ].join('\n');

    const body = stepBody(beforeTheFix, PRUNE_STEP) as string;
    expect(body).not.toBeNull();
    expect(aggregateQueries(body)).toEqual(["--query 'length(Contents)' --output text)"]);
  });

  it('is about a real consequence: bash cannot divide a multi-page count', () => {
    // Exactly what the guard did with a two-page `length(Contents)`. Run as its
    // own shell so the failure is observed rather than described.
    const script = 'set -euo pipefail; total=$(printf "1000\\n523\\n"); echo $(( total / 2 ))';
    let failed = false;
    let message = '';
    try {
      execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      failed = true;
      message = String((err as { stderr?: string }).stderr ?? '');
    }
    expect(failed).toBe(true);
    expect(message).toMatch(/arithmetic|syntax error/iu);
  });
});
