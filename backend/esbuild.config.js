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

await esbuild.build({
  entryPoints,
  bundle: true,
  minify: true,
  sourcemap: true,
  platform: 'node',
  target: 'node20',
  outdir: 'dist',
  format: 'esm',
  external: [
    '@aws-sdk/client-dynamodb',
    '@aws-sdk/lib-dynamodb',
    '@aws-sdk/client-cognito-identity-provider',
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
  ],
  banner: {
    js: `
      import { createRequire } from 'module';
      const require = createRequire(import.meta.url);
    `,
  },
});

console.log('Build complete!');
