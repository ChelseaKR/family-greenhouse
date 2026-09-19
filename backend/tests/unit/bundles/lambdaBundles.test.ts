/**
 * The Lambda bundles, built exactly as the deploy builds them
 * (`esbuild.config.js` and this test both read `esbuild.options.js`).
 *
 * Why a unit test owns this. A Lambda's cold start is, first, the time to parse
 * and evaluate its bundle, and the bytes in it are the one part of that this
 * repository controls (issue #730). Nothing else looks at them: no other test
 * builds a bundle, and a bundle that fails only at load time — a dependency
 * whose ESM build cannot be evaluated — would otherwise first be seen by the
 * post-deploy smoke suite, after it had already replaced production.
 *
 * Three things are checked:
 *
 *   1. Every bundle stays under a byte budget. The budgets sit ~7% above the
 *      sizes measured on 2026-09-19 with `mainFields: ['module', 'main']`,
 *      which is more than routine dependency bumps move a bundle and less than
 *      the 8-30% that resolving the CommonJS builds again would add, so the
 *      regression this guards is the one that actually happened.
 *   2. Every bundle imports cleanly in a fresh Node process and exports a
 *      `handler`, which is what the runtime asks of it first.
 *   3. The `api` and `plants` bundles serve real requests through their own
 *      bundled AWS SDK code — a signed DynamoDB call, a presigned S3 URL —
 *      against a stand-in endpoint on localhost. Tree-shaking an SDK client
 *      down to the commands the code sends is the change in question, so what
 *      is proved is that the commands it kept are the ones it sends.
 *
 * Raising a budget is a decision, not a chore: say in the PR why the bundle
 * grew, the way `esbuild.options.js` says why it shrank.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The recipe is plain JS shared with the deploy build; it has no declaration file.
// @ts-expect-error TS7016
import { backendDir, lambdaBundleOptions, lambdaEntryPoints } from '../../../esbuild.options.js';

const BUILD_TIMEOUT_MS = 120_000;
const PROBE = fileURLToPath(new URL('./bundleProbe.mjs', import.meta.url));

/** Bytes. Measured 2026-09-19 (sourcemap off), then rounded up ~7% to the next 10 KB. */
const BUDGET_BYTES: Record<string, number> = {
  api: 1_900_000,
  apiKeys: 1_880_000,
  auth: 1_930_000,
  billing: 2_220_000,
  chat: 3_710_000,
  'chat-stream': 2_780_000,
  checkoutRecovery: 960_000,
  climate: 1_970_000,
  digests: 1_190_000,
  emailEvents: 550_000,
  emailReplies: 1_150_000,
  households: 2_400_000,
  me: 2_230_000,
  notifications: 2_280_000,
  plantTags: 1_900_000,
  plants: 2_100_000,
  reminders: 1_420_000,
  species: 1_970_000,
  tasks: 2_180_000,
};

// What `requireEnv` and the auth/CORS layers read at import time, as the deployed
// Lambdas have them. Values are placeholders; nothing here reaches a network.
const PROBE_ENV = {
  ...process.env,
  NODE_ENV: 'production',
  TZ: 'UTC',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  // Outside a Lambda there is no trace context for the X-Ray wrapper to find.
  AWS_XRAY_CONTEXT_MISSING: 'IGNORE_ERROR',
  LOG_LEVEL: 'silent',
  TABLE_NAME: 'bundle-probe-table',
  IMAGES_BUCKET: 'bundle-probe-images',
  COGNITO_USER_POOL_ID: 'us-east-1_probe',
  COGNITO_CLIENT_ID: 'probe',
  ALLOWED_ORIGIN: 'https://familygreenhouse.net',
  FRONTEND_URL: 'https://familygreenhouse.net',
  STRIPE_SECRET_KEY: 'sk_test_probe',
  STRIPE_WEBHOOK_SECRET: 'whsec_probe',
};
delete (PROBE_ENV as Record<string, unknown>).NODE_OPTIONS;

