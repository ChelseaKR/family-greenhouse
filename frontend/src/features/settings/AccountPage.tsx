import { Link } from 'react-router-dom';
import { AccountSettings } from './AccountSettings';
import { BrandMark } from '@/components/BrandMark';
import { PageHeader } from '@/components/PageHeader';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useTranslation } from 'react-i18next';

/**
 * Account-only surface that does not require a household. A newly registered
 * user can therefore export or delete their account directly from onboarding,
 * satisfying the native-store requirement that deletion not be gated behind
 * completing app setup.
 */
export function AccountPage() {
  const { t } = useTranslation();
  useDocumentTitle('Account');
  return (
    <div className="min-h-screen bg-paper">
      <header className="border-b border-dew/60 bg-paper/95">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Link to="/" aria-label="Family Greenhouse home">
            <BrandMark variant="wordmark" size="sm" compactOnMobile />
          </Link>
          <Link
            to="/onboarding"
            className="text-sm font-medium text-primary-700 underline underline-offset-2"
          >
            {t('mobile.backToSetup')}
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 sm:py-12">
        <PageHeader
          eyebrow="Your account"
          title="Account & data"
          description="Manage your profile, download your data, or permanently delete your account."
        />
        <AccountSettings />
      </main>
    </div>
  );
}
