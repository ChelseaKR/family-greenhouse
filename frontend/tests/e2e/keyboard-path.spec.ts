import { test, expect, Page, Locator } from '@playwright/test';
import { provisionAccount, uiLogin, ProvisionedAccount } from './helpers';

/**
 * Keyboard-only path spec (A11Y-07, WCAG 2.1.1 / 2.4.1 / 2.4.7).
 *
 * Proves a primary task — log in, reach the Tasks page, complete a due
 * water task — is achievable with the keyboard alone, and that the
 * focus indicator is actually visible while doing it. The manual
 * checklist in docs/accessibility.md walks this by hand; this spec is
 * the automated floor underneath it.
 *
 * Provisions its own account (one Monstera + one water task due today)
 * so the mutating "complete" step can't race other specs/projects that
 * share the seed account.
 */

let account: ProvisionedAccount;

test.beforeAll(async () => {
  account = await provisionAccount({
    emailPrefix: 'keyboard-path',
    plant: { name: 'Monstera', species: 'Monstera deliciosa', location: 'Living Room' },
    waterTask: { frequency: 7 }, // nextDue defaults to "now" → Today bucket
  });
});

/**
 * WebKit on macOS mirrors Safari's default: plain Tab skips links
 * (Option+Tab includes them). WebKitGTK on Linux — what CI runs — tabs
 * links normally. Pick the key that means "move to the next focusable,
 * links included" on the current engine/platform.
 */
function tabKey(browserName: string): string {
  return browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab';
}

/**
 * Press Tab until `target` holds focus. The cap exists so a regression
 * that drops the element out of tab order fails loudly instead of
 * spinning forever; 40 comfortably covers every page under test.
 */
async function tabTo(page: Page, target: Locator, key: string, maxTabs = 40): Promise<void> {
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press(key);
    const focused = await target.evaluate((el) => el === document.activeElement).catch(() => false);
    if (focused) return;
  }
  throw new Error(`target never received focus within ${maxTabs} ${key} presses`);
}

test.describe('Keyboard-only paths', () => {
  // Keyboard-only navigation is a physical-keyboard modality: on the
  // touch-emulation projects the nav links sit behind the hamburger and
  // sequential focus differs per engine, so the desktop projects are the
  // meaningful surface for this criterion.
  test.skip(({ isMobile }) => isMobile, 'keyboard-only paths are asserted on desktop projects');

  // The last test mutates the provisioned task store (marks the task
  // done), so keep this file's tests ordered.
  test.describe.configure({ mode: 'serial' });

  test('login form is completable with the keyboard alone', async ({ page, browserName }) => {
    const key = tabKey(browserName);
    await page.goto('/login');
    const email = page.getByLabel(/email/i);
    await email.waitFor({ state: 'visible', timeout: 15000 });

    await tabTo(page, email, key);
    await page.keyboard.type(account.email);
    await tabTo(page, page.getByLabel(/password/i), key);
    await page.keyboard.type(account.password);
    await page.keyboard.press('Enter'); // submits the form — no pointer involved

    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });
  });

  test('skip link is an early tab stop and jumps focus to main content', async ({
    page,
    browserName,
  }) => {
    const key = tabKey(browserName);
    await uiLogin(page, account.email, account.password);

    // From a fresh load, the skip link must be reachable within the
    // first couple of tab stops (WCAG 2.4.1 Bypass Blocks). It is
    // sr-only until focused — focusing it is what makes it visible.
    const skipLink = page.getByRole('link', { name: /skip to main content/i });
    await tabTo(page, skipLink, key, 3);
    await expect(skipLink).toBeVisible(); // focus:not-sr-only reveals it

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main-content/);
    // What a skip link is *for*: after activating it, the next Tab must
    // continue from inside the main content area, bypassing the nav.
    // (#main-content carries tabIndex={-1} so the jump moves the
    // sequential-focus point; engines differ on whether activeElement
    // lands on the target itself — Chromium yes, Firefox/WebKit no — so
    // assert the behavior, not the intermediate state.)
    await page.keyboard.press(key);
    const focusInMain = await page.evaluate(
      () => document.activeElement?.closest('#main-content') !== null
    );
    expect(focusInMain, 'Tab after the skip link must land inside main content').toBe(true);
  });

  test('a due task can be completed keyboard-only, with a visible focus ring', async ({
    page,
    browserName,
  }) => {
    const key = tabKey(browserName);
    await uiLogin(page, account.email, account.password);

    // Reach the Tasks page through the sidebar nav with Tab + Enter.
    const tasksLink = page.getByRole('link', { name: /^tasks$/i }).filter({ visible: true });
    await expect(tasksLink.first()).toBeVisible({ timeout: 15000 });
    await tabTo(page, tasksLink.first(), key);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/tasks$/, { timeout: 15000 });

    const taskRow = page.locator('li', { has: page.getByRole('link', { name: /monstera/i }) });
    await expect(taskRow).toBeVisible();

    // Tab to the row's "Done" button and check the focus indicator is
    // visible (WCAG 2.4.7): the global :focus-visible rule paints a
    // ring via box-shadow, so the computed value must not be 'none'.
    const doneButton = taskRow.getByRole('button', { name: /done/i });
    await tabTo(page, doneButton, key);
    const boxShadow = await doneButton.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(boxShadow, 'keyboard focus must paint a visible ring').not.toBe('none');

    await page.keyboard.press('Enter');

    // Completion pushes nextDue out by the 7-day frequency — the row
    // leaves the "Today" bucket (same contract task-completion.spec.ts
    // asserts for the pointer path).
    await expect(taskRow.getByText(/^today$/i)).toHaveCount(0);
  });
});
