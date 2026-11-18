import { describe, it, expect } from 'vitest';
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
    ['/forgot-password', '/forgot-password', <ForgotPasswordPage key="f" />],
    ['/reset-password?email=a%40example.com', '/reset-password', <ResetPasswordPage key="r" />],
    ['/help', '/help', <HelpPage key="h" />],
    ['/help/getting-started', '/help/:topicId', <HelpTopicPage key="t" />],
    ['/blog', '/blog', <BlogIndex key="b" />],
    ['/changelog', '/changelog', <ChangelogPage key="c" />],
  ])('%s marks its content as English', (path, route, element) => {
    renderAt(path, route, element);
    expect(screen.getByRole('main')).toHaveAttribute('lang', 'en');
  });
});
