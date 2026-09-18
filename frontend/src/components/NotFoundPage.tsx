import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { EmptySearch } from './illustrations/EmptySearch';
import { useMetaTags } from '@/hooks/useMetaTags';

export function NotFoundPage() {
  const { t } = useTranslation();
  useMetaTags({
    title: t('notFound.metaTitle'),
    description: t('notFound.metaDescription'),
    robots: 'noindex, nofollow',
  });

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 bg-paper text-center">
      <EmptySearch className="h-36 w-auto" />
      <h1 className="mt-6 font-serif text-4xl text-ink">{t('notFound.title')}</h1>
      <p className="mt-3 max-w-md text-gray-600">{t('notFound.body')}</p>
      <Link to="/" className="mt-8 btn-primary">
        {t('notFound.home')}
      </Link>
    </main>
  );
}
