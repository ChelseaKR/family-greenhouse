import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { NotificationSettings } from './NotificationSettings';
import { BillingSettings } from './BillingSettings';
import { PreferencesSettings } from './PreferencesSettings';
import { ApiKeysSettings } from './ApiKeysSettings';
import { AccountSettings } from './AccountSettings';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { PageHeader } from '@/components/PageHeader';

type Tab = 'preferences' | 'notifications' | 'billing' | 'api-keys' | 'account';

const TABS: Tab[] = ['preferences', 'notifications', 'billing', 'api-keys', 'account'];

const TAB_LABEL: Record<Tab, string> = {
  preferences: 'settings.tabs.preferences',
  notifications: 'settings.tabs.notifications',
  billing: 'settings.tabs.billing',
  // These don't have translation keys yet — hardcoded literals until we
  // extend en/es locale files.
  'api-keys': 'API keys',
  account: 'Account',
};

export function SettingsPage() {
  useDocumentTitle('Settings');
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('preferences');

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Your account"
        title={t('settings.title')}
        description={t('settings.description')}
      />

      <div className="border-b border-gray-200">
        <nav className="-mb-px flex gap-6" aria-label="Settings sections">
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={clsx(
                'border-b-2 px-1 py-4 text-sm font-medium',
                tab === id
                  ? 'border-primary-500 text-primary-700'
                  : 'border-transparent text-gray-600 hover:border-gray-300 hover:text-gray-800'
              )}
              aria-current={tab === id ? 'page' : undefined}
            >
              {id === 'api-keys' || id === 'account' ? TAB_LABEL[id] : t(TAB_LABEL[id])}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'preferences' && <PreferencesSettings />}
      {tab === 'notifications' && <NotificationSettings />}
      {tab === 'billing' && <BillingSettings />}
      {tab === 'api-keys' && <ApiKeysSettings />}
      {tab === 'account' && <AccountSettings />}
    </div>
  );
}
