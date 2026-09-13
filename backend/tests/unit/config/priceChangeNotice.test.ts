import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLANS } from '../../../src/models/plans.js';
import { IDENTIFY_TOP_UP_PACK } from '../../../src/models/identifyTopUp.js';

/**
 * The Terms make a price promise (#710): a new price applies to new
 * subscriptions, a live subscription keeps the price it started at, and if
 * that ever has to change the household's admins are emailed at least 14 days
 * beforehand.
 *
 * The sentence it replaced promised an *in-app* notice, and there is no in-app
 * announcement mechanism of any kind — no policy version, no banner, no stored
 * acknowledgement. Nothing in this file builds one. What it does is make the
 * promise that is now published impossible to break silently:
 *
 *  1. **Every sellable price is pinned here.** Changing one means editing this
 *     test in the same PR, and the message below is what the editor reads at
 *     that moment. This is a speed bump, not a notifier: it does not send
 *     anything and does not know whether a notice went out. It only guarantees
 *     that a price cannot move while nobody is looking.
 *  2. **The live Stripe price ids are pinned too**, because the other way to
 *     re-price an existing subscriber is to point their plan at a different
 *     Stripe price rather than to change a number here.
 *  3. **No path re-prices a live subscription.** A price is set once, at
 *     checkout; nothing calls `subscriptions.update` to swap the item under a
 *     running subscription. That is what makes the published guarantee true
 *     today rather than aspirational.
 *  4. **The published sentences are held to all of the above**, in both
 *     locales, and the withdrawn in-app promise cannot come back without
 *     failing here.
 *
 * If a first-login announcement banner is ever built, item 4's last assertion
 * is the one to delete — deliberately, in that change.
 */

const ROOT = new URL('../../../../', import.meta.url);

const legal = (tag: string) =>
  JSON.parse(
    readFileSync(new URL(`frontend/src/i18n/locales/${tag}/legal.json`, ROOT), 'utf8')
  ) as {
    legal: {
      terms: Record<string, Record<string, string>>;
      privacy: Record<string, Record<string, string>>;
    };
  };

describe('price changes: every sellable price is pinned', () => {
  /**
   * Read as: "moving any number in this table is a consumer-notice event."
   * `legal.terms.priceChanges.body` says an existing subscription is not moved
   * onto a new price, and that a change is emailed 14 days ahead. Update the
   * expectation here in the same change that moves the price, and send the
   * notice — nothing else in this repository will remind you.
   */
  const WHY =
    'A plan price moved. The Terms promise an existing subscription keeps its own price and ' +
    'that any change reaches the household admins by email at least 14 days ahead. Update this ' +
    'pin deliberately, in the change that moves the price, and see docs/billing.md § Price changes.';

  it('has exactly the three plans this pin was written against', () => {
    expect(Object.keys(PLANS)).toEqual(['seedling', 'garden', 'greenhouse']);
  });

  it.each([
    ['seedling', 'monthlyPrice', 0],
    ['garden', 'monthlyPrice', 4.99],
    ['garden', 'annualPrice', 39.99],
    ['garden', 'lifetimePrice', 149],
    ['greenhouse', 'monthlyPrice', 9.99],
    ['greenhouse', 'annualPrice', 79.99],
  ] as const)('%s %s is %d', (planId, field, expected) => {
    expect(PLANS[planId][field], WHY).toBe(expected);
  });

  it('prices the identification pack at 20 for $1.99', () => {
    // Not yet on sale (`stripe_price_id_identify_top_up` is empty in
    // production), so this pin costs nothing today. It exists so the price
    // cannot drift between ADR 0019's margin table and the checkout.
    expect(IDENTIFY_TOP_UP_PACK.priceUsd, WHY).toBe(1.99);
    expect(IDENTIFY_TOP_UP_PACK.credits).toBe(20);
  });
});

describe('price changes: the live Stripe price ids are pinned', () => {
  const tfvars = readFileSync(
    new URL('infrastructure/environments/production/terraform.tfvars', ROOT),
    'utf8'
  );

  const idFor = (name: string) => tfvars.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];

  it.each([
    ['stripe_price_id_garden', 'price_1Tkur4AhnUt8CMG0b07WYF1t'],
    ['stripe_price_id_garden_annual', 'price_1TkurVAhnUt8CMG0ebSAipxL'],
    ['stripe_price_id_garden_lifetime', 'price_1Tkus1AhnUt8CMG0JkC7YgYO'],
    ['stripe_price_id_greenhouse', 'price_1UB7JuAhnUt8CMG05o9ktQLa'],
    ['stripe_price_id_greenhouse_annual', 'price_1UB7JuAhnUt8CMG0yFUs1tl8'],
  ])('%s still points at the price its subscribers bought', (name, expected) => {
    expect(
      idFor(name),
      'Production now bills this plan on a different Stripe price. Every household already ' +
        'subscribed on the old one renews on it, so this is the other shape of a price change ' +
        'and the same 14-day email obligation applies. The annual and lifetime ids are load- ' +
        'bearing even though those cadences are withdrawn from sale: existing subscribers still ' +
        'renew on them (ADR 0012).'
    ).toBe(expected);
  });

  it('leaves the identification top-up id free to be filled in', () => {
    // Deliberately NOT pinned to its current value. Setting this for the first
    // time puts a NEW product on sale (ADR 0019); it does not re-price anybody,
    // so it must not be gated behind a notice obligation that does not apply.
    expect(tfvars).toMatch(/^stripe_price_id_identify_top_up\s*=\s*"/m);
  });
});

