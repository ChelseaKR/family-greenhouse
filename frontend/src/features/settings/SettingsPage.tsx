import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { useLocation, useNavigate } from 'react-router';
import { track } from '@/services/analytics';
import { NotificationSettings } from './NotificationSettings';
import { BillingSettings } from './BillingSettings';
import { PreferencesSettings } from './PreferencesSettings';
import { ApiKeysSettings } from './ApiKeysSettings';
import { KioskSettings } from './KioskSettings';
import { ReferralSettings } from './ReferralSettings';
import { TagPinSettings } from '@/features/tags/TagPinSettings';
import { AccountSettings } from './AccountSettings';
import { TrashSettings } from './TrashSettings';
import { HouseholdChannelSettings } from './HouseholdChannelSettings';
import { SecuritySettings } from './SecuritySettings';
import { AboutSettings } from './AboutSettings';
import { isNativeApp } from '@/lib/platform';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { PageHeader } from '@/components/PageHeader';

type Tab =
  | 'preferences'
  | 'notifications'
  | 'plant-tags'
  | 'billing'
  | 'refer'
  | 'kiosk'
  | 'api-keys'
  | 'trash'
  | 'security'
  | 'account'
  | 'about';

const TABS: Tab[] = [
  'preferences',
  'notifications',
  'plant-tags',
  'billing',
  'refer',
  'kiosk',
  'api-keys',
  'trash',
  // Security sits before Account so Account stays the last tab (End key).
  'security',
  'account',
];

/**
 * The apps add About, last: it holds the memorial line, which in the apps
 * lives there and nowhere else (owner decision 2026-10-02). The website has
 * no About section; its pages close with the line instead.
 */
const NATIVE_TABS: Tab[] = [...TABS, 'about'];

const TAB_LABEL: Record<Tab, string> = {
  preferences: 'settings.tabs.preferences',
  notifications: 'settings.tabs.notifications',
  'plant-tags': 'settings.tabs.plantTags',
  billing: 'settings.tabs.billing',
  refer: 'settings.tabs.refer',
  kiosk: 'settings.tabs.kiosk',
  'api-keys': 'settings.tabs.apiKeys',
  trash: 'settings.tabs.trash',
  account: 'settings.tabs.account',
  security: 'settings.tabs.security',
  about: 'settings.tabs.about',
};

export function SettingsPage() {
  useDocumentTitle('Settings');
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const tabs = isNativeApp() ? NATIVE_TABS : TABS;
  const requestedSection = new URLSearchParams(location.search).get('section');
  const tab: Tab = location.pathname.endsWith('/billing')
    ? 'billing'
    : tabs.includes(requestedSection as Tab)
      ? (requestedSection as Tab)
      : 'preferences';

  // The upgrade funnel's "opened billing" step (docs/analytics.md). Keyed on
  // the resolved tab rather than the tab click, so a deep link or a redirect
  // to /settings/billing counts the same as choosing the tab.
  useEffect(() => {
    if (tab === 'billing') track('billing_opened');
  }, [tab]);

  function selectTab(nextTab: Tab) {
    if (nextTab === 'billing') {
      navigate('/settings/billing');
      return;
    }
    navigate(nextTab === 'preferences' ? '/settings' : `/settings?section=${nextTab}`);
  }

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, currentTab: Tab) {
    const currentIndex = tabs.indexOf(currentTab);
    let nextTab: Tab | undefined;
    if (event.key === 'ArrowRight') nextTab = tabs[(currentIndex + 1) % tabs.length];
    if (event.key === 'ArrowLeft') nextTab = tabs[(currentIndex - 1 + tabs.length) % tabs.length];
    if (event.key === 'Home') nextTab = tabs[0];
    if (event.key === 'End') nextTab = tabs[tabs.length - 1];
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
          {tabs.map((id) => (
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
            {tabs.map((id) => (
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
        {tab === 'notifications' && (
          <div className="space-y-6">
            <NotificationSettings />
            <HouseholdChannelSettings />
          </div>
        )}
        {tab === 'plant-tags' && <TagPinSettings />}
        {tab === 'billing' && <BillingSettings />}
        {tab === 'refer' && <ReferralSettings />}
        {tab === 'kiosk' && <KioskSettings />}
        {tab === 'api-keys' && <ApiKeysSettings />}
        {tab === 'trash' && <TrashSettings />}
        {tab === 'account' && <AccountSettings />}
        {tab === 'security' && <SecuritySettings />}
        {tab === 'about' && <AboutSettings />}
      </div>
    </div>
  );
}
