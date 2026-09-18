import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BellAlertIcon } from '@heroicons/react/24/outline';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { useNativePush } from '@/hooks/useNativePush';
import { getErrorMessage } from '@/services/api';

/** When "Not now" was last tapped on this device. */
const DISMISSED_AT_KEY = 'fg.nativePush.promptDismissedAt';
/** How long "Not now" holds before the card may be shown again. */
const DISMISS_FOR_MS = 30 * 24 * 60 * 60_000;

function dismissedRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISSED_AT_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < DISMISS_FOR_MS;
  } catch {
    return false;
  }
}

interface NativePushPromptProps {
  /** Only offered to someone who has care coming up: that is the moment it is worth something. */
  hasUpcomingCare: boolean;
}

/**
 * The native notifications opt-in, shown where the value is plain: on the
 * task list, to someone who has care coming up. Never at launch, never as the
 * OS dialog out of nowhere — the OS asks only after "Turn on notifications"
 * is tapped, and only if it has never been asked before. A device that
 * already said no in the OS gets nothing here (Settings explains how to turn
 * it back on), and "Not now" holds for 30 days.
 *
 * Renders nothing on the web, in a build without push, or while the
 * deployment's `native_push_enabled` switch is off (see useNativePush).
 */
export function NativePushPrompt({ hasUpcomingCare }: NativePushPromptProps) {
  const { t } = useTranslation();
  const { offered, enabled, permission, enable } = useNativePush();
  const [dismissed, setDismissed] = useState(dismissedRecently);

  if (!offered || enabled || permission !== 'prompt' || dismissed || !hasUpcomingCare) {
    return null;
  }

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_AT_KEY, String(Date.now()));
    } catch {
      // Storage blocked: hide it for this visit only.
    }
    setDismissed(true);
  };

  return (
    <Card variant="paper" padding="sm" className="space-y-3">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-100 text-primary-800">
          <BellAlertIcon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-ink">{t('nativePush.promptTitle')}</h2>
          <p className="mt-1 text-sm text-gray-700">{t('nativePush.promptBody')}</p>
        </div>
      </div>
      {enable.isError && <Alert variant="error">{getErrorMessage(enable.error)}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => enable.mutate()} isLoading={enable.isPending}>
          {t('nativePush.promptEnable')}
        </Button>
        <Button size="sm" variant="secondary" onClick={dismiss} disabled={enable.isPending}>
          {t('nativePush.promptDismiss')}
        </Button>
      </div>
    </Card>
  );
}
