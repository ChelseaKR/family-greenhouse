import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { useLocation, useNavigate } from 'react-router-dom';
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
  'api-keys': 'settings.tabs.apiKeys',
  account: 'settings.tabs.account',
};

export function SettingsPage() {
  useDocumentTitle('Settings');
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const requestedSection = new URLSearchParams(location.search).get('section');
  const tab: Tab = location.pathname.endsWith('/billing')
    ? 'billing'
    : TABS.includes(requestedSection as Tab)
      ? (requestedSection as Tab)
      : 'preferences';

  function selectTab(nextTab: Tab) {
    if (nextTab === 'billing') {
      navigate('/settings/billing');
      return;
    }
    navigate(nextTab === 'preferences' ? '/settings' : `/settings?section=${nextTab}`);
  }

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, currentTab: Tab) {
    const currentIndex = TABS.indexOf(currentTab);
    let nextTab: Tab | undefined;
    if (event.key === 'ArrowRight') nextTab = TABS[(currentIndex + 1) % TABS.length];
    if (event.key === 'ArrowLeft') nextTab = TABS[(currentIndex - 1 + TABS.length) % TABS.length];
    if (event.key === 'Home') nextTab = TABS[0];
    if (event.key === 'End') nextTab = TABS[TABS.length - 1];
    if (!nextTab) return;

    event.preventDefault();
    selectTab(nextTab);
    requestAnimationFrame(() => document.getElementById(`settings-tab-${nextTab}`)?.focus());
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Your account"
        title={t('settings.title')}
        description={t('settings.description')}
      />

      <label className="block sm:hidden">
        <span className="label">Settings section</span>
        <select
          className="input"
          value={tab}
          onChange={(event) => selectTab(event.target.value as Tab)}
        >
          {TABS.map((id) => (
            <option key={id} value={id}>
              {t(TAB_LABEL[id])}
            </option>
          ))}
        </select>
      </label>

      <div className="hidden border-b border-primary-100/80 sm:block">
        <nav aria-label="Settings sections">
          <div
            className="-mb-px flex gap-3 overflow-x-auto sm:gap-6"
            role="tablist"
            aria-orientation="horizontal"
          >
            {TABS.map((id) => (
              <button
                key={id}
                id={`settings-tab-${id}`}
                type="button"
                role="tab"
                onClick={() => selectTab(id)}
                onKeyDown={(event) => handleTabKeyDown(event, id)}
                className={clsx(
                  'min-h-touch shrink-0 border-b-2 px-1 py-4 text-sm font-medium',
                  tab === id
                    ? 'border-primary-500 text-primary-700'
                    : 'border-transparent text-gray-600 hover:border-primary-200 hover:text-ink'
                )}
                aria-selected={tab === id}
                aria-controls="settings-panel"
                tabIndex={tab === id ? 0 : -1}
              >
                {t(TAB_LABEL[id])}
              </button>
            ))}
          </div>
        </nav>
      </div>

      <div id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
        {tab === 'preferences' && <PreferencesSettings />}
        {tab === 'notifications' && <NotificationSettings />}
        {tab === 'billing' && <BillingSettings />}
        {tab === 'api-keys' && <ApiKeysSettings />}
        {tab === 'account' && <AccountSettings />}
      </div>
    </div>
  );
}
