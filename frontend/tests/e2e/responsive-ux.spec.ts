import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { navigateTo, provisionAccount, uiLogin, type ProvisionedAccount } from './helpers';

const ENFORCED_A11Y_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const NARROW_PUBLIC_ROUTES = [
  '/',
  '/login',
  '/register',
  '/forgot-password',
  '/confirm-email',
  '/reset-password',
  '/join/not-a-real-invite',
  '/shared/not-a-real-share',
  '/sit/not-a-real-sitter-token',
  '/blog',
  '/blog/how-to-remember-to-water-plants',
  '/care',
  '/care/monstera',
  '/pet-safe',
  '/changelog',
  '/legal/privacy',
  '/legal/terms',
  '/status',
  '/pricing',
  '/this-route-does-not-exist',
] as const;

const AUTH_ROUTES = [
  { link: /^dashboard$/i, path: /\/dashboard$/ },
  { link: /^plants$/i, path: /\/plants$/ },
  { link: /^tasks$/i, path: /\/tasks$/ },
  { link: /^chat$/i, path: /\/chat$/ },
  { link: /^analytics$/i, path: /\/analytics$/ },
  { link: /^household$/i, path: /\/household$/ },
  { link: /^settings$/i, path: /\/settings$/ },
  { link: /^help$/i, path: /\/help$/ },
] as const;

async function expectNoDocumentOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const offenders = Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.position === 'fixed' || style.display === 'none') return false;
        const rect = element.getBoundingClientRect();
        return rect.right > viewportWidth + 1 || rect.left < -1;
      })
      .slice(0, 8)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        className: element.className.toString().slice(0, 120),
        text: element.textContent?.trim().slice(0, 60),
        rect: element.getBoundingClientRect().toJSON(),
      }));

    return {
      viewportWidth,
      documentWidth: document.documentElement.scrollWidth,
      offenders,
    };
  });

  expect(
    overflow.documentWidth,
    `${label} overflowed ${overflow.viewportWidth}px: ${JSON.stringify(overflow.offenders)}`
  ).toBeLessThanOrEqual(overflow.viewportWidth + 1);
}

async function expectMinimumControlTargets(page: Page, label: string) {
  const undersized = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('button, summary, input, select, textarea'))
      .filter((element) => {
        const style = getComputedStyle(element);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          element.closest('[aria-hidden="true"]') ||
          element.closest('[inert]')
        ) {
          return false;
        }
        if (
          element instanceof HTMLInputElement &&
          ['checkbox', 'radio'].includes(element.type) &&
          element.closest('label')
        ) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        if (
          element instanceof HTMLInputElement &&
          rect.width <= 1 &&
          rect.height <= 1 &&
          element.id &&
          document.querySelector(`label[for="${CSS.escape(element.id)}"]`)
        ) {
          return false;
        }
        return rect.width > 0 && rect.height > 0 && (rect.width < 24 || rect.height < 24);
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          label: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 60),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      })
  );

  expect(undersized, `${label} has undersized controls`).toEqual([]);
}

function captureBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

async function expectNoA11yViolations(page: Page, label: string) {
  await page.evaluate(async () => {
    const animations = document.getAnimations().filter((animation) => {
      const timing = animation.effect?.getComputedTiming();
      return animation.playState === 'running' && timing?.endTime !== Infinity;
    });
    await Promise.allSettled(animations.map((animation) => animation.finished));
  });
  const results = await new AxeBuilder({ page }).withTags(ENFORCED_A11Y_TAGS).analyze();
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target),
    })),
    `${label} has accessibility violations`
  ).toEqual([]);
}

let account: ProvisionedAccount;

test.beforeAll(async () => {
  account = await provisionAccount({
    emailPrefix: 'responsive-ux',
    plant: { name: 'Audit Monstera', species: 'Monstera deliciosa', location: 'Living Room' },
    waterTask: { frequency: 7 },
  });
});

