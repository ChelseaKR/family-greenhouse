import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { analyticsOptedOut, analyticsOptOutStored } from '@/services/analytics';
import { setAnalyticsPreference } from '@/services/googleAnalytics';

type State = 'on' | 'offHere' | 'offBySignal';

function readState(): State {
  if (analyticsOptOutStored()) return 'offHere';
  // GPC or DNT: already off, and not ours to switch back on.
  if (analyticsOptedOut()) return 'offBySignal';
  return 'on';
}

const LINK_CLASS =
  'inline-flex min-h-6 items-center text-sm text-primary-200 underline underline-offset-2 hover:text-white';

/**
 * The public "Opt out of analytics" control in the site footers — the way a
 * visitor with no account, or no browser privacy signal, turns off Google
 * Analytics and PostHog. It is the same per-device switch as Settings →
 * Preferences → Product analytics (`setAnalyticsPreference`), remembered on
 * this device until "Opt back in"; the privacy page describes it.
 *
 * A button, not a link: it changes a setting rather than going anywhere. It
 * renders nothing until mounted, because the prerendered HTML cannot know this
 * device's choice and a server/client mismatch would throw the hydrated tree
 * away. The button keeps its slot across states so focus stays on it after a
 * click.
 */
export function AnalyticsOptOutToggle({
  as: Wrapper = 'p',
  className,
}: {
  as?: 'p' | 'li';
  className?: string;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<State | null>(null);
  useEffect(() => setState(readState()), []);
  if (state === null) return null;

  const choose = (optOut: boolean) => {
    setAnalyticsPreference(optOut);
    setState(readState());
  };

  return (
    <Wrapper className={className}>
      {state === 'offHere' ? (
        <span className="text-sm text-primary-200">
          {t('settings.preferences.analyticsOffHere')}{' '}
        </span>
      ) : null}
      {state === 'offBySignal' ? (
        <span className="text-sm text-primary-200">
          {t('settings.preferences.analyticsOffBySignal')}
        </span>
      ) : (
        <button type="button" className={LINK_CLASS} onClick={() => choose(state === 'on')}>
          {state === 'on'
            ? t('settings.preferences.analyticsOptOutLink')
            : t('settings.preferences.analyticsOptBackIn')}
        </button>
      )}
    </Wrapper>
  );
}