interface ProbeResult {
  handlerType: string;
  warmer?: number;
  preflight?: { status: number; allowOrigin?: string };
  health?: {
    status: number;
    body: { status: string; components: { database: { status: string } } };
  };
  upload?: { status: number; uploadUrl: string };
  seen?: Array<{ target: string; signed: boolean }>;
}

function probe(bundle: string, mode: 'load' | 'api' | 'plants'): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [PROBE, bundle, mode],
      { env: PROBE_ENV, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const line = stdout.split('\n').find((l) => l.startsWith('@@RESULT@@'));
        if (error || !line) {
          reject(new Error(`probe ${mode} ${bundle} failed: ${error?.message ?? ''}\n${stderr}`));
          return;
        }
        resolve(JSON.parse(line.slice('@@RESULT@@'.length)) as ProbeResult);
      }
    );
  });
}

describe('Lambda bundles', () => {
  let outdir: string;
  let names: string[];
  const sizes: Record<string, number> = {};

  beforeAll(async () => {
    outdir = mkdtempSync(join(tmpdir(), 'fg-bundles-'));
    const entryPoints = lambdaEntryPoints() as Record<string, string>;
    names = Object.keys(entryPoints).sort();
    await esbuild.build({
      ...lambdaBundleOptions,
      entryPoints,
      outdir,
      absWorkingDir: backendDir,
      // The deploy zips every bundle as handler.mjs; .mjs is what forces ESM
      // for a file that sits outside any package.json with "type": "module".
      outExtension: { '.js': '.mjs' },
      // Source maps do not change what is loaded and would only slow this build.
      sourcemap: false,
      logLevel: 'silent',
    });
    for (const name of names) sizes[name] = statSync(join(outdir, `${name}.mjs`)).size;
  }, BUILD_TIMEOUT_MS);

  afterAll(() => {
    if (outdir) rmSync(outdir, { recursive: true, force: true });
  });

  it('has a byte budget for every bundle, and only for bundles that exist', () => {
    expect(Object.keys(BUDGET_BYTES).sort()).toEqual(names);
  });

  it('keeps every bundle under its byte budget', () => {
    const over = names
      .filter((name) => sizes[name] > BUDGET_BYTES[name])
      .map((name) => `${name}: ${sizes[name]} > ${BUDGET_BYTES[name]}`);
    expect(over).toEqual([]);
  });

  it('resolves ESM builds first, so the AWS SDK clients can be tree-shaken', () => {
    expect(lambdaBundleOptions.mainFields).toEqual(['module', 'main']);
  });

  it(
    'imports every bundle cleanly and finds a handler in it',
    async () => {
      const results = await Promise.all(
        names.map((name) => probe(join(outdir, `${name}.mjs`), 'load'))
      );
      const broken = names.filter((_, i) => results[i].handlerType !== 'function');
      expect(broken).toEqual([]);
    },
    BUILD_TIMEOUT_MS
  );

  it(
    'serves the requests a page makes first from the api bundle, through its own SDK',
    async () => {
      const r = await probe(join(outdir, 'api.mjs'), 'api');
      expect(r.warmer).toBe(200);
      expect(r.preflight).toEqual({ status: 204, allowOrigin: 'https://familygreenhouse.net' });
      expect(r.health?.status).toBe(200);
      expect(r.health?.body.components.database.status).toBe('ok');
      // /health sent one GetItem and the SDK signed it: the serializer, the
      // signer and the retry stack all survived tree-shaking.
      expect(r.seen).toEqual([{ target: 'DynamoDB_20120810.GetItem', signed: true }]);
    },
    BUILD_TIMEOUT_MS
  );

  it(
    'presigns a photo upload URL from the plants bundle',
    async () => {
      const r = await probe(join(outdir, 'plants.mjs'), 'plants');
      expect(r.upload?.status).toBe(200);
      const url = new URL(r.upload!.uploadUrl);
      expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
      // The auth middleware's membership lookup went through the bundled
      // DynamoDB client and was signed.
      expect(r.seen?.length).toBeGreaterThan(0);
      expect(r.seen?.every((s) => s.signed)).toBe(true);
    },
    BUILD_TIMEOUT_MS
  );
});