describe('price changes: nothing re-prices a live subscription', () => {
  const backendSrc = new URL('backend/src/', ROOT);

  function sources(dir: URL, prefix = ''): [string, string][] {
    const out: [string, string][] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        out.push(...sources(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`));
      } else if (entry.name.endsWith('.ts')) {
        out.push([`${prefix}${entry.name}`, readFileSync(new URL(entry.name, dir), 'utf8')]);
      }
    }
    return out;
  }

  const SOURCES = sources(backendSrc);

  it('sets a price exactly once, at checkout', () => {
    // Positive control: if this stops matching, the scan below is looking at
    // the wrong thing and its silence means nothing.
    const checkout = SOURCES.find(([path]) => path === 'services/billing.ts');
    expect(checkout, 'services/billing.ts not found').toBeDefined();
    expect(checkout![1]).toMatch(/line_items:\s*\[\{\s*price:\s*priceId/);
  });

  it.each([
    ['subscriptions.update', /subscriptions\s*\.\s*update\s*\(/],
    ['subscriptionItems', /subscriptionItems\s*\./],
  ])('no path in backend/src calls %s', (_label, pattern: RegExp) => {
    const hits = SOURCES.filter(([, text]) => pattern.test(text)).map(([path]) => path);
    expect(
      hits,
      'Something can now change the item on a running subscription, which is how a subscriber ' +
        'gets moved onto a new price. `legal.terms.priceChanges.body` says that does not happen ' +
        'without 14 days of email notice — re-read it, and this test, in the same change.'
    ).toEqual([]);
  });
});

describe('price changes: the published sentences match all of the above', () => {
  it.each([
    ['en', 'we do not move a live subscription onto a different price'],
    ['en', 'email the household’s admins at least 14 days before the new price takes effect'],
    ['es', 'no trasladamos una suscripción activa a un precio distinto'],
    ['es', 'al menos 14 días antes de que el precio nuevo entre en vigor'],
  ])('%s states: %s', (tag, sentence) => {
    expect(legal(tag).legal.terms.priceChanges.body).toContain(sentence);
  });

  it.each([
    ['en', 'notice', 'We do not reduce a paid plan’s features or usage limits'],
    ['en', 'agreement', 'at least 14 days before it takes effect'],
    ['es', 'notice', 'No reducimos las funciones ni los límites de uso de un plan de pago'],
    ['es', 'agreement', 'con al menos 14 días de antelación'],
  ])('%s legal.terms.%s keeps its replacement clause', (tag, key, sentence) => {
    const catalog = legal(tag).legal.terms;
    const value = key === 'notice' ? catalog.fromUs.notice : catalog.agreement.body;
    expect(value).toContain(sentence);
  });

  /**
   * The withdrawn promise, and why this is a list of exact phrases rather than
   * a ban on the words "in-app" / "dentro de la aplicación".
   *
   * The replacement copy USES those words, to say the mechanism does not exist
   * ("we do not have an in-app announcement today"). A pattern that matched on
   * the phrase alone would fail on the honest sentence and pass on nothing —
   * the same shape as a regex that cannot read a negation. So this matches the
   * affirmative promise forms specifically, and each one is quoted from the
   * text it replaced.
   */
  it.each([
    ['en', 'announced in-app'],
    ['en', 'with at least 14 days’ notice'],
    ['en', '14 days of notice in-app'],
    ['en', 'show a one-time banner in the app'],
    ['es', 'se anunciarán dentro de la aplicación'],
    ['es', 'se anuncian dentro de la aplicación'],
    ['es', 'se anuncia dentro de la aplicación'],
    ['es', 'mostraremos un aviso único dentro de la aplicación'],
  ])('%s no longer promises: %s', (tag, promise) => {
    const catalog = legal(tag).legal;
    const published = [
      ...Object.values(catalog.terms).flatMap((section) => Object.values(section)),
      ...Object.values(catalog.privacy).flatMap((section) => Object.values(section)),
    ].join('\n');
    expect(published.length, 'the legal catalog read back empty').toBeGreaterThan(5000);
    expect(
      published,
      'An in-app notice promise is back. There is still no announcement mechanism — no policy ' +
        'version, no banner, no stored acknowledgement — so the sentence would not be true. ' +
        'If the banner has been built, delete this assertion in that change.'
    ).not.toContain(promise);
  });
});
