import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { EmptySearch } from './illustrations/EmptySearch';
import { useMetaTags } from '@/hooks/useMetaTags';
import { PublicShell } from './PublicShell';
import { useAuthStore } from '@/store/authStore';

export function NotFoundPage() {
  const { t } = useTranslation();
  // A signed-in reader gets the plain header, as on the help pages: the
  // public header's sign-up button is a dead end to someone already in.
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  useMetaTags({
    title: t('notFound.metaTitle'),
    description: t('notFound.metaDescription'),
    robots: 'noindex, nofollow',
  });

  // The site header and footer, like every other public page (IA decision
  // D1/D2, 2026-11-21), so a mistyped link still leads somewhere useful.
  return (
    <PublicShell plainHeader={isAuthenticated}>
      <div className="flex flex-col items-center text-center">
        <EmptySearch className="h-36 w-auto" />
        <h1 className="mt-6 font-serif text-4xl text-ink">{t('notFound.title')}</h1>
        <p className="mt-3 max-w-md text-gray-600">{t('notFound.body')}</p>
        <Link to="/" className="mt-8 btn-primary">
          {t('notFound.home')}
        </Link>
      </div>
    </PublicShell>
  );
}
