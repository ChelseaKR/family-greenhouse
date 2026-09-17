import { describe, expect, it } from 'vitest';
import { composeCheckoutRecoveryEmail } from '../../../src/services/checkoutRecoveryEmailCopy.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const STARTED_TODAY = '2026-09-15T10:00:00.000Z';
const STARTED_3_DAYS_AGO = '2026-09-12T10:00:00.000Z';

describe('composeCheckoutRecoveryEmail — honesty about charge status', () => {
  it('never says "not charged" unconditionally — it hedges the delayed-settlement case (en)', () => {
    const { text } = composeCheckoutRecoveryEmail({
      locale: 'en',
      appUrl: 'https://familygreenhouse.net',
      startedAt: STARTED_TODAY,
      now: NOW,
    });
    // Never an unconditional claim sitting on its own — the hedge must be in
    // the very same sentence, not a separate disclaimer far enough away that
    // a skimming reader misses it.
    expect(text).not.toMatch(/you (were not|weren't|are not) charged\.(\s|$)/imu);
    expect(text.toLowerCase()).toContain('bank transfer');
    expect(text.toLowerCase()).toContain('receipt from stripe');
  });

  it('carries the same hedge in Spanish, not a verbatim-English placeholder', () => {
    const { text } = composeCheckoutRecoveryEmail({
      locale: 'es',
      appUrl: 'https://familygreenhouse.net',
      startedAt: STARTED_TODAY,
      now: NOW,
    });
    expect(text.toLowerCase()).toContain('transferencia bancaria');
    expect(text.toLowerCase()).toContain('recibo de stripe');
    // Not an English sentence smuggled into the es composer.
    expect(text).not.toContain('bank transfer');
    expect(text).not.toContain('You started');
  });
});

describe('composeCheckoutRecoveryEmail — never invents a plan tier', () => {
  it('names "a paid plan" generically, in both locales — the marker carries no planId', () => {
    const en = composeCheckoutRecoveryEmail({
      locale: 'en',
      appUrl: 'https://familygreenhouse.net',
      startedAt: STARTED_TODAY,
      now: NOW,
    });
    expect(en.text).toContain('a paid Family Greenhouse plan');
    // Never a specific tier name. "Greenhouse" alone is excluded from this
    // check because it is also half of the product's own name ("Family
    // Greenhouse") — the real assertion is that no TIER is named, i.e. no
    // "Greenhouse plan"/"Garden plan" standing apart from "Family Greenhouse".
    expect(en.text).not.toContain('Seedling');
    expect(en.text).not.toContain('Garden');
    expect(en.text).not.toMatch(/(?<!Family )Greenhouse plan/u);

    const es = composeCheckoutRecoveryEmail({
      locale: 'es',
      appUrl: 'https://familygreenhouse.net',
      startedAt: STARTED_TODAY,
      now: NOW,
    });
    expect(es.text).toContain('plan de pago de Family Greenhouse');
  });
});

describe('composeCheckoutRecoveryEmail — the link and the tone', () => {
  it('links straight back to /settings/billing, with the appUrl trailing slash stripped', () => {
    const { text } = composeCheckoutRecoveryEmail({
      locale: 'en',
      appUrl: 'https://familygreenhouse.net/',
      startedAt: STARTED_TODAY,
      now: NOW,
    });
    expect(text).toContain('https://familygreenhouse.net/settings/billing');
    expect(text).not.toContain('familygreenhouse.net//settings');
  });

  it('is low-pressure: no countdown, no "expires soon", no all-caps urgency', () => {
    const { text } = composeCheckoutRecoveryEmail({
      locale: 'en',
      appUrl: 'https://familygreenhouse.net',
      startedAt: STARTED_TODAY,
      now: NOW,
    });
    const lower = text.toLowerCase();
    for (const pressureWord of [
      'hurry',
      'expires soon',
      'last chance',
      'act now',
      'limited time',
    ]) {
      expect(lower).not.toContain(pressureWord);
    }
    expect(lower).toContain('no rush');
    expect(lower).toContain('no deadline');
  });

  it('states plainly that it sends only once for this attempt', () => {
    const en = composeCheckoutRecoveryEmail({
      locale: 'en',
      appUrl: 'https://familygreenhouse.net',
      startedAt: STARTED_TODAY,
      now: NOW,
    });
    expect(en.text.toLowerCase()).toContain('once per checkout attempt');

    const es = composeCheckoutRecoveryEmail({
      locale: 'es',
      appUrl: 'https://familygreenhouse.net',
      startedAt: STARTED_TODAY,
      now: NOW,
    });
    expect(es.text.toLowerCase()).toContain('una vez por cada intento');
  });
});

describe('composeCheckoutRecoveryEmail — "how long ago", via Intl not concatenation', () => {
  it('reads "today" when the attempt started earlier the same day', () => {
    const { text } = composeCheckoutRecoveryEmail({
      locale: 'en',
      appUrl: 'https://familygreenhouse.net',
      startedAt: STARTED_TODAY,
      now: NOW,
    });
    expect(text).toMatch(/plan today,/u);
  });

  it('reads "3 days ago" (en) / "hace 3 días" (es) for an older, truncation-delayed run', () => {
    const en = composeCheckoutRecoveryEmail({
      locale: 'en',
      appUrl: 'https://familygreenhouse.net',
      startedAt: STARTED_3_DAYS_AGO,
      now: NOW,
    });
    expect(en.text).toContain('3 days ago');

    const es = composeCheckoutRecoveryEmail({
      locale: 'es',
      appUrl: 'https://familygreenhouse.net',
      startedAt: STARTED_3_DAYS_AGO,
      now: NOW,
    });
    expect(es.text).toContain('hace 3 días');
  });

  it('never throws on an unparseable startedAt — falls back to "today" rather than "NaN days ago"', () => {
    const { text } = composeCheckoutRecoveryEmail({
      locale: 'en',
      appUrl: 'https://familygreenhouse.net',
      startedAt: 'not-a-date',
      now: NOW,
    });
    expect(text).not.toContain('NaN');
  });
});

describe('composeCheckoutRecoveryEmail — locales genuinely differ', () => {
  it('en and es produce different subjects and different bodies', () => {
    const en = composeCheckoutRecoveryEmail({
      locale: 'en',
      appUrl: 'https://familygreenhouse.net',
      startedAt: STARTED_TODAY,
      now: NOW,
    });
    const es = composeCheckoutRecoveryEmail({
      locale: 'es',
      appUrl: 'https://familygreenhouse.net',
      startedAt: STARTED_TODAY,
      now: NOW,
    });
    expect(en.subject).not.toBe(es.subject);
    expect(en.text).not.toBe(es.text);
  });
});
