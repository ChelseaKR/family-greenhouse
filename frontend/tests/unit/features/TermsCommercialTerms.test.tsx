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
 * price changes, one-time purchases and refunds — are the sentences a paying
 * household is held to, so these tests guard the two ways they can silently
 * go wrong:
 *
 *  1. A section that stops rendering. A missing auto-renewal clause on a page
 *     that charges cards is the gap this suite exists to catch, and it is
 *     invisible in a screenshot because the page still looks complete.
 *  2. The two locales drifting apart. A Spanish reader gets the Spanish text
 *     (LegalShell only adds a governing-language note), so a number that
 *     appears in one locale and not the other is a page that says two
 *     different things about money.
 *
 * The refund assertions are deliberate and not a style rule. They used to
 * fail on the word "refund" appearing at all, because there was no policy to
 * publish (issue #426) and a stray sentence would have been a commitment
 * nobody agreed to. The section now exists, so they assert its content
 * instead — and the behaviour it describes is guarded on the backend side by
 * `backend/tests/unit/config/refundPosture.test.ts`.
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

const SECTIONS = [
  'trial',
  'renewal',
  'cancellation',
  'priceChanges',
  'oneTimePurchases',
  'refunds',
  'applePurchases',
] as const;

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
   * reader acts on: the trial length, the notice period before a price change
   * (now by email — there is no in-app announcement, #710), and how long a
   * one-time pack of identifications lasts.
   */
  it.each([
    ['the 14-day trial and the 14 days of email notice before a price change', /14/],
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

describe('terms: the refund section says what the billing code does', () => {
  /**
   * This block used to assert the opposite — that the word "refund" appeared
   * nowhere — because until #426 there was no policy to publish and a stray
   * refund sentence would have been a commitment nobody agreed to. A policy
   * has now been written, so the guard flips: the section must render, and it
   * must keep saying the two things that are true of the system rather than
   * the one thing a reader might hope for.
   *
   * The behaviour half of the same guard lives in the backend, where the tree
   * it describes can be walked:
   * `backend/tests/unit/config/refundPosture.test.ts` fails if any path in
   * `backend/src` acquires a Stripe refund call, or if the account-deletion
   * cancellation starts asking Stripe to settle the unused period.
   */
  it.each([
    ['English', renderEnglish, /refund/i],
    ['Spanish', renderSpanish, /reembols/i],
  ])('%s publishes a refund section', (_locale, renderPage, pattern) => {
    const { container } = renderPage();
    expect(container.textContent ?? '').toMatch(pattern);
  });

  it('says in English that cancelling does not return a charge already made', () => {
    const { container } = renderEnglish();
    expect(container.textContent).toContain('it does not return a charge already made');
  });

  it('says in Spanish that cancelling does not return a charge already made', () => {
    const { container } = renderSpanish();
    expect(container.textContent).toContain('no devuelve un cobro ya realizado');
  });

  it.each([
    ['English', renderEnglish, /we do not publish a refund window/i],
    ['Spanish', renderSpanish, /no publicamos un plazo de reembolso/i],
  ])('%s states no refund window, because nothing tracks one', (_locale, renderPage, pattern) => {
    const { container } = renderPage();
    expect(container.textContent ?? '').toMatch(pattern);
  });

  it.each([
    ['English', renderEnglish, /right the law where you live already gives you/i],
    ['Spanish', renderSpanish, /derechos que ya te otorgue la ley/i],
  ])('%s keeps the statutory-rights sentence', (_locale, renderPage, pattern) => {
    const { container } = renderPage();
    expect(container.textContent ?? '').toMatch(pattern);
  });
});

describe('terms: a failed payment keeps the plan while the card is retried (#593)', () => {
  /**
   * The Terms describe what the entitlement code does, and since #593 that is:
   * a `past_due` subscription keeps its plan while Stripe retries the card,
   * and once the last retry fails Stripe cancels the subscription (the owner's
   * decision, 2026-09-19; a Stripe dashboard setting) and the household moves
   * to the free plan. The
   * sentence and the status set live in different workspaces, so this reads
   * the backend source as text — the same approach as the trial-length check
   * below — and fails if either side moves without the other.
   */
  const plansPath = ['../backend/src/models/plans.ts', 'backend/src/models/plans.ts']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find(existsSync);
  const plansSource = plansPath === undefined ? '' : readFileSync(plansPath, 'utf8');

  it('reads the entitled statuses from models/plans.ts', () => {
    const match = plansSource.match(/ENTITLED_SUBSCRIPTION_STATUSES = new Set\(\[([^\]]*)\]\)/);
    expect(match, 'ENTITLED_SUBSCRIPTION_STATUSES not found in models/plans.ts').not.toBeNull();
    const statuses = [...(match![1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(statuses).toContain('past_due');
    expect(statuses).not.toContain('unpaid');
  });

  it.each([
    [
      'English',
      renderEnglish,
      /keeps its plan and every paid feature while our payment provider retries the card automatically/,
    ],
    [
      'Spanish',
      renderSpanish,
      /conserva su plan y todas las funciones de pago mientras nuestro proveedor de pagos vuelve a intentar/,
    ],
  ])('%s states the retry window without inventing a day count', (_locale, renderPage, pattern) => {
    const text = renderPage().container.textContent ?? '';
    expect(text).toMatch(pattern);
    // The retry schedule is Stripe's dunning setting, which nothing here reads.
    const paragraph = [...renderPage().container.querySelectorAll('p')]
      .map((p) => p.textContent ?? '')
      .find((p) => pattern.test(p));
    expect(paragraph).toBeDefined();
    expect(paragraph).not.toMatch(/\d+\s*(days?|días?)/i);
  });

  it.each([
    [
      'English',
      renderEnglish,
      /If the last retry fails, our payment provider cancels the subscription and the household moves to the free Seedling plan/,
    ],
    [
      'Spanish',
      renderSpanish,
      /Si falla el último reintento, nuestro proveedor de pagos cancela la suscripción y el hogar pasa al plan gratuito Plántula/,
    ],
  ])('%s says what happens when the last retry fails', (_locale, renderPage, pattern) => {
    expect(renderPage().container.textContent ?? '').toMatch(pattern);
  });
});

describe('terms: the trial length is the one the backend actually asks Stripe for', () => {
  /**
   * The 14 days on the Terms page is not a house number — it is the card
   * trial `checkoutTrialFor` hands every first subscription Checkout session.
   * The two live in different workspaces, so nothing else notices when one
   * moves. Read the backend source as text rather than importing it: this
   * test only needs the literal the service ships, and a text read costs no
   * cross-workspace module resolution.
   */
  const rulePath = ['../backend/src/models/checkoutTrial.ts', 'backend/src/models/checkoutTrial.ts']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find(existsSync);
  const ruleSource = rulePath === undefined ? '' : readFileSync(rulePath, 'utf8');

  it('takes its number from models/checkoutTrial.ts, in both locales', () => {
    // A path that did not resolve is a failed read, not "no trial" — say so
    // rather than passing on an empty string.
    expect(rulePath, 'could not locate backend/src/models/checkoutTrial.ts').toBeDefined();
    const days = ruleSource.match(/\bTRIAL_PERIOD_DAYS\s*=\s*(\d+)/)?.[1];
    expect(days, 'TRIAL_PERIOD_DAYS was not found in models/checkoutTrial.ts').toBeDefined();
    expect(ruleSource, 'the card trial no longer uses TRIAL_PERIOD_DAYS').toMatch(
      /kind:\s*'card_trial',\s*days:\s*TRIAL_PERIOD_DAYS/
    );

    expect(enLegal.legal.terms.trial.intro).toContain(`${days}-day free trial`);
    expect(esLegal.legal.terms.trial.intro).toContain(`prueba gratuita de ${days} días`);
  });

  /**
   * The trial is once per HOUSEHOLD, not once per subscription:
   * `checkoutTrialFor` gives no trial at all when `trialConsumedAt` is set,
   * and that marker is deliberately never cleared by cancellation. A
   * household that resubscribes is therefore charged at checkout with no free
   * period. The Terms are what a paying household is held to, so they must
   * not promise a trial to someone who will not get one.
   */
  it('does not promise a trial the backend withholds from a returning household', () => {
    expect(rulePath, 'could not locate backend/src/models/checkoutTrial.ts').toBeDefined();
    expect(
      ruleSource,
      'the trial is no longer gated on trialConsumedAt — re-read the Terms trial section against the new rule'
    ).toMatch(/if \(row\.trialConsumedAt\) return \{ kind: 'none' \};/);

    // Neither locale may claim the trial applies to every new subscription.
    expect(enLegal.legal.terms.trial.intro).toContain('first paid subscription');
    expect(enLegal.legal.terms.trial.intro).toMatch(/once per household/i);
    expect(esLegal.legal.terms.trial.intro).toContain('primera suscripción de pago');
    expect(esLegal.legal.terms.trial.intro).toMatch(/una sola por hogar/i);
  });

  /**
   * No stacked trials (owner decision 2026-10-23): a household on its no-card
   * trial that subscribes gets a Stripe trial ending on the no-card trial's
   * end date, not 14 more days. The Terms must say the two do not add up, and
   * must not say the first charge always comes after 14 days.
   */
  it('says the no-card trial and the subscription trial do not add up', () => {
    expect(ruleSource).toMatch(/kind:\s*'until_no_card_trial_end'/);
    expect(enLegal.legal.terms.trial.intro).toMatch(/never add up/);
    expect(enLegal.legal.terms.trial.intro).toMatch(/charged at checkout, with no trial/);
    expect(esLegal.legal.terms.trial.intro).toMatch(/nunca se suman/);
    expect(enLegal.legal.terms.trial.ending).not.toMatch(/14 days are up/);
    expect(esLegal.legal.terms.trial.ending).not.toMatch(/pasan los 14 días/);
  });
});

describe('terms: an Apple purchase is described as the App Store build sells it (ADR 0041)', () => {
  /**
   * "Purchases made through Apple" says there is no free trial in the app and
   * that the sections above it apply to website subscriptions only. The first
   * claim holds only while the App Store products carry no introductory
   * offer, and the second only while the section follows the ones it names.
   */
  const storekitPath = [
    '../frontend/ios/App/App/FamilyGreenhouse.storekit',
    'ios/App/App/FamilyGreenhouse.storekit',
    'frontend/ios/App/App/FamilyGreenhouse.storekit',
  ]
    .map((candidate) => resolve(process.cwd(), candidate))
    .find(existsSync);

  it('has no introductory offer on any App Store product', () => {
    expect(storekitPath, 'could not locate FamilyGreenhouse.storekit').toBeDefined();
    const config = JSON.parse(readFileSync(storekitPath!, 'utf8')) as {
      subscriptionGroups: { subscriptions: { introductoryOffer: unknown }[] }[];
    };
    const subscriptions = config.subscriptionGroups.flatMap((group) => group.subscriptions);
    expect(subscriptions.length).toBeGreaterThan(0);
    for (const subscription of subscriptions) {
      expect(
        subscription.introductoryOffer,
        'an App Store product now has an introductory offer — the Terms say an Apple purchase has no free trial'
      ).toBeNull();
    }
  });

  it.each([
    ['English', renderEnglish, enLegal.legal.terms],
    ['Spanish', renderSpanish, esLegal.legal.terms],
  ])('%s places the Apple section after the sections it calls "above"', (_l, renderPage, terms) => {
    const headings = [...renderPage().container.querySelectorAll('h2')].map((h) => h.textContent);
    const apple = headings.indexOf(terms.applePurchases.heading);
    expect(apple).toBeGreaterThan(-1);
    for (const section of ['trial', 'renewal', 'priceChanges', 'refunds'] as const) {
      expect(headings.indexOf(terms[section].heading)).toBeLessThan(apple);
    }
  });

  it('says in both locales that an Apple purchase has no free trial', () => {
    expect(enLegal.legal.terms.applePurchases.body).toContain('there is no free trial');
    expect(esLegal.legal.terms.applePurchases.body).toContain('no hay prueba gratuita');
  });
});
