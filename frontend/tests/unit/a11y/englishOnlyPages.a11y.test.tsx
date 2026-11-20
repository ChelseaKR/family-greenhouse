import { afterEach, beforeAll, describe, it, expect } from 'vitest';
import i18n from '@/i18n';
import { ensureLocaleCatalog } from '@/i18n/nonEnglishCatalog';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { PublicShell } from '@/components/PublicShell';
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage';
import { HelpPage } from '@/features/help/HelpPage';
import { HelpTopicPage } from '@/features/help/HelpTopicPage';
import { BlogIndex } from '@/features/blog/BlogIndex';
import { ChangelogPage } from '@/features/changelog/ChangelogPage';
import { CareGuidePage } from '@/features/care/CareGuidePage';
import { CareIndex } from '@/features/care/CareIndex';
import { HOLIDAY_CARE_GUIDES_ON } from '@/features/care/holidayGuideList';

/**
 * Pages that are written in English whatever language the visitor chose.
 *
 * `<html lang>` follows the visitor's language, so for a Spanish-speaking
 * visitor these pages were English text inside `lang="es"`: a screen reader
 * switches to its Spanish voice and reads English words by Spanish rules
 * (WCAG 3.1.2 Language of Parts). The page's own content is marked `lang="en"`;
 * the translated header and footer keep the page language.
 */
function renderAt(path: string, route: string, element: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('pages that have since been translated are no longer marked English', () => {
  beforeAll(async () => {
    await ensureLocaleCatalog(i18n, 'es');
  });
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  // Forgot and reset password were English-only and carried lang="en". They
  // are in the catalog now, so the mark has to go: left on a Spanish page it
  // would have a screen reader read Spanish by English rules.
  it.each([
    ['/forgot-password', <ForgotPasswordPage key="f" />, 'Restablece tu contraseña'],
    ['/reset-password', <ResetPasswordPage key="r" />, 'Falta el correo electrónico'],
  ])('%s is Spanish in Spanish, with no lang override', async (path, element, heading) => {
    await i18n.changeLanguage('es');
    renderAt(path, path, element);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.getByRole('main')).not.toHaveAttribute('lang');
  });
});

describe('English-only pages say so', () => {
  it('PublicShell puts the content language on <main>, and only when given one', () => {
    const { unmount } = render(
      <MemoryRouter>
        <PublicShell contentLang="en">
          <p>Body</p>
        </PublicShell>
      </MemoryRouter>
    );
    expect(screen.getByRole('main')).toHaveAttribute('lang', 'en');
    // The translated chrome is not inside it.
    expect(screen.getByRole('main')).not.toContainElement(screen.getByRole('contentinfo'));
    unmount();

    render(
      <MemoryRouter>
        <PublicShell>
          <p>Body</p>
        </PublicShell>
      </MemoryRouter>
    );
    expect(screen.getByRole('main')).not.toHaveAttribute('lang');
  });

  it.each([
    ['/help', '/help', <HelpPage key="h" />],
    ['/help/getting-started', '/help/:topicId', <HelpTopicPage key="t" />],
    ['/blog', '/blog', <BlogIndex key="b" />],
    ['/changelog', '/changelog', <ChangelogPage key="c" />],
  ])('%s marks its content as English', (path, route, element) => {
    renderAt(path, route, element);
    expect(screen.getByRole('main')).toHaveAttribute('lang', 'en');
  });
});

describe('care guides are English inside, with their translated pieces in the page language', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  // The guides and the index's intro and list are English by design; the
  // holiday list, the shop link and the index's household links are catalog
  // strings. Before 2026-11 neither was marked, so a Spanish visitor's screen
  // reader read the whole guide with Spanish rules (WCAG 3.1.2).
  it.each([
    ['/care/monstera', '/care/:slug', <CareGuidePage key="g" />],
    ['/care', '/care', <CareIndex key="i" />],
  ])(
    '%s marks its content English and its translated pieces Spanish',
    async (path, route, element) => {
      await ensureLocaleCatalog(i18n, 'es');
      await i18n.changeLanguage('es');
      renderAt(path, route, element);
      const main = screen.getByRole('main');
      expect(main).toHaveAttribute('lang', 'en');
      const holiday = screen.queryByRole('heading', {
        name: i18n.t('petSafeSpecies.holidayHeading'),
      });
      // The list is behind a seasonal switch; when it is on it must be marked.
      expect(Boolean(holiday)).toBe(HOLIDAY_CARE_GUIDES_ON);
      if (holiday) expect(holiday.closest('[lang]')).toHaveAttribute('lang', 'es');
      if (path === '/care') {
        const household = screen.getByRole('heading', {
          name: i18n.t('landing.care.householdHeading'),
        });
        expect(household.closest('[lang]')).toHaveAttribute('lang', 'es');
      }
    }
  );
});
