import * as esbuild from 'esbuild';
import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

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

const handlersDir = 'src/handlers';
const handlers = findHandlers(handlersDir);

// Create entry points
const entryPoints = {};
for (const handler of handlers) {
  const relativePath = relative(handlersDir, handler);
  const name = relativePath.replace(/\/handler\.ts$/, '').replace(/\//g, '-');
  entryPoints[name] = handler;
}

// Streaming chat entry point. NOT named handler.ts (it must not be picked up
// by the router-group convention above — it's a standalone Lambda behind a
// Function URL), so it's registered explicitly. Emits dist/chat-stream.js;
// the CD pipeline zips it as handler.mjs like every other bundle, so the
// Lambda's handler string stays "handler.handler".
entryPoints['chat-stream'] = join(handlersDir, 'chat', 'streamHandler.ts');

await esbuild.build({
  entryPoints,
  bundle: true,
  minify: true,
  sourcemap: true,
  platform: 'node',
  target: 'node20',
  outdir: 'dist',
  format: 'esm',
  // No `external` list: the AWS SDK v3 clients are bundled deliberately.
  // Bundling beats the runtime-provided SDK on cold start (no node_modules
  // resolution at init) and pins the exact versions we tested against.
  banner: {
    js: `
      import { createRequire } from 'module';
      const require = createRequire(import.meta.url);
    `,
  },
});

console.log('Build complete!');
