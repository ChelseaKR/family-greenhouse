import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { navigateTo, provisionAccount, uiLogin, ProvisionedAccount } from './helpers';

const VALID_PNG = readFileSync(new URL('../../public/brand/favicon-32x32.png', import.meta.url));

/**
 * Smoke test for the write-side path that's regression-prone: pick a species
 * from the combobox, save a plant, see it land on the plants page. The
 * existing happy-path covers "login + read"; this complements it with
 * "login + write" so a broken AddPlantPage is caught in CI.
 *
 * Uses a freshly provisioned account (the shared seed household's Seedling
 * plan caps out at 10 plants when every browser project creates plants
 * against it); the dev server is started by the Playwright webServer
 * config so no external setup is required.
 */
let account: ProvisionedAccount;

test.beforeAll(async () => {
  account = await provisionAccount({ emailPrefix: 'create-plant' });
});

test.describe('Create plant flow', () => {
  // Workbox can claim WebKit pages before or between the synthetic failed PUT
  // and its retry. Playwright cannot intercept service-worker-owned requests,
  // so block it here; this spec exercises creation/upload recovery, not the SW.
  test.use({ serviceWorkers: 'block' });

  test('login → add plant → see it on the plants page', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await uiLogin(page, account.email, account.password);

    // The "Add plant" affordance lives on the plants page. Mobile-aware:
    // opens the sidebar drawer first on small viewports.
    await navigateTo(page, /^plants$/i, /\/plants$/);
    await page.getByRole('link', { name: /add plant/i }).click();
    await expect(page).toHaveURL(/\/plants\/new/);

    // Use a uniquely-named plant so re-runs against a sticky local server
    // don't collide and produce ambiguous selectors.
    const uniqueName = `Monstera ${Date.now()}`;
    await page.getByLabel(/plant name/i).fill(uniqueName);
    await page.getByLabel(/species/i).fill('Monstera deliciosa');

    const autoTasks = page.getByRole('checkbox', {
      name: /automatically add recommended care tasks/i,
    });
    await expect(autoTasks).toBeChecked();
    await expect(page.getByLabel('Recommended care tasks', { exact: true })).toContainText(
      'Water every 7 days'
    );

    await page.getByRole('button', { name: /add plant/i }).click();

    // After save we should land on the new plant's detail page.
    await expect(page.getByRole('heading', { name: uniqueName })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Every 7 days')).toBeVisible();
    await expect(page.getByText('Every 30 days')).toBeVisible();
    await expect(page.getByText('Every 90 days')).toBeVisible();

    // No JS errors thrown during the round-trip.
    expect(consoleErrors).toEqual([]);
  });

  test('failed creation photo resumes on the saved plant through real PUT, confirm, and display', async ({
    page,
  }) => {
    await uiLogin(page, account.email, account.password);
    // Link navigation is covered by the happy-path test above. Enter directly
    // here so this recovery contract is isolated from responsive nav timing.
    await page.goto('/plants/new');
    await expect(page.getByRole('heading', { name: /add a new plant/i })).toBeVisible();

    let createRequests = 0;
    let putAttempts = 0;
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.pathname === '/plants') createRequests += 1;
    });
    await page.route('**/mock-upload/*', async (route) => {
      // The local object store is cross-origin, so WebKit may send an OPTIONS
      // preflight through this route before the upload. Only PUTs are upload
      // attempts; let CORS preflights reach the backend unchanged.
      if (route.request().method() !== 'PUT') {
        await route.continue();
        return;
      }

      putAttempts += 1;
      if (putAttempts === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Injected first-upload failure' }),
        });
        return;
      }
      await route.continue();
    });

    const uniqueName = `Upload Recovery Fern ${Date.now()}`;
    const photo = {
      name: 'recovery-fern.png',
      mimeType: 'image/png',
      // Known-good repository PNG: the browser really decodes and, where supported,
      // downscales/re-encodes it before the local object-store PUT.
      buffer: VALID_PNG,
    };
    await page.getByLabel(/choose a photo/i).setInputFiles(photo);
    await expect(page.getByRole('img', { name: /selected plant photo preview/i })).toBeVisible();
    await page.getByLabel(/plant name/i).fill(uniqueName);
    await page.getByRole('button', { name: /add plant/i }).click();

    // The plant POST committed before the injected upload failure. Recovery
    // lands on that exact record and replaces the submitted /plants/new entry.
    await expect(page).toHaveURL(/\/plants\/[^/]+$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: uniqueName })).toBeVisible();
    // `variant="info"` — the plant DID save, so the recovery notice is
    // announced politely (role="status") rather than interrupting whatever the
    // screen reader is mid-sentence on. See components/Alert.tsx.
    await expect(page.getByRole('status')).toContainText('Plant saved; photo not uploaded');
    expect(createRequests).toBe(1);
    expect(putAttempts).toBe(1);

    const realPut = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname.startsWith('/mock-upload/') &&
        response.status() === 200
    );
    const confirm = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/plants\/[^/]+\/image\/confirm$/.test(new URL(response.url()).pathname) &&
        response.ok()
    );
    const displayedBytes = page.waitForResponse(
      (response) =>
        response.request().resourceType() === 'image' &&
        new URL(response.url()).pathname.startsWith('/mock-images/') &&
        response.ok()
    );

    // Retrying is now an image-only operation on PlantDetailPage; it cannot
    // POST another plant.
    await page.getByLabel(/upload photo/i).setInputFiles(photo);
    const putResponse = await realPut;
    const confirmResponse = await confirm;
    const imageResponse = await displayedBytes;
    expect(putResponse.status()).toBe(200);
    expect(confirmResponse.status()).toBe(200);
    expect(imageResponse.headers()['content-type']).toMatch(/^image\//);
    expect(Number(imageResponse.headers()['content-length'] ?? 0)).toBeGreaterThan(0);

    const renderedPhoto = page.getByRole('img', { name: `Photo of ${uniqueName}` });
    await expect(renderedPhoto).toBeVisible();
    await expect
      .poll(() => renderedPhoto.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    await expect(page.getByText('Plant saved; photo not uploaded')).toBeHidden();
    expect(createRequests).toBe(1);
    expect(putAttempts).toBe(2);
  });
});
