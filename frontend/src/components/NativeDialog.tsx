import { Suspense, lazy } from 'react';
import type { NativeDialogProps } from './native/NativePresenter';

const NativePresenter = lazy(() => import('./native/NativePresenter'));

/**
 * A dialog that opens as Apple's own alert or action sheet in the iOS app
 * (native/NativePresenter.tsx, a lazy chunk). Rendered only when
 * `hasNativePresent()`; the website renders its own dialogs and never
 * downloads the presenter.
 */
export function NativeDialog(props: NativeDialogProps) {
  return (
    <Suspense fallback={null}>
      <NativePresenter {...props} />
    </Suspense>
  );
}
