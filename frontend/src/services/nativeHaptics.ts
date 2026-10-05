import { isNativeApp } from '@/lib/platform';

/**
 * Short haptics inside the iOS/Android shells, as Apple's own apps use them.
 *
 * - `completed`, `added`: the system "success" pattern, once the server has
 *   accepted the change (care recorded, a plant or a task added).
 * - `snoozed`: a single light tick.
 * - `selection`: the selection tick, when a segment or a tab changes.
 * - `warning`: the system "warning" pattern, when a destructive confirmation
 *   (delete, remove, leave) appears.
 *
 * Care: a haptic when care is recorded.
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
export type HapticCue = 'completed' | 'added' | 'snoozed' | 'selection' | 'warning';

export function playHaptic(cue: HapticCue): void {
  if (!isNativeApp()) return;
  void import('@capacitor/haptics')
    .then(async ({ Haptics, ImpactStyle, NotificationType }) => {
      if (cue === 'completed' || cue === 'added')
        return Haptics.notification({ type: NotificationType.Success });
      if (cue === 'warning') return Haptics.notification({ type: NotificationType.Warning });
      if (cue === 'selection') {
        // The plugin's selectionChanged() plays nothing without a
        // selectionStart() first (it has no generator until then).
        await Haptics.selectionStart();
        await Haptics.selectionChanged();
        return Haptics.selectionEnd();
      }
      return Haptics.impact({ style: ImpactStyle.Light });
    })
    .catch(() => undefined);
}
