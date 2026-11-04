import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createInstance, type i18n as I18nInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import en from '@/i18n/locales/en/translation.json';
import es from '@/i18n/locales/es/translation.json';
import esLegal from '@/i18n/locales/es/legal.json';
import { loadLegalCatalog } from '@/i18n/legalCatalog';
import { SUPPORT_EMAIL } from '@/features/legal/contacts';
import { TermsPage } from '@/features/legal/TermsPage';

/**
 * Three things the Terms page has to say on a paid app with public plant and
 * pet-safety pages: who runs it and how to reach her, that plant-shop links
 * are paid, and that nothing here is veterinary advice. Each is checked in
 * both locales, because a Spanish reader gets only the Spanish text.
 *
 * The paid-link sentence quotes the label the link itself carries
 * (`plantShop.paidLink`, ADR 0038), so the test reads that label from the
 * catalog: renaming it without updating the Terms fails here.
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

function englishText() {
  return (
    render(
      <MemoryRouter>
        <TermsPage />
      </MemoryRouter>
    ).container.textContent ?? ''
  );
}

function spanishText() {
  return (
    render(
      <I18nextProvider i18n={spanish}>
        <MemoryRouter>
          <TermsPage />
        </MemoryRouter>
      </I18nextProvider>
    ).container.textContent ?? ''
  );
}

describe('terms: operator, paid links, and veterinary advice', () => {
  it.each([
    ['English', englishText],
    ['Spanish', spanishText],
  ])('%s names the operator, her state, and the support address', (_l, text) => {
    const body = text();
    expect(body).toContain('Chelsea Kelly-Reif');
    expect(body).toContain('California');
    expect(body).toContain(SUPPORT_EMAIL);
  });

  it('English quotes the label the paid link actually carries', () => {
    expect(englishText()).toContain(`“${en.plantShop.paidLink}”`);
  });

  it('Spanish quotes the label the paid link actually carries', () => {
    expect(spanishText()).toContain(`“${es.plantShop.paidLink}”`);
  });

  it.each([
    ['English', englishText, /veterinary advice/],
    ['Spanish', spanishText, /consejo veterinario/],
  ])('%s says it is not veterinary advice and names the ASPCA hotline', (_l, text, pattern) => {
    const body = text();
    expect(body).toMatch(pattern);
    expect(body).toContain('ASPCA Animal Poison Control Center');
  });
});
