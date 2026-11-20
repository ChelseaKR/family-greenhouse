/**
 * Asks the screen on show to refresh, as pull to refresh does
 * (components/PullToRefreshGesture.tsx listens). Used by the iOS app's
 * tap-the-current-tab-again, a single-tap way to refresh (WCAG 2.5.7).
 */
export const REFRESH_REQUEST_EVENT = 'fg:refresh-request';

export function requestRefresh(): void {
  window.dispatchEvent(new Event(REFRESH_REQUEST_EVENT));
}
