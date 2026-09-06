import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createInstance, type i18n as I18nInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import es from '@/i18n/locales/es/translation.json';
import enLegal from '@/i18n/locales/en/legal.json';
import esLegal from '@/i18n/locales/es/legal.json';
import { loadLegalCatalog } from '@/i18n/legalCatalog';
import { TermsPage } from '@/features/legal/TermsPage';

/**
 * The commercial terms on /legal/terms — renewal, cancelling, the trial,
 * price changes and one-time purchases — are the sentences a paying household
 * is held to, so these tests guard the two ways they can silently go wrong:
 *
 *  1. A section that stops rendering. A missing auto-renewal clause on a page
 *     that charges cards is the gap this suite exists to catch, and it is
 *     invisible in a screenshot because the page still looks complete.
 *  2. The two locales drifting apart. A Spanish reader gets the Spanish text
 *     (LegalShell only adds a governing-language note), so a number that
 *     appears in one locale and not the other is a page that says two
 *     different things about money.
 *
 * The refund assertion is deliberate and not a style rule: there is no refund
 * policy to publish (issue #426). Until the owner chooses one, a refund
 * sentence appearing here would be a commitment nobody agreed to, so the test
 * fails on the word rather than waiting for someone to notice it shipped.
 *
 * The sentences themselves live in `locales/<lng>/legal.json`, not in
 * `translation.json`: `legal.*` is a deferred catalog fragment that App.tsx
 * awaits inside the legal routes' lazy() factory (see i18n/legalCatalog.ts).
 * These tests mount TermsPage directly, so they register it themselves — on
 * the shared instance for the English cases, and by hand for the Spanish one.
 * Asserting against the JSON fragments rather than `translation.json` is also
 * what keeps a silently unloaded catalog from passing: an unregistered key
 * renders as the raw `legal.terms.…` string and every heading lookup fails.
 */

let spanish: I18nInstance;

beforeAll(async () => {
  await loadLegalCatalog();

  spanish = createInstance();
  await spanish.init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: { ...es, ...esLegal } } },
    interpolation: { escapeValue: false },
  });
});

function renderEnglish() {
  return render(
    <MemoryRouter>
      <TermsPage />
    </MemoryRouter>
  );
}

function renderSpanish() {
  return render(
    <I18nextProvider i18n={spanish}>
      <MemoryRouter>
        <TermsPage />
      </MemoryRouter>
    </I18nextProvider>
  );
}

const SECTIONS = ['trial', 'renewal', 'cancellation', 'priceChanges', 'oneTimePurchases'] as const;

describe('terms: the commercial sections render', () => {
  it.each(SECTIONS)('English has a heading for %s', (section) => {
    renderEnglish();
    expect(
      screen.getByRole('heading', { level: 2, name: enLegal.legal.terms[section].heading })
    ).toBeInTheDocument();
  });

  it.each(SECTIONS)('Spanish has a heading for %s', (section) => {
    renderSpanish();
    expect(
      screen.getByRole('heading', { level: 2, name: esLegal.legal.terms[section].heading })
    ).toBeInTheDocument();
  });

  it('states in English that subscriptions renew automatically until cancelled', () => {
    const { container } = renderEnglish();
    expect(container.textContent).toContain('renew automatically until they are cancelled');
  });

  it('states in Spanish that subscriptions renew automatically until cancelled', () => {
    const { container } = renderSpanish();
    expect(container.textContent).toContain('se renuevan automáticamente hasta que se cancelan');
  });
});

describe('terms: the two locales agree about money', () => {
  /**
   * Both locales must carry the same commercial numbers. These are the ones a
   * reader acts on: the trial length, the notice period before a price change,
   * and how long a one-time pack of identifications lasts.
   */
  it.each([
    ['the 14-day trial and the 14 days of notice before a price change', /14/],
    ['the 12-month expiry on a pack of identifications', /12 (months|meses)/],
  ])('%s appears in both locales', (_label, pattern) => {
    const english = renderEnglish().container.textContent ?? '';
    const spanish_ = renderSpanish().container.textContent ?? '';
    expect(english).toMatch(pattern);
    expect(spanish_).toMatch(pattern);
  });

  it('names the same number of sections in each locale', () => {
    const english = renderEnglish().container.querySelectorAll('h2').length;
    const spanish_ = renderSpanish().container.querySelectorAll('h2').length;
    expect(spanish_).toBe(english);
  });
});

