/**
 * ADR 0042 copy guards: the prices every public surface states, in both
 * locales, are the catalog's; the identification sentence is the honest one;
 * and nothing anywhere claims identification is unlimited or part of Garden.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const json = (p: string) => JSON.parse(read(p)) as Record<string, unknown>;

const plans = read('backend/src/models/plans.ts');
const MONTHLY = plans.match(/id: 'garden'[\s\S]*?monthlyPrice: ([\d.]+)/)![1];
const ANNUAL = plans.match(/id: 'garden'[\s\S]*?annualPrice: ([\d.]+)/)![1];

function walk(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (node && typeof node === 'object') Object.values(node).forEach((v) => walk(v, out));
  return out;
}

describe('the repriced Garden plan, as the public copy states it', () => {
  it('is $2.99 a month or $24.99 a year in the catalog', () => {
    expect(MONTHLY).toBe('2.99');
    expect(ANNUAL).toBe('24.99');
  });

  it('is stated with the catalog prices in the help FAQ and llms.txt', () => {
    const help = read('frontend/src/features/help/helpContent.tsx').replace(/\s+/g, ' ');
    expect(help).toContain(`Garden is $${MONTHLY} a month or $${ANNUAL} a year`);
    expect(read('frontend/public/llms.txt')).toContain(
      `Garden is $${MONTHLY} a month or $${ANNUAL} a year`
    );
    for (const stale of ['$4.99 a month', '$39.99']) {
      expect(read('frontend/public/llms.txt')).not.toContain(stale);
    }
  });

  it('puts the identification sentence in the FAQ, the pricing page and the Terms, in both locales', () => {
    const help = read('frontend/src/features/help/helpContent.tsx').replace(/\s+/g, ' ');
    expect(help).toContain(
      'Identification is sold as a 20-identification pack for $1.99; it is not included in Garden.'
    );
    const en = json('frontend/src/i18n/locales/en/translation.json') as {
      pricing: Record<string, string>;
    };
    const es = json('frontend/src/i18n/locales/es/translation.json') as {
      pricing: Record<string, string>;
    };
    expect(en.pricing.identificationNote).toContain('is not included in Garden');
    expect(es.pricing.identificationNote).toContain('no está incluida en Garden');
    // Same placeholders in both locales, so neither can drop the price.
    for (const l of [en, es]) {
      expect(l.pricing.identificationNote).toContain('{{price}}');
      expect(l.pricing.identificationNote).toContain('{{credits}}');
    }
    const enT = json('frontend/src/i18n/locales/en/legal.json') as any;
    const esT = json('frontend/src/i18n/locales/es/legal.json') as any;
    expect(enT.legal.terms.oneTimePurchases.packs).toContain(
      'Plant identification is not included in the Garden plan; it is sold as a pack of 20 identifications'
    );
    expect(esT.legal.terms.oneTimePurchases.packs).toContain(
      'La identificación de plantas no está incluida en el plan Garden; se vende como un paquete de 20 identificaciones'
    );
  });

  it('claims no unlimited or bundled Garden identification anywhere a person reads', () => {
    const surfaces = [
      read('frontend/src/features/help/helpContent.tsx'),
      read('frontend/public/llms.txt'),
      read('store-assets/metadata/en-US.json'),
      ...walk(json('frontend/src/i18n/locales/en/translation.json')),
      ...walk(json('frontend/src/i18n/locales/es/translation.json')),
      ...walk(json('frontend/src/i18n/locales/en/legal.json')),
      ...walk(json('frontend/src/i18n/locales/es/legal.json')),
    ].join('\n');
    expect(surfaces).not.toMatch(/unlimited (plant )?identif/i);
    expect(surfaces).not.toMatch(/identificaciones ilimitadas/i);
    expect(surfaces).not.toMatch(/more plant identifications each month/i);
    expect(surfaces).not.toMatch(/30 on Garden/);
  });

  it('keeps the price strings consistent across locales', () => {
    const enT = JSON.stringify(json('frontend/src/i18n/locales/en/legal.json'));
    const esT = JSON.stringify(json('frontend/src/i18n/locales/es/legal.json'));
    // The Terms name no stale Garden price and both say yearly Garden is sold.
    for (const t of [enT, esT]) {
      expect(t).not.toContain('$4.99');
      expect(t).not.toContain('$39.99');
    }
    expect(enT).toMatch(/monthly or yearly/);
    expect(esT).toMatch(/mensual o anual/);
  });

  it('never says there is no tracking', () => {
    const all = [
      read('frontend/src/features/help/helpContent.tsx'),
      read('frontend/public/llms.txt'),
    ].join('\n');
    expect(all).not.toMatch(/no tracking/i);
  });
});
