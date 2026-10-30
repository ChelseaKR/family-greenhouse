import { describe, expect, it } from 'vitest';
import en from '@/i18n/locales/en/translation.json';
import es from '@/i18n/locales/es/translation.json';
import { changePlanDescription } from '@/features/settings/changePlanDescription';
import { formatDate } from '@/i18n/format';
import type { SubscriptionState } from '@/services/billingService';

/**
 * No stacked trials (owner decision 2026-10-23). The sentence above the plan
 * grid must name the first charge the checkout will actually make: for a
 * household on its no-card trial, the day that trial ends, never "14 days".
 */
type Catalog = Record<string, unknown>;
function translator(catalog: Catalog) {
  return (key: string, options?: Record<string, unknown>) => {
    const value = key.split('.').reduce<unknown>((o, part) => (o as Catalog)?.[part], catalog);
    if (typeof value !== 'string') throw new Error(`missing key ${key}`);
    return value.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(options?.[name] ?? ''));
  };
}
const t = translator(en as Catalog);
const FALLBACK = 'settings.billing.changePlanDescriptionTrial';
const ENDS = '2026-11-10T18:00:00.000Z';

describe('changePlanDescription', () => {
  it('names the no-card trial end as the first charge when checkout will defer to it', () => {
    const sub: SubscriptionState = {
      planId: 'seedling',
      trialAvailable: true,
      checkoutTrialEndsAt: ENDS,
      noCardTrial: { state: 'active', endsAt: ENDS },
    };
    const text = changePlanDescription(t, sub, FALLBACK);
    const date = formatDate(ENDS, { month: 'long' });
    expect(text).toContain(`Add a card now; your first charge is on ${date}`);
    expect(text).not.toMatch(/14/);
  });

  it('says a household too close to its no-card trial end is charged at once', () => {
    const sub: SubscriptionState = {
      planId: 'seedling',
      trialAvailable: false,
      noCardTrial: { state: 'active', endsAt: ENDS },
    };
    const text = changePlanDescription(t, sub, 'settings.billing.changePlanDescriptionTrialUsed');
    expect(text).toContain('too soon to move the first charge');
    expect(text).toContain('charged when you start it');
  });

  it('keeps the caller’s three-state sentence in every other case', () => {
    expect(changePlanDescription(t, { planId: 'seedling', trialAvailable: true }, FALLBACK)).toBe(
      t(FALLBACK)
    );
    expect(
      changePlanDescription(
        t,
        {
          planId: 'seedling',
          trialAvailable: false,
          noCardTrial: { state: 'ended', endsAt: ENDS },
        },
        'settings.billing.changePlanDescriptionTrialUsed'
      )
    ).toBe(t('settings.billing.changePlanDescriptionTrialUsed'));
    expect(changePlanDescription(t, undefined, 'settings.billing.changePlanDescription')).toBe(
      t('settings.billing.changePlanDescription')
    );
  });

  it('never names a date the server did not publish as a checkout date', () => {
    // A running no-card trial alone is not evidence of the deferral: the
    // server decides (`trialAvailable` + `checkoutTrialEndsAt`).
    const sub: SubscriptionState = {
      planId: 'seedling',
      noCardTrial: { state: 'active', endsAt: ENDS },
    };
    expect(changePlanDescription(t, sub, 'settings.billing.changePlanDescription')).toBe(
      t('settings.billing.changePlanDescription')
    );
  });

  it('has Spanish for both new sentences', () => {
    const tEs = translator(es as Catalog);
    expect(
      tEs('settings.billing.changePlanDescriptionTrialUntil', { date: '10 de noviembre de 2026' })
    ).toContain('Añade una tarjeta ahora; tu primer cobro será el 10 de noviembre de 2026');
    expect(tEs('settings.billing.changePlanDescriptionTrialEndingSoon', { date: 'x' })).toContain(
      'demasiado pronto'
    );
  });
});
