import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createInstance, type i18n as I18nInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import esLegal from '@/i18n/locales/es/legal.json';
import es from '@/i18n/locales/es/translation.json';
import { loadLegalCatalog } from '@/i18n/legalCatalog';
import { AccountDeletionPage } from '@/features/legal/AccountDeletionPage';
import { PrivacyPage } from '@/features/legal/PrivacyPage';
import { SupportPage } from '@/features/legal/SupportPage';
import { TermsPage } from '@/features/legal/TermsPage';

/**
 * The legal pages render entirely from `legal.*` catalog keys. These tests
 * guard the two things that matter on pages where language access carries
 * legal weight:
 *
 *  1. A key that fails to resolve must never ship as a raw `legal.foo.bar`
 *     string — in either locale.
 *  2. A locale whose legal translation has not been reviewed
 *     (`REVIEWED_LEGAL_LOCALES` in reviewedLocales.ts) shows the draft notice and the
 *     governing-language line; English shows neither.
 */

/**
 * `effectiveEn` / `effectiveEs` are per page on purpose: each page carries its
 * own effective date and only the page whose text changed moves. Terms is a
 * day ahead of the rest because the commercial sections (renewal, cancelling,
 * the trial, price changes, one-time purchases) landed after the others.
 */
const PAGES = [
  {
    name: 'privacy',
    Page: PrivacyPage,
    en: 'Privacy',
    es: 'Privacidad',
    effectiveEn: 'Effective September 2, 2026.',
    effectiveEs: 'Vigente desde el 2 de septiembre de 2026.',
  },
  {
    name: 'terms',
    Page: TermsPage,
    en: 'Terms of Service',
    es: 'Términos del servicio',
    effectiveEn: 'Effective September 3, 2026.',
    effectiveEs: 'Vigente desde el 3 de septiembre de 2026.',
  },
  {
    name: 'support',
    Page: SupportPage,
    en: 'Support',
    es: 'Soporte',
    effectiveEn: 'Effective September 2, 2026.',
    effectiveEs: 'Vigente desde el 2 de septiembre de 2026.',
  },
  {
    name: 'account deletion',
    Page: AccountDeletionPage,
    en: 'Delete your account',
    es: 'Eliminar tu cuenta',
    effectiveEn: 'Effective September 2, 2026.',
    effectiveEs: 'Vigente desde el 2 de septiembre de 2026.',
  },
] as const;

const RAW_KEY = /\blegal\.(shell|support|accountDeletion|terms|privacy)\./;

let spanish: I18nInstance;

beforeAll(async () => {
  // `legal.*` is a deferred catalog fragment: App.tsx awaits it inside the
  // route's lazy() factory, but these tests mount the page components directly,
  // so they have to register it themselves — on the shared instance for the
  // English cases, and by hand for the standalone Spanish one.
  await loadLegalCatalog();

  spanish = createInstance();
  await spanish.init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: { ...es, ...esLegal } } },
    interpolation: { escapeValue: false },
  });
});

function renderEnglish(Page: () => JSX.Element) {
  return render(
    <MemoryRouter>
      <Page />
    </MemoryRouter>
  );
}

function renderSpanish(Page: () => JSX.Element) {
  return render(
    <I18nextProvider i18n={spanish}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </I18nextProvider>
  );
}

describe.each(PAGES)('legal page: $name', ({ Page, en, es: esTitle, effectiveEn, effectiveEs }) => {
  it('renders English from the catalog with a localized effective date and no draft notice', () => {
    const { container } = renderEnglish(Page);
    expect(screen.getByRole('heading', { level: 1, name: en })).toBeInTheDocument();
    expect(screen.getByText(effectiveEn)).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(RAW_KEY);
  });

  it('renders Spanish from the catalog, flagged as a draft where English governs', () => {
    const { container } = renderSpanish(Page);
    expect(screen.getByRole('heading', { level: 1, name: esTitle })).toBeInTheDocument();
    expect(screen.getByText(effectiveEs)).toBeInTheDocument();
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(/borrador/);
    expect(note).toHaveTextContent(/prevalece la versión en inglés/);
    expect(container.textContent).not.toMatch(RAW_KEY);
    expect(container.textContent).not.toContain('Effective ');
  });

  it('gives every link an accessible name in Spanish (Trans-mapped anchors are not empty)', () => {
    renderSpanish(Page);
    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link, `${link.getAttribute('href')} has no text`).not.toHaveTextContent(/^\s*$/);
    }
  });
});

describe('legal pages: link targets survive localization', () => {
  it('support page keeps its deletion, help, status, and mailto links in Spanish', () => {
    renderSpanish(SupportPage);
    expect(screen.getByRole('link', { name: 'support@familygreenhouse.net' })).toHaveAttribute(
      'href',
      'mailto:support@familygreenhouse.net'
    );
    expect(screen.getByRole('link', { name: /guía pública de eliminación/ })).toHaveAttribute(
      'href',
      '/account-deletion'
    );
    expect(screen.getByRole('link', { name: /páginas de ayuda/ })).toHaveAttribute('href', '/help');
    expect(screen.getByRole('link', { name: /página de estado del servicio/ })).toHaveAttribute(
      'href',
      '/status'
    );
  });

  it('account-deletion page sends a signed-out Spanish reader to /login', () => {
    renderSpanish(AccountDeletionPage);
    expect(
      screen.getByRole('link', { name: 'Inicia sesión para eliminar tu cuenta' })
    ).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'support@familygreenhouse.net' })).toHaveAttribute(
      'href',
      expect.stringContaining('mailto:support@familygreenhouse.net')
    );
  });

  it('terms and privacy cross-link each other in Spanish', () => {
    renderSpanish(TermsPage);
    expect(screen.getByRole('link', { name: 'Política de privacidad' })).toHaveAttribute(
      'href',
      '/legal/privacy'
    );
  });
});
