import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { isNativeApp } from '@/lib/platform';

/**
 * Permission before personal data goes to a third-party service, inside the
 * iOS and Android apps (App Review Guideline 5.1.2(i): disclose where personal
 * data is shared with third parties, "including with third-party AI", and
 * "obtain explicit permission before doing so").
 *
 * Three uses, each asked separately because each sends something different:
 *
 *   - `chat`: the question and the household's plant and task details, to
 *     Amazon Bedrock (Anthropic's Claude, through our AWS account).
 *   - `leafHealth`: the leaf photo and the plant's name, to Amazon Bedrock.
 *   - `identify`: the photo, to Plant.id (Kindwise), whose terms let it keep
 *     and reuse the photos it receives.
 *
 * The dialog names the service and what goes to it, before anything is sent.
 * "Allow" sends and is remembered on this device; "Not now" sends nothing and
 * remembers nothing, so the next try asks again. The website asks nothing:
 * the privacy policy is its disclosure, and the App Store rule is the app's.
 *
 * Remembered in localStorage, per device. When storage is blocked a yes lasts
 * for this session only, and the next launch asks again: the failure mode is
 * asking twice, never sending without asking.
 */

export type ThirdPartyUse = 'chat' | 'leafHealth' | 'identify';

const STORAGE_PREFIX = 'fg.thirdPartyConsent.';
const GRANTED = 'granted';

/** Yeses given while storage was blocked; this session only. */
const sessionGrants = new Set<ThirdPartyUse>();

/** Whether this device already said yes to `use`. Always true on the website. */
export function hasThirdPartyConsent(use: ThirdPartyUse): boolean {
  if (!isNativeApp()) return true;
  try {
    return localStorage.getItem(STORAGE_PREFIX + use) === GRANTED;
  } catch {
    return sessionGrants.has(use);
  }
}

/** Record a yes for `use` on this device. Exported for the tests' setup. */
export function grantThirdPartyConsent(use: ThirdPartyUse): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + use, GRANTED);
  } catch {
    sessionGrants.add(use);
  }
}

export function useThirdPartyConsent(use: ThirdPartyUse): {
  /** Runs `action` now if this device said yes, or after the person allows it. */
  run: (action: () => void) => void;
  /** The permission dialog; render it once, anywhere in the caller's tree. */
  dialog: ReactNode;
} {
  const { t } = useTranslation();
  const [pending, setPending] = useState<(() => void) | null>(null);

  const run = useCallback(
    (action: () => void) => {
      if (hasThirdPartyConsent(use)) action();
      else setPending(() => action);
    },
    [use]
  );

  const dialog = (
    <ConfirmDialog
      isOpen={pending !== null}
      onClose={() => setPending(null)}
      onConfirm={() => {
        grantThirdPartyConsent(use);
        const action = pending;
        setPending(null);
        action?.();
      }}
      title={t(`thirdPartyConsent.${use}.title`)}
      message={t(`thirdPartyConsent.${use}.body`)}
      confirmLabel={t('thirdPartyConsent.allow')}
      cancelLabel={t('thirdPartyConsent.notNow')}
      variant="primary"
    />
  );

  return { run, dialog };
}
