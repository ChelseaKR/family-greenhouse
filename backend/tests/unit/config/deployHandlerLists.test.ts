/**
 * Every Lambda that Terraform creates must get its code from every deploy path.
 *
 * Terraform creates each function in `lambda_handlers` (plus `chat_stream`)
 * with a 192-byte `placeholder.zip` and ignores code changes after that. The
 * real code arrives only from the deploy loops, which name the functions in
 * hard-coded lists. When a function is missing from those lists, nothing fails:
 * Terraform is happy, the deploy is green, and the function keeps answering
 * every request with the placeholder's error.
 *
 * Measured, not hypothetical: `plantTags` (#424, v0.24.0, 2026-09-04) was never
 * added to the lists, so `family-greenhouse-plantTags-production` still ran the
 * placeholder on 2026-10-04 (CodeSize 192) and `GET /tag/<token>` answered 500
 * in production. All six plant-tag routes were down for a month.
 *
 * So the lists are pinned to Terraform here, in both directions: a function
 * Terraform defines but a loop skips fails, and so does a loop entry with no
 * Terraform function behind it. The negative control asserts its sabotage
 * changed the text before asserting the check notices.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repositoryRoot = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repositoryRoot), 'utf8');

/** The keys of `locals.lambda_handlers` in the api module, plus chat-stream. */
function terraformFunctions(apiModule: string): string[] {
  const block = /lambda_handlers = \{\n([\s\S]*?)\n {2}\}/.exec(apiModule);
  if (!block) throw new Error('lambda_handlers block not found in the api module');
  const keys = [...block[1].matchAll(/^\s*"([A-Za-z-]+)"\s*=/gm)].map((m) => m[1]);
  // chat_stream is its own resource (a Function URL Lambda), not a map entry.
  expect(apiModule).toMatch(
    /resource "aws_lambda_function" "chat_stream"[\s\S]*?function_name = "\$\{var\.project_name\}-chat-stream-\$\{var\.environment\}"/
  );
  return [...keys, 'chat-stream'].sort();
}

/** Every `for handler in …; do` list in a workflow. */
function workflowLoops(workflow: string): string[][] {
  return [...workflow.matchAll(/for handler in ([^\n;]*); do/g)].map((m) =>
    m[1].trim().split(/\s+/).sort()
  );
}

function deployScriptHandlers(script: string): string[] {
  const match = /^HANDLERS=\(([^)]*)\)/m.exec(script);
  if (!match) throw new Error('HANDLERS=(…) not found in scripts/deploy.sh');
  return match[1].trim().split(/\s+/).sort();
}

const apiModule = read('infrastructure/modules/api/main.tf');
const expected = terraformFunctions(apiModule);

describe('deploy handler lists match the Lambdas Terraform defines', () => {
  it('reads a plausible Terraform fleet, plantTags included', () => {
    expect(expected.length).toBeGreaterThanOrEqual(19);
    expect(expected).toContain('plantTags');
    expect(expected).toContain('chat-stream');
  });

  it('cd-production deploys and snapshots exactly those functions', () => {
    const loops = workflowLoops(read('.github/workflows/cd-production.yml'));
    // The rollback capture and the deploy itself.
    expect(loops).toHaveLength(2);
    for (const loop of loops) expect(loop).toEqual(expected);
  });

  it('cd-staging deploys exactly those functions', () => {
    const loops = workflowLoops(read('.github/workflows/cd-staging.yml'));
    expect(loops.length).toBeGreaterThan(0);
    for (const loop of loops) expect(loop).toEqual(expected);
  });

  it('scripts/deploy.sh deploys exactly those functions', () => {
    expect(deployScriptHandlers(read('scripts/deploy.sh'))).toEqual(expected);
  });

  it('every listed function has a backend bundle (an esbuild entry)', () => {
    for (const name of expected) {
      if (name === 'chat-stream') continue; // registered explicitly in esbuild.config.js
      expect(() => read(`backend/src/handlers/${name}/handler.ts`), name).not.toThrow();
    }
    expect(read('backend/esbuild.config.js')).toMatch(/entryPoints\['chat-stream'\]/);
  });

  it('negative control: a loop without plantTags fails the comparison', () => {
    const workflow = read('.github/workflows/cd-production.yml');
    const sabotaged = workflow.replace(/(for handler in [^\n;]*?) plantTags\b/, '$1');
    expect(sabotaged, 'the sabotage must remove plantTags from a loop').not.toBe(workflow);
    const loops = workflowLoops(sabotaged);
    expect(loops.some((loop) => !loop.includes('plantTags'))).toBe(true);
    expect(() => {
      for (const loop of loops) expect(loop).toEqual(expected);
    }).toThrow();
  });
});
