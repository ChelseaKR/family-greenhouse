// The Lambda bundle recipe, split out of esbuild.config.js so a test can build
// exactly what the deploy builds (tests/unit/bundles/lambdaBundles.test.ts)
// instead of re-stating the options and drifting from them.
import { readdirSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

// Resolved from this file, not the working directory, so a test running from
// anywhere builds the same set the deploy does.
export const backendDir = dirname(fileURLToPath(import.meta.url));

// Find all handler files
function findHandlers(dir, handlers = []) {
  const files = readdirSync(dir);

  for (const file of files) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);

    if (stat.isDirectory()) {
      findHandlers(filePath, handlers);
    } else if (file === 'handler.ts') {
      handlers.push(filePath);
    }
  }

  return handlers;
}

const handlersDir = join(backendDir, 'src', 'handlers');

/**
 * `{ bundleName: sourcePath }` for every Lambda the deploy ships. Paths are
 * relative to `backendDir` (esbuild's `absWorkingDir` for a caller not running
 * from there).
 */
export function lambdaEntryPoints() {
  const handlers = findHandlers(handlersDir);

  // Create entry points
  const entryPoints = {};
  for (const handler of handlers) {
    const relativePath = relative(handlersDir, handler);
    const name = relativePath.replace(/\/handler\.ts$/, '').replace(/\//g, '-');
    entryPoints[name] = relative(backendDir, handler);
  }

  // Streaming chat entry point. NOT named handler.ts (it must not be picked up
  // by the router-group convention above — it's a standalone Lambda behind a
  // Function URL), so it's registered explicitly. Emits dist/chat-stream.js;
  // the CD pipeline zips it as handler.mjs like every other bundle, so the
  // Lambda's handler string stays "handler.handler".
  entryPoints['chat-stream'] = join('src', 'handlers', 'chat', 'streamHandler.ts');

  return entryPoints;
}

/** Everything except `entryPoints` and `outdir`, which callers choose. */
export const lambdaBundleOptions = {
  bundle: true,
  minify: true,
  sourcemap: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // Resolve a package's ESM build (`module`) before its CommonJS one (`main`).
  //
  // esbuild's default for `platform: 'node'` is ['main', 'module'], which
  // picks the CJS build of every dual-published package that has no `exports`
  // map — and a CJS build cannot be tree-shaken. That is where the size was:
  // each AWS SDK v3 client shipped in full, every command class it defines,
  // whether or not this code ever sends it (the SSM client alone was 201 KB
  // of the plants bundle for the two commands it uses). With the ESM builds
  // esbuild keeps only what is reachable. Measured 2026-09-19 on the same
  // source: api 2,126,501 -> 1,766,339 bytes, plants 2,463,689 -> 1,959,879,
  // and the time to import the bundle in a fresh Node process (the part of a
  // cold start this code controls) fell about 21% for api and 35% for plants.
  // Packages with an `exports` map are unaffected; this only changes which
  // file esbuild reads, not what the code does.
  mainFields: ['module', 'main'],
  // No `external` list: the AWS SDK v3 clients are bundled deliberately.
  // Bundling beats the runtime-provided SDK on cold start (no node_modules
  // resolution at init) and pins the exact versions we tested against.
  banner: {
    js: `
      import { createRequire } from 'module';
      const require = createRequire(import.meta.url);
    `,
  },
};
