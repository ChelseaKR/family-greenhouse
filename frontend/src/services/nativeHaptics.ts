import { isNativeApp } from '@/lib/platform';

/**
 * A short haptic when care is recorded, inside the iOS/Android shells.
 *
 * Only after the server has accepted the change (the callers fire this from a
 * mutation's onSuccess), so the tap you feel means it is saved, not just that
 * the button was pressed. A completed task gets the system "success" pattern
 * and a snoozed one a single light tick. The OS decides whether to play
 * either: iOS honors Settings > Sounds & Haptics > System Haptics, and a
 * phone with touch feedback turned off stays silent.
 *
 * `@capacitor/haptics` is imported dynamically after the isNativeApp()
 * check, so web visitors never download it.
 */
export type HapticCue = 'completed' | 'snoozed';

export function playHaptic(cue: HapticCue): void {
  if (!isNativeApp()) return;
  void import('@capacitor/haptics')
    .then(({ Haptics, ImpactStyle, NotificationType }) =>
      cue === 'completed'
        ? Haptics.notification({ type: NotificationType.Success })
        : Haptics.impact({ style: ImpactStyle.Light })
    )
    .catch(() => undefined);
}
