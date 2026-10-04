import { useRef, useState } from 'react';
import { hasNativePresent } from '@/lib/platform';
import { ActionSheet, type ActionSheetRequest } from './ActionSheet';

/**
 * One question with a few answers: Apple's action sheet in the iOS app, the
 * web sheet elsewhere. `choose` resolves the chosen id, or null for no
 * choice. Render `element` once in the page (it is the web sheet).
 */
export function useActionChooser() {
  const [sheet, setSheet] = useState<ActionSheetRequest | null>(null);
  const answer = useRef<((id: string | null) => void) | null>(null);

  const choose = (request: ActionSheetRequest, from?: Element | null): Promise<string | null> => {
    if (hasNativePresent()) {
      return import('@/services/nativePresent')
        .then(({ chooseFromMenu }) => chooseFromMenu({ ...request, from }))
        .catch(() => null);
    }
    answer.current?.(null);
    return new Promise((resolve) => {
      answer.current = resolve;
      setSheet(request);
    });
  };

  const element = (
    <ActionSheet
      request={sheet}
      onChoose={(id) => {
        setSheet(null);
        const resolve = answer.current;
        answer.current = null;
        // Answer once the tap that chose has finished. A choice can open the
        // next sheet at once (Snooze… asks how long), and a sheet opened in
        // the middle of that tap's click was closed again by the rest of it,
        // as a tap outside, so "Snooze…" on the website showed nothing.
        setTimeout(() => resolve?.(id), 0);
      }}
    />
  );

  return { choose, element };
}
