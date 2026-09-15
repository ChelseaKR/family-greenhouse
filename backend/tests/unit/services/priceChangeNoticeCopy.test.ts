import { describe, expect, it } from 'vitest';
import type { PriceChangeAnnouncement } from '../../../src/models/priceChangeAnnouncement.js';
import { composePriceChangeNoticeEmail } from '../../../src/services/billingEmailCopy.js';

const APP_URL = 'https://familygreenhouse.net/';

const ANNOUNCEMENT: PriceChangeAnnouncement = {
  id: 'garden-monthly-2026-11-01',
  planId: 'garden',
  interval: 'month',
  summary: 'Garden monthly is moving from $4.99 to $5.99 to keep pace with vendor cost.',
  oldPriceUsd: 4.99,
  newPriceUsd: 5.99,
  effectiveOn: '2026-11-01',
};

describe('composePriceChangeNoticeEmail: english', () => {
  const email = composePriceChangeNoticeEmail(ANNOUNCEMENT, { locale: 'en', appUrl: APP_URL });

  it('states the plan, the cadence, both prices and the effective date', () => {
    expect(email.text).toContain('Garden');
    expect(email.text).toContain('monthly');
    expect(email.text).toContain('$4.99');
    expect(email.text).toContain('$5.99');
    expect(email.text).toContain('November 1, 2026');
    expect(email.subject).toContain('Garden');
    expect(email.subject).toContain('November 1, 2026');
  });

  it('promises the price does not move before the effective date, and that nothing is required to keep it', () => {
    expect(email.text).toContain('You will not be charged the new price before then');
    expect(email.text).toContain('there is nothing you need to do to keep it that way');
  });

  it('offers cancelling as an option, stated as a choice, not a requirement', () => {
    expect(email.text).toContain('If you would rather not continue at the new price');
    expect(email.text).toContain('Manage subscription');
  });

  it('carries the operator-supplied summary', () => {
    expect(email.text).toContain(ANNOUNCEMENT.summary);
  });

  it('links to the billing page, via the shared envelope', () => {
    expect(email.text).toContain(`${APP_URL.replace(/\/$/, '')}/settings/billing`);
  });
});

describe('composePriceChangeNoticeEmail: spanish', () => {
  const email = composePriceChangeNoticeEmail(ANNOUNCEMENT, { locale: 'es', appUrl: APP_URL });

  it('states the same facts in spanish', () => {
    expect(email.text).toContain('Garden');
    expect(email.text).toContain('mensual');
    expect(email.text).toContain('$4.99');
    expect(email.text).toContain('$5.99');
    expect(email.text).toContain('1 de noviembre de 2026');
  });

  it('promises the price does not move before the effective date, in spanish', () => {
    expect(email.text).toContain('No se te cobrará el');
    expect(email.text).toContain('no tienes que hacer nada');
  });
});

describe('composePriceChangeNoticeEmail: annual cadence and greenhouse', () => {
  it('names the annual cadence and the greenhouse plan', () => {
    const email = composePriceChangeNoticeEmail(
      {
        ...ANNOUNCEMENT,
        planId: 'greenhouse',
        interval: 'year',
        oldPriceUsd: 79.99,
        newPriceUsd: 89.99,
      },
      { locale: 'en', appUrl: APP_URL }
    );
    expect(email.text).toContain('Greenhouse');
    expect(email.text).toContain('annual');
    expect(email.text).toContain('$79.99');
    expect(email.text).toContain('$89.99');
  });
});
