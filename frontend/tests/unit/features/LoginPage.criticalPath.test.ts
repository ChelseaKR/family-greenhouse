import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// zod plus its resolver is ~36 kB compressed. As a static import of LoginPage
// it sat on the /login critical path and pushed mobile LCP past the
// Lighthouse ceiling (lighthouserc.mobile.cjs) after the zod 4.6.7 bump. The
// schema now lives in loginSchema.ts and is imported on demand; this keeps a
// later edit from quietly putting it back on the first-paint path.
const source = readFileSync(resolve(__dirname, '../../../src/features/auth/LoginPage.tsx'), 'utf8');

const staticImports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gms)];

describe('LoginPage critical path', () => {
  it('has static imports to check', () => {
    expect(staticImports.length).toBeGreaterThan(5);
  });

  it('does not statically import zod or its resolver', () => {
    const offenders = staticImports
      .filter(([, typeOnly]) => !typeOnly)
      .map(([, , from]) => from)
      .filter(
        (from) =>
          from === 'zod' || from.startsWith('@hookform/resolvers') || from === './loginSchema'
      );
    expect(offenders).toEqual([]);
  });

  it('loads the schema module on demand', () => {
    expect(source).toMatch(/import\('\.\/loginSchema'\)/);
  });
});
