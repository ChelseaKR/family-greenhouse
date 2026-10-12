#!/usr/bin/env node
/**
 * Screenshot every rendered email, in light and in dark mode, at desktop and
 * phone widths.
 *
 * `tests/unit/services/email/renderedEmails.test.ts` writes every email the
 * product sends — welcome, weekly digest, year recap and the daily reminder,
 * in both languages — to `backend/test-output/email/*.html` (git-ignored)
 * and checks each one for validity, size and links. This script opens those
 * files in headless Chromium and saves `<name>.light.png`, `<name>.dark.png`
 * and `<name>.phone.png` beside them, so a reviewer can look at the result
 * without sending anything.
 *
 *   npm run email:preview -w backend
 *
 * It uses `playwright-core` from the repo root (the frontend's e2e suite
 * installs the browser); it is not part of the gate, because a screenshot
 * is something a person looks at, not something a test can judge.
 *
 * The logo loads from `FRONTEND_URL` as the test set it, so the header shows
 * the real file only when that origin is reachable from this machine; with
 * images blocked the alt text is what you see, which is also worth seeing.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test-output', 'email');

const VIEWS = [
  { name: 'light', colorScheme: 'light', width: 720 },
  { name: 'dark', colorScheme: 'dark', width: 720 },
  { name: 'phone', colorScheme: 'light', width: 390 },
];

async function main() {
  if (!existsSync(OUT_DIR)) {
    console.error(
      `email-previews: ${OUT_DIR} does not exist. Run the renderer first:\n` +
        '  npx vitest run tests/unit/services/email/renderedEmails.test.ts'
    );
    process.exitCode = 1;
    return;
  }
  const files = readdirSync(OUT_DIR)
    .filter((name) => name.endsWith('.html'))
    .sort();
  if (files.length === 0) {
    console.error(`email-previews: no .html files in ${OUT_DIR}`);
    process.exitCode = 1;
    return;
  }

  const browser = await chromium.launch();
  try {
    for (const file of files) {
      const base = file.replace(/\.html$/u, '');
      for (const view of VIEWS) {
        const context = await browser.newContext({
          colorScheme: view.colorScheme,
          viewport: { width: view.width, height: 900 },
          deviceScaleFactor: 2,
        });
        const page = await context.newPage();
        await page.goto(`file://${join(OUT_DIR, file)}`, { waitUntil: 'load' });
        const target = join(OUT_DIR, `${base}.${view.name}.png`);
        await page.screenshot({ path: target, fullPage: true });
        await context.close();
        console.log(`email-previews: wrote ${target}`);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`email-previews: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
