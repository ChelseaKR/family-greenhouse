import { expect, test } from '@playwright/test';
import { provisionAccount, uiLogin } from './helpers';

/**
 * iPad widths, where the quiet-hours row is three columns. The grid used to
 * align its fields to the bottom, and the three fields carry helper text of
 * different lengths (one line, two lines, none), so Start, End and Timezone
 * sat at three different heights. Apple's reviewers often test on an iPad.
 */
const IPAD_VIEWPORTS = [
  { name: 'iPad Pro 13-inch portrait', width: 1024, height: 1366 },
  { name: 'iPad Pro 13-inch landscape', width: 1366, height: 1024 },
  { name: 'iPad Air portrait', width: 820, height: 1180 },
] as const;

test.describe('quiet hours on iPad', () => {
  for (const viewport of IPAD_VIEWPORTS) {
    test(`Start, End and Timezone share one row at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const account = await provisionAccount({ emailPrefix: 'ipad-quiet-hours' });
      await uiLogin(page, account.email, account.password);
      await page.goto('/settings?section=notifications');

      const fields = [
        page.getByLabel('Start', { exact: true }),
        page.getByLabel('End', { exact: true }),
        page.getByLabel('Timezone', { exact: true }),
      ];
      await fields[2].scrollIntoViewIfNeeded();
      const boxes = [];
      for (const field of fields) {
        await expect(field).toBeVisible();
        const box = await field.boundingBox();
        expect(box).not.toBeNull();
        boxes.push(box!);
      }

      const [start, end, timezone] = boxes;
      // One row: the same top edge, within a pixel of rounding.
      for (const box of [end, timezone]) {
        expect(Math.abs(box.y - start.y)).toBeLessThanOrEqual(1);
      }
      // Side by side, left to right, never one under the next.
      expect(start.x + start.width).toBeLessThanOrEqual(end.x);
      expect(end.x + end.width).toBeLessThanOrEqual(timezone.x);
    });
  }
});
