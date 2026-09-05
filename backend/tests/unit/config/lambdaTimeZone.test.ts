import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repositoryRoot = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repositoryRoot), 'utf8');

/**
 * The zone the backend Lambdas run in is load-bearing, and until #590 it was
 * nobody's decision.
 *
 * `getDailyCompletionCounts` (services/taskService.ts) builds its day buckets
 * from a LOCAL midnight, stringifies them through a UTC formatter, and matches
 * completions keyed by a UTC date. Those calendars name the same day only
 * under UTC. When they disagree nothing raises: the unmatched day keeps its
 * zero-fill and is published as a real count of zero in the analytics chart
 * and in the weekly digest — a day the query could not see, rendered as a
 * measurement. `completeTask`'s next-due arithmetic and
 * `doubleCareRules.nextDueAfterMatch` read the process zone too.
 *
 * That held because AWS defaults the Lambda execution environment to UTC, not
 * because this repository asked for it: `grep -rn TZ infrastructure/` returned
 * nothing. Three comments ASSERTED the dependency and none CREATED it, so a
 * runtime bump, a base-image change or a future platform default would have
 * moved it with nothing failing.
 *
 * ## Why this is a config test and not a runtime one
 *
 * No unit test can observe the deployed zone by running. `vitest.config.ts`
 * sets `process.env.TZ ??= 'UTC'` in this very process, so the suite's own
 * zone is pinned by the suite — and even without that pin, a test process's
 * zone says nothing about a Lambda's. Before #590 the only assertion available
 * was that `infrastructure/` says nothing about `TZ`, which asserts an absence,
 * not a correctness.
 *
 * What a test CAN observe is the deployment configuration, which is what this
 * file reads — the same approach as every other test in this directory. The
 * assumption is now stated in one place, mirrored in one place, and checked
 * here that the two agree.
 */
describe('lambda process timezone', () => {
  const apiModule = read('infrastructure/modules/api/main.tf');
  const backendVitestConfig = read('backend/vitest.config.ts');

  /** The body of a `name = { … }` local, sliced to its closing brace. */
  const localBlock = (terraform: string, name: string): string => {
    const start = terraform.indexOf(`${name} = {`);
    expect(start, `local.${name} not found in the api module`).toBeGreaterThan(-1);
    const end = terraform.indexOf('\n  }', start);
    expect(end, `local.${name} has no closing brace at the expected indent`).toBeGreaterThan(start);
    return terraform.slice(start, end);
  };

  it('pins TZ explicitly on the environment shared by every backend Lambda', () => {
    // In `local.lambda_environment` specifically. A `TZ` set on one handler's
    // integration environment would leave the others inheriting the default,
    // which is the state #590 is about.
    expect(localBlock(apiModule, 'lambda_environment')).toMatch(/^\s*TZ\s*=\s*"UTC"$/m);
  });

  it('carries that environment to both Lambda resources in the module', () => {
    // The fleet, via handler_environments…
    expect(apiModule).toMatch(/handler => merge\(\s*local\.lambda_environment,/);
    expect(apiModule).toMatch(/variables = local\.handler_environments\[each\.key\]/);
    // …and the standalone streaming function, which is not part of the fleet.
    expect(apiModule).toMatch(/chat_stream_environment = merge\(\s*local\.lambda_environment,/);
    expect(apiModule).toMatch(/variables = local\.chat_stream_environment/);

    // A THIRD Lambda added to this module would run whatever zone it inherits
    // unless it merges the shared local too. Counting them is what makes this
    // test notice one, rather than silently continuing to check the two that
    // were here when it was written.
    const lambdaResources = apiModule.match(/^resource "aws_lambda_function" "/gm) ?? [];
    expect(
      lambdaResources,
      'a Lambda was added to modules/api — merge local.lambda_environment into its ' +
        'environment (or say why its zone does not matter) and update this count'
    ).toHaveLength(2);
  });

  it('runs the backend suite in the same zone the Lambdas are pinned to', () => {
    // `??=`, not `=`: this pins the TEST PROCESS, a different fact from the
    // Lambdas' zone, and an explicitly exported TZ still wins so a
    // zone-specific failure can be reproduced. See the comment on the line.
    expect(backendVitestConfig).toContain("process.env.TZ ??= 'UTC';");

    // The two halves used to agree by coincidence. Assert the link.
    const deployed = localBlock(apiModule, 'lambda_environment').match(/^\s*TZ\s*=\s*"([^"]+)"$/m);
    const suite = backendVitestConfig.match(/process\.env\.TZ \?\?= '([^']+)';/);
    expect(deployed?.[1]).toBeTruthy();
    expect(suite?.[1]).toBe(deployed?.[1]);
  });
});