test.describe('Mobile-first UX correctness', () => {
  test.describe.configure({ mode: 'serial' });

  test('all public surfaces reflow at 320px without document overflow', async ({ page }) => {
    const browserErrors = captureBrowserErrors(page);
    await page.setViewportSize({ width: 320, height: 700 });

    for (const route of NARROW_PUBLIC_ROUTES) {
      await page.goto(route);
      await page.locator('body').waitFor({ state: 'visible' });
      await expectNoDocumentOverflow(page, route);
      await expectMinimumControlTargets(page, route);
    }
    expect(browserErrors).toEqual([]);
  });

  for (const viewport of [
    { name: '320px', width: 320, height: 700 },
    { name: '390px', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'desktop', width: 1280, height: 800 },
  ] as const) {
    test(`authenticated shell and every primary route reflow at ${viewport.name}`, async ({
      page,
    }) => {
      const browserErrors = captureBrowserErrors(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await uiLogin(page, account.email, account.password);

      for (const route of AUTH_ROUTES) {
        if (!route.path.test(new URL(page.url()).pathname)) {
          await navigateTo(page, route.link, route.path);
        }
        await page.locator('main').waitFor({ state: 'visible' });
        await expectNoDocumentOverflow(page, `${viewport.name} ${route.path}`);
        await expectMinimumControlTargets(page, `${viewport.name} ${route.path}`);
      }

      if (viewport.width === 320) {
        for (const route of ['/plants/new', '/plants/import', '/welcome', '/onboarding?mode=add']) {
          await page.goto(route);
          await page.locator('body').waitFor({ state: 'visible' });
          await expectNoDocumentOverflow(page, `${viewport.name} ${route}`);
          await expectMinimumControlTargets(page, `${viewport.name} ${route}`);
        }
      }
      expect(browserErrors).toEqual([]);
    });
  }

  test('mobile plants header, task actions, settings navigation, and chat composer do not collide', async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ width: 320, height: 700 });
    await uiLogin(page, account.email, account.password);

    await navigateTo(page, /^plants$/i, /\/plants$/);
    const plantsHeading = page.getByRole('heading', { name: 'Plants', exact: true });
    await expect(plantsHeading).toBeVisible();
    const header = plantsHeading.locator('xpath=ancestor::header');
    await expect(header.getByRole('button', { name: /apply template/i })).toBeVisible();
    await expect(header.getByRole('button', { name: /add plant/i })).toBeVisible();
    await expectNoDocumentOverflow(page, 'plants header');

    await header.getByRole('button', { name: /apply template/i }).click();
    const templateDialog = page.getByRole('dialog', { name: /apply care template/i });
    await expect(
      templateDialog.getByRole('heading', { name: /apply care template/i })
    ).toBeVisible();
    await expectNoDocumentOverflow(page, 'apply template dialog');
    await expectMinimumControlTargets(page, 'apply template dialog');
    await expectNoA11yViolations(page, 'apply template dialog');
    await templateDialog.getByRole('button', { name: /^close$/i }).click();

    await page
      .getByRole('link', { name: /Audit Monstera/i })
      .first()
      .click();
    const taskRow = page.locator('li', { hasText: 'Every 7 days' });
    await expect(taskRow).toBeVisible();
    await expect(taskRow.locator('summary[aria-label="Snooze task"]')).toBeVisible();
    for (const name of [/edit task/i, /^done$/i]) {
      await expect(taskRow.getByRole('button', { name })).toBeVisible();
    }
    const taskLayout = await taskRow.evaluate((row) => {
      const metadata = row.querySelector('p');
      const actions = row.querySelectorAll('button, summary');
      const metadataRect = metadata?.getBoundingClientRect();
      const visibleActionRects = Array.from(actions)
        .map((action) => action.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      const actionTop = Math.min(...visibleActionRects.map((rect) => rect.top));
      return { metadataBottom: metadataRect?.bottom ?? 0, actionTop };
    });
    expect(taskLayout.actionTop).toBeGreaterThanOrEqual(taskLayout.metadataBottom);
    await expectNoDocumentOverflow(page, 'plant task row');

    await page.getByRole('button', { name: /^add task$/i }).click();
    const addTaskDialog = page.getByRole('dialog', { name: /add care task/i });
    await expect(addTaskDialog.getByRole('heading', { name: /add care task/i })).toBeVisible();
    await expectNoDocumentOverflow(page, 'add task dialog');
    await expectMinimumControlTargets(page, 'add task dialog');
    await expectNoA11yViolations(page, 'add task dialog');
    await addTaskDialog.getByRole('button', { name: /^close$/i }).click();

    await taskRow.getByRole('button', { name: /edit task/i }).click();
    const editTaskDialog = page.getByRole('dialog', { name: /^edit task$/i });
    await expect(editTaskDialog.getByRole('heading', { name: /^edit task$/i })).toBeVisible();
    await expectNoDocumentOverflow(page, 'edit task dialog');
    await expectMinimumControlTargets(page, 'edit task dialog');
    await expectNoA11yViolations(page, 'edit task dialog');
    await editTaskDialog.getByRole('button', { name: /^close$/i }).click();

    await page.getByRole('button', { name: /^edit$/i }).click();
    const editPlantDialog = page.getByRole('dialog', { name: /edit plant/i });
    await expect(editPlantDialog.getByRole('heading', { name: /edit plant/i })).toBeVisible();
    await expectNoDocumentOverflow(page, 'edit plant dialog');
    await expectMinimumControlTargets(page, 'edit plant dialog');
    await expectNoA11yViolations(page, 'edit plant dialog');
    await editPlantDialog.getByRole('button', { name: /^close$/i }).click();

    await page.getByRole('button', { name: /share cutting/i }).click();
    const shareDialog = page.getByRole('dialog', { name: /share this cutting/i });
    await expect(shareDialog.getByRole('heading', { name: /share this cutting/i })).toBeVisible();
    await expectNoDocumentOverflow(page, 'share cutting dialog');
    await expectMinimumControlTargets(page, 'share cutting dialog');
    await expectNoA11yViolations(page, 'share cutting dialog');
    await shareDialog.getByRole('button', { name: /^close$/i }).click();

    await page.getByRole('button', { name: /check leaf health/i }).click();
    const leafDialog = page.getByRole('dialog', { name: /leaf health check/i });
    await expect(leafDialog.getByRole('heading', { name: /leaf health check/i })).toBeVisible();
    await expectNoDocumentOverflow(page, 'leaf health dialog');
    await expectMinimumControlTargets(page, 'leaf health dialog');
    await expectNoA11yViolations(page, 'leaf health dialog');
    await leafDialog.getByRole('button', { name: /^close$/i }).click();

    await page.getByRole('button', { name: /^remove$/i }).click();
    const removeDialog = page.getByRole('dialog', {
      name: /move Audit Monstera out of active care/i,
    });
    await expect(
      removeDialog.getByRole('heading', { name: /move Audit Monstera out of active care/i })
    ).toBeVisible();
    await expectNoDocumentOverflow(page, 'remove plant dialog');
    await expectMinimumControlTargets(page, 'remove plant dialog');
    await expectNoA11yViolations(page, 'remove plant dialog');
    await removeDialog.getByRole('button', { name: /delete permanently/i }).click();
    const deleteDialog = page.getByRole('dialog', { name: /delete plant/i });
    await expect(deleteDialog.getByRole('heading', { name: /delete plant/i })).toBeVisible();
    await expectNoDocumentOverflow(page, 'delete confirmation dialog');
    await expectMinimumControlTargets(page, 'delete confirmation dialog');
    await expectNoA11yViolations(page, 'delete confirmation dialog');
    await deleteDialog.getByRole('button', { name: /^cancel$/i }).click();

    await navigateTo(page, /^settings$/i, /\/settings$/);
    const sectionSelect = page.getByRole('combobox', { name: /^settings section$/i });
    await expect(sectionSelect).toBeVisible();
    await sectionSelect.selectOption('billing');
    await expect(page).toHaveURL(/\/settings\/billing$/);
    await expect(page.getByRole('heading', { name: /billing/i }).first()).toBeVisible();
    await expectNoDocumentOverflow(page, 'mobile billing settings');
    await expectMinimumControlTargets(page, 'mobile billing settings');
    await sectionSelect.selectOption('api-keys');
    await expect(page).toHaveURL(/\/settings\?section=api-keys$/);
    await expect(page.getByRole('heading', { name: /api keys/i }).first()).toBeVisible();
    await expectNoDocumentOverflow(page, 'mobile API key settings');
    await expectMinimumControlTargets(page, 'mobile API key settings');
    await sectionSelect.selectOption('notifications');
    await expect(page.getByRole('heading', { name: /notifications/i }).first()).toBeVisible();
    await expectNoDocumentOverflow(page, 'mobile notification settings');
    await expectMinimumControlTargets(page, 'mobile notification settings');
    await sectionSelect.selectOption('account');
    await expect(page.getByRole('heading', { name: /^profile$/i }).first()).toBeVisible();
    await expectNoDocumentOverflow(page, 'mobile account settings');
    await expectMinimumControlTargets(page, 'mobile account settings');

    await navigateTo(page, /^chat$/i, /\/chat$/);
    const composer = page.getByLabel(/chat message/i);
    const disclaimer = page.getByText(/AI-generated/i);
    await expect(composer).toBeVisible();
    await expect(disclaimer).toBeVisible();
    await expect(page.getByText(/In loving memory/i)).toHaveCount(0);
    const bottomEdge = await disclaimer.evaluate(
      (element) => element.getBoundingClientRect().bottom
    );
    expect(bottomEdge).toBeLessThanOrEqual(700);
    await expectNoDocumentOverflow(page, 'chat');
  });

  test('desktop settings tabs support arrow-key navigation and deep links', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await uiLogin(page, account.email, account.password);
    await navigateTo(page, /^settings$/i, /\/settings$/);

    const preferences = page.getByRole('tab', { name: /preferences/i });
    await preferences.focus();
    await preferences.press('ArrowRight');

    const notifications = page.getByRole('tab', { name: /notifications/i });
    await expect(notifications).toBeFocused();
    await expect(notifications).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/\/settings\?section=notifications$/);

    await notifications.press('End');
    const accountTab = page.getByRole('tab', { name: /^account$/i });
    await expect(accountTab).toBeFocused();
    await expect(page).toHaveURL(/\/settings\?section=account$/);
  });
});
