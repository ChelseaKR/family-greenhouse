import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The published Refunds section describes a system with no refund path in it
 * (#426). These tests hold the two halves of that claim to the code, in both
 * directions, because the sentence is a commercial commitment on a product
 * taking real cards.
 *
 * What the Terms say, and why each sentence needs a guard:
 *
 *  - "nothing in the service issues a refund on its own" — true only while no
 *    path in `backend/src` calls Stripe's refund API. The moment one does, the
 *    sentence is false and somebody has to re-read the section before it
 *    ships. That is the first test.
 *  - "Cancelling stops the next charge; it does not return a charge already
 *    made" — `accountCleanup.cancelAbandonedHouseholdSubscription` is the one
 *    place the service cancels a subscription on a customer's behalf, and it
 *    cancels with an empty params object, so Stripe's default (no proration,
 *    no refund) applies. If a `prorate` or `invoice_now` ever appears there,
 *    the Terms are describing the old behaviour. That is the second test.
 *  - Deleting the section must fail too. A guard satisfied by removing the
 *    sentence it guards is a guard that quietly stops guarding, so the third
 *    test reads the published catalogs and requires the section to be there,
 *    in both locales — the same both-directions property
 *    `scripts/check-doc-figures.mjs` is built on.
 *
 * What NONE of this does is issue, track, or reconcile a refund. There is no
 * machinery for that and the Terms deliberately promise none: the intake is
 * the support mailbox and any refund is made by hand in the Stripe dashboard.
 * `docs/billing.md` § Refunds states that in full, including what a stated
 * refund window would additionally require.
 */

const ROOT = new URL('../../../../', import.meta.url);
const BACKEND_SRC = new URL('backend/src/', ROOT);

/** Every `.ts` file under `backend/src`, as `[relative path, source text]`. */
function sourceFiles(dir: URL, prefix = ''): [string, string][] {
  const out: [string, string][] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...sourceFiles(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith('.ts')) {
      out.push([`${prefix}${entry.name}`, readFileSync(new URL(entry.name, dir), 'utf8')]);
    }
  }
  return out;
}

const SOURCES = sourceFiles(BACKEND_SRC);

/**
 * Stripe's refund surface, in the shapes the SDK exposes it. `inviteEmail.ts`
 * has a `refundDailyAllowance` that returns an internal invite allowance and
 * touches no money, so matching the bare word "refund" would be a false
 * positive; these patterns are the Stripe API specifically.
 */
const STRIPE_REFUND_PATTERNS: [string, RegExp][] = [
  ['stripe.refunds.*', /\brefunds\s*\.\s*(create|cancel|retrieve|list|update)\b/],
  ['a `.refunds` resource access', /\.\s*refunds\b/],
  ['Stripe.RefundCreateParams', /\bRefund(Create|Update|List)Params\b/],
  ['refund_application_fee', /\brefund_application_fee\b/],
];

describe('refund posture: the Terms describe a service with no refund path', () => {
  it('reads a real backend/src tree, so the scan below cannot pass vacuously', () => {
    expect(SOURCES.length).toBeGreaterThan(100);
    expect(SOURCES.some(([path]) => path === 'services/accountCleanup.ts')).toBe(true);
    expect(SOURCES.some(([path]) => path === 'services/billing.ts')).toBe(true);
  });

  for (const [label, pattern] of STRIPE_REFUND_PATTERNS) {
    it(`no path in backend/src calls ${label}`, () => {
      const hits = SOURCES.filter(([, text]) => pattern.test(text)).map(([path]) => path);
      expect(
        hits,
        'A refund path now exists. `legal.terms.refunds.policy` says nothing in the service ' +
          'issues a refund on its own — re-read that section (and docs/billing.md § Refunds) ' +
          'in this change, then update this test deliberately.'
      ).toEqual([]);
    });
  }
});

describe('refund posture: cancelling on a customer’s behalf returns nothing', () => {
  const cleanup = readFileSync(new URL('services/accountCleanup.ts', BACKEND_SRC), 'utf8');

  it('cancels the abandoned household subscription with Stripe’s defaults', () => {
    // Positive first: if the call is renamed or moved, this fails rather than
    // leaving the negative assertions below matching nothing forever.
    const call = cleanup.match(/subscriptions\s*\.\s*cancel\(\s*subscriptionId\s*,\s*(\{[^}]*\})/);
    expect(
      call,
      'accountCleanup no longer cancels via `stripe.subscriptions.cancel(subscriptionId, {…})`; ' +
        'find the new call and re-point this test at it'
    ).not.toBeNull();
    expect(call![1].replace(/\s+/gu, '')).toBe('{}');
  });

  it.each(['prorate', 'invoice_now', 'proration_behavior'])(
    'does not ask Stripe to settle the unused period with %s',
    (param) => {
      expect(
        cleanup.includes(param),
        `accountCleanup now passes \`${param}\`. Money may move on an account deletion that ` +
          'the Terms say returns nothing — re-read `legal.terms.refunds.cancelling`.'
      ).toBe(false);
    }
  );
});

describe('refund posture: the section is published, in both locales', () => {
  const locale = (tag: string) =>
    JSON.parse(
      readFileSync(new URL(`frontend/src/i18n/locales/${tag}/legal.json`, ROOT), 'utf8')
    ) as { legal: { terms: { refunds?: Record<string, string> } } };

  const KEYS = ['heading', 'cancelling', 'policy', 'oneTime', 'statutory'];

  it.each(['en', 'es'])('%s publishes every sentence of the refund section', (tag) => {
    const refunds = locale(tag).legal.terms.refunds;
    expect(
      refunds,
      `${tag}/legal.json has no legal.terms.refunds. The Terms carried no refund section at all ` +
        'until #426; do not go back to that silently.'
    ).toBeDefined();
    for (const key of KEYS) {
      expect(refunds![key], `${tag} legal.terms.refunds.${key}`).toBeTruthy();
    }
  });

  it.each([
    ['en', 'cancelling', 'does not return a charge already made'],
    ['en', 'policy', 'we do not publish a refund window'],
    ['en', 'policy', 'nothing in the service issues a refund on its own'],
    ['es', 'cancelling', 'no devuelve un cobro ya realizado'],
    ['es', 'policy', 'no publicamos un plazo de reembolso'],
    ['es', 'policy', 'el servicio no emite ningún reembolso por su cuenta'],
  ])('%s legal.terms.refunds.%s still states: %s', (tag, key, sentence) => {
    expect(locale(tag).legal.terms.refunds![key]).toContain(sentence);
  });

  it('states no refund window in either locale, because nothing tracks one', () => {
    // A window ("within 14 days", "en un plazo de 30 días") would start a
    // clock on a request the product cannot see: there is no ticket, no
    // request record, and no report of requests approaching a deadline. If
    // the owner decides on one, that machinery is what has to come with it.
    for (const tag of ['en', 'es']) {
      const text = Object.values(locale(tag).legal.terms.refunds!).join(' ');
      expect(text).not.toMatch(/within \d+ days|en un plazo de \d+ días|\d+-day refund/i);
    }
  });
});

describe('refund posture: the help centre and the Terms agree', () => {
  const help = readFileSync(new URL('frontend/src/features/help/helpContent.tsx', ROOT), 'utf8');

  it('still routes a questionable charge to support, case by case', () => {
    // The help article predates the Terms section and says the same thing.
    // If one moves without the other, a reader gets two answers about money.
    expect(help).toMatch(/case by case/i);
    expect(help).toMatch(/we don&rsquo;t publish a\s+refund window/i);
    expect(help).toMatch(/We do not publish a refund window/);
  });
});
