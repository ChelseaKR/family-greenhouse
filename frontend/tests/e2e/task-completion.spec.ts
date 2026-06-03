import { test, expect, Page } from '@playwright/test';

/**
 * Task completion + filter behavior on the Tasks page.
 *
 * The local backend seeds one water task on the Monstera plant with
 * `nextDue` set to `new Date().toISOString()` at boot, so it lands in the
 * "Today" bucket. Each test logs in via the UI to avoid the
 * zustand-persist rehydration race that bounces a `page.goto('/tasks')`
 * back to /login (see notes in `visual.spec.ts`).
 */

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill('test@example.com');
  await page.getByLabel(/password/i).fill('password123');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

async function goToTasks(page: Page) {
  await page.getByRole('link', { name: /^tasks$/i }).click();
  await expect(page).toHaveURL(/\/tasks$/);
}

test.describe('Task completion', () => {
  // The local backend's in-memory task store is shared across parallel
  // workers, so the read-only filter assertions need to run before the
  // mutating "mark done" test. Serial mode preserves that order.
  test.describe.configure({ mode: 'serial' });

  test('filter pills toggle the active filter', async ({ page }) => {
    await login(page);
    await goToTasks(page);

    // "All" is the default — it should advertise pressed=true while the
    // others are pressed=false.
    await expect(page.getByRole('button', { name: /^all$/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await page.getByRole('button', { name: /^today$/i }).click();
    await expect(page.getByRole('button', { name: /^today$/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(page.getByRole('button', { name: /^all$/i })).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    await page.getByRole('button', { name: /this week/i }).click();
    await expect(page.getByRole('button', { name: /this week/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  test('Today filter keeps the seeded water task visible', async ({ page }) => {
    await login(page);
    await goToTasks(page);

    await page.getByRole('button', { name: /^today$/i }).click();

    // The seeded water task's nextDue is `new Date()` — that falls into
    // the Today bucket and the row stays visible after the filter
    // narrows.
    const taskRow = page.locator('li', { has: page.getByRole('link', { name: /monstera/i }) });
    await expect(taskRow).toBeVisible();
    await expect(taskRow.getByText(/water/i)).toBeVisible();
  });

  test('Overdue filter on a fresh seed shows the EmptyTasks empty state', async ({ page }) => {
    await login(page);
    await goToTasks(page);

    // The seed task is due today, not overdue, so switching to the
    // Overdue filter should empty the list and surface the illustrated
    // EmptyState component.
    await page.getByRole('button', { name: /^overdue/i }).click();

    await expect(page.getByRole('heading', { name: /no tasks found/i })).toBeVisible();
    // EmptyState description varies by filter; the non-"all" branch shows
    // "No tasks match the current filter." and a Clear filter button.
    await expect(page.getByText(/no tasks match the current filter/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /clear filter/i })).toBeVisible();
  });

  test('login → see seeded water task → mark done → it disappears', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await login(page);
    await goToTasks(page);

    // The seeded Monstera water task renders as a row with a Monstera
    // link + a "Done" button. The plant name is a unique anchor on the
    // page so matching by role link is reliable.
    const taskRow = page.locator('li', { has: page.getByRole('link', { name: /monstera/i }) });
    await expect(taskRow).toBeVisible();
    await expect(taskRow.getByText(/water/i)).toBeVisible();

    await taskRow.getByRole('button', { name: /done/i }).click();

    // After completion the task moves out of "Today" — the next due date
    // jumps by the task frequency (7d), so it lands in "Upcoming" rather
    // than disappearing entirely. The row should no longer say "Today".
    await expect(taskRow.getByText(/^today$/i)).toHaveCount(0);
    expect(consoleErrors).toEqual([]);
  });
});
