/**
 * Regression guard: the dev server must import with NO AWS environment set.
 *
 * `utils/dynamodb.ts` calls `requireEnv('TABLE_NAME')` at module scope and
 * throws when it is missing. `local-server.ts` is a self-contained in-memory
 * mock that never talks to DynamoDB — but it does import constants and schemas
 * from the shared modules, and importing ONE that transitively reaches
 * `utils/dynamodb.ts` takes the whole server down at startup with
 * "Missing required environment variable: TABLE_NAME", before it can answer
 * /health. Every Playwright E2E run then fails at `webServer` timeout, which
 * reads like a flaky browser test rather than an import that should not exist.
 *
 * That happened while wiring the kiosk routes (a `./services/kioskService.js`
 * import for four constants), which is why the constants now live in
 * `models/kiosk.ts`. This test spawns a real child process with the AWS
 * variables stripped so the next such import fails here, in seconds, instead
 * of in the E2E job twenty minutes later.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

/** npm workspaces hoist tsx to the repo root, but a future layout could keep
 *  it local — resolve both rather than pinning one. */
function tsxCli(): string {
  const candidates = [
    path.join(BACKEND_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`tsx CLI not found in: ${candidates.join(', ')}`);
  return found;
}

describe('local-server import purity', () => {
  it('imports with TABLE_NAME and the AWS environment unset', async () => {
    const env = { ...process.env };
    // The variables `requireEnv` guards, plus the ones a stray AWS client
    // import would want. A dev server must need none of them.
    for (const key of [
      'TABLE_NAME',
      'COGNITO_USER_POOL_ID',
      'COGNITO_CLIENT_ID',
      'IMAGES_BUCKET',
    ]) {
      delete env[key];
    }
    env.NODE_ENV = 'development';

    const entry = path.join(BACKEND_ROOT, 'src', 'local-server.ts');
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        tsxCli(),
        '-e',
        `import(${JSON.stringify(entry)}).then(() => { console.log('IMPORT_OK'); process.exit(0); });`,
      ],
      { cwd: BACKEND_ROOT, env, timeout: 60_000 }
    );

    expect(stdout).toContain('IMPORT_OK');
  }, 70_000);

  it('proves the guard bites: a service that reaches utils/dynamodb DOES fail', async () => {
    // Without this the test above could pass vacuously (e.g. if the child
    // inherited TABLE_NAME after all). Importing a real service under the
    // same stripped environment must fail, which is exactly the failure the
    // dev server must never inherit.
    const env = { ...process.env };
    delete env.TABLE_NAME;
    env.NODE_ENV = 'development';

    const entry = path.join(BACKEND_ROOT, 'src', 'services', 'kioskService.ts');
    await expect(
      execFileAsync(
        process.execPath,
        [
          tsxCli(),
          '-e',
          `import(${JSON.stringify(entry)}).then(() => { console.log('IMPORT_OK'); process.exit(0); });`,
        ],
        { cwd: BACKEND_ROOT, env, timeout: 60_000 }
      )
    ).rejects.toThrow(/TABLE_NAME/);
  }, 70_000);
});
