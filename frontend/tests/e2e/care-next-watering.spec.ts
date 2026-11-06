import { expect, test } from '@playwright/test';

/**
 * The care guides' "your next watering" tool in a real browser: the served
 * HTML holds only the reminder link, the tool replaces it once the page has
 * loaded, and "Add to my calendar" hands the browser a .ics file made on the
 * device, with no request to any server for it.
 */
test.describe('care guide next-watering tool', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'one engine is enough');

  test('serves the old link, then dates a soil check and saves a calendar file', async ({
    page,
    request,
  }) => {
    // The prerendered file itself, as CloudFront serves it for /care/zz-plant.
    const served = await (await request.get('/care/zz-plant/index.html')).text();
    expect(served).toContain('data-testid="care-glance-cta"');
    expect(served).not.toContain('next-watering');

    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.goto('/care/zz-plant');
    const question = page.getByLabel('When did you last water it?');
    await expect(question).toBeVisible();
    await expect(page.getByTestId('care-glance-cta')).toHaveCount(1);

    await question.selectOption('today');
    await expect(page.getByTestId('next-watering-result')).toContainText('Check the soil around');
    await expect(page.getByTestId('care-glance-cta')).toHaveAttribute(
      'href',
      '/register?plant=zz-plant&last=today'
    );

    const before = requests.length;
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('next-watering-calendar').click(),
    ]);
    expect(download.suggestedFilename()).toBe('zz-plant-watering.ics');
    const text = await (await download.createReadStream()).toArray();
    const ics = Buffer.concat(text).toString('utf8');
    expect(ics).toContain('RRULE:FREQ=DAILY;INTERVAL=14');
    expect(ics).toContain('URL:https://familygreenhouse.net/care/zz-plant');
    // Nothing went to a server for the file: only blob: and analytics, if any.
    const after = requests.slice(before).filter((u) => !u.startsWith('blob:'));
    expect(after.filter((u) => u.includes('localhost'))).toEqual([]);
  });

  test('says a guide with no stated day count gives no date', async ({ page }) => {
    await page.goto('/care/monstera');
    await expect(page.getByTestId('next-watering-no-days')).toContainText('no set number of days');
    await expect(page.getByLabel('When did you last water it?')).toHaveCount(0);
  });
});