describe('terms: no refund policy is published', () => {
  it.each([
    ['English', renderEnglish, /refund/i],
    ['Spanish', renderSpanish, /reembols|devoluci/i],
  ])('%s publishes no refund term while #426 is open', (_locale, renderPage, pattern) => {
    const { container } = renderPage();
    expect(container.textContent ?? '').not.toMatch(pattern);
  });
});

describe('terms: the trial length is the one the backend actually asks Stripe for', () => {
  /**
   * The 14 days on the Terms page is not a house number — it is
   * `trial_period_days` on every subscription Checkout session we create. The
   * two live in different workspaces, so nothing else notices when one moves.
   * Read the backend source as text rather than importing it: this test only
   * needs the literal the service ships, and a text read costs no cross-
   * workspace module resolution.
   */
  const billingPath = ['../backend/src/services/billing.ts', 'backend/src/services/billing.ts']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find(existsSync);
  const billingSource = billingPath === undefined ? '' : readFileSync(billingPath, 'utf8');

  it('takes its number from services/billing.ts, in both locales', () => {
    // A path that did not resolve is a failed read, not "no trial" — say so
    // rather than passing on an empty string.
    expect(billingPath, 'could not locate backend/src/services/billing.ts').toBeDefined();
    // The value is written either as a literal or through a named constant
    // (`trial_period_days: TRIAL_PERIOD_DAYS`). Follow the indirection rather
    // than matching only digits: a constant that this test could not resolve
    // is a failed read, and must fail loudly instead of reading as "no trial".
    const setting = billingSource.match(/trial_period_days:\s*([A-Za-z0-9_]+)/);
    expect(setting, 'trial_period_days is no longer set in services/billing.ts').not.toBeNull();
    const token = setting![1];
    const days = /^\d+$/.test(token)
      ? token
      : billingSource.match(new RegExp(`\\b${token}\\s*=\\s*(\\d+)`))?.[1];
    expect(days, `trial_period_days is set to \`${token}\`, whose value was not found`).toBeDefined();

    expect(enLegal.legal.terms.trial.intro).toContain(`${days}-day free trial`);
    expect(enLegal.legal.terms.trial.ending).toContain(`When the ${days} days are up`);
    expect(esLegal.legal.terms.trial.intro).toContain(`prueba gratuita de ${days} días`);
    expect(esLegal.legal.terms.trial.ending).toContain(`Cuando pasan los ${days} días`);
  });

  /**
   * The trial is once per HOUSEHOLD, not once per subscription:
   * `createCheckoutSession` omits `trial_period_days` entirely when
   * `trialConsumedAt` is set, and that marker is deliberately never cleared by
   * cancellation. A household that resubscribes is therefore charged at
   * checkout with no free period. The Terms are what a paying household is
   * held to, so they must not promise a trial to someone who will not get one.
   */
  it('does not promise a trial the backend withholds from a returning household', () => {
    expect(billingPath, 'could not locate backend/src/services/billing.ts').toBeDefined();
    expect(
      billingSource,
      'the trial is no longer gated on trialConsumedAt — re-read the Terms trial section against the new rule'
    ).toMatch(/trialConsumedAt\s*\?\s*\{\}\s*:\s*\{\s*trial_period_days/);

    // Neither locale may claim the trial applies to every new subscription.
    expect(enLegal.legal.terms.trial.intro).toContain('first paid subscription');
    expect(enLegal.legal.terms.trial.intro).toMatch(/once per household/i);
    expect(esLegal.legal.terms.trial.intro).toContain('primera suscripción de pago');
    expect(esLegal.legal.terms.trial.intro).toMatch(/una sola por hogar/i);
  });
});
