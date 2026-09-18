import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import clsx from 'clsx';

/** How far the finger has to travel, after resistance, to refresh. */
export const PULL_THRESHOLD_PX = 64;
const MAX_PULL_PX = 96;
/** Finger travel counts for half: the pull should feel like it resists. */
const RESISTANCE = 0.5;

/**
 * Pull down at the top of a screen to refresh it, inside the native shells.
 *
 * A browser tab has its own pull-to-refresh (or a reload button); the shells
 * have neither, since Capacitor turns the WebView's bounce off, and before
 * this the only way to see fresh data on a screen was to leave it and come
 * back. Refreshing marks every query stale and refetches the ones on screen.
 *
 * It only engages from the very top of the page, never from inside a field,
 * and never while a dialog is open. The indicator is decorative
 * (aria-hidden); a status region announces "Refreshing" and "Updated", and
 * the resume refresh and the connection notice's Try again button give
 * screen reader users the same result without the gesture. PullToRefresh.tsx
 * loads this module inside the shells only.
 */
export default function PullToRefreshGesture() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const refreshingRef = useRef(false);

  useEffect(() => {
    let startY: number | null = null;
    let distance = 0;

    const refresh = async () => {
      refreshingRef.current = true;
      setRefreshing(true);
      setAnnouncement(t('connection.refreshing'));
      try {
        await queryClient.invalidateQueries({ refetchType: 'active' });
      } finally {
        refreshingRef.current = false;
        setRefreshing(false);
        setAnnouncement(t('connection.refreshed'));
      }
    };

    const onStart = (event: TouchEvent) => {
      startY = null;
      if (refreshingRef.current || window.scrollY > 0 || event.touches.length !== 1) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      startY = event.touches[0].clientY;
    };
    const onMove = (event: TouchEvent) => {
      if (startY === null) return;
      const travel = event.touches[0].clientY - startY;
      distance = travel > 0 && window.scrollY <= 0 ? Math.min(travel * RESISTANCE, MAX_PULL_PX) : 0;
      setPull(distance);
    };
    const onEnd = () => {
      if (startY === null) return;
      startY = null;
      if (distance >= PULL_THRESHOLD_PX) void refresh();
      distance = 0;
      setPull(0);
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, [queryClient, t]);

  const visible = refreshing || pull > 0;
  const offset = refreshing ? PULL_THRESHOLD_PX : pull;
  return (
    <>
      <div
        aria-hidden="true"
        data-testid="pull-to-refresh-indicator"
        className={clsx(
          'pointer-events-none fixed inset-x-0 z-30 flex justify-center transition-opacity',
          visible ? 'opacity-100' : 'opacity-0'
        )}
        style={{
          top: `calc(env(safe-area-inset-top) + 4rem + ${offset - 40}px)`,
        }}
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-dew bg-paper shadow-card">
          <ArrowPathIcon
            className={clsx('h-5 w-5 text-primary-700', refreshing && 'animate-spin')}
            style={
              refreshing
                ? undefined
                : { transform: `rotate(${(pull / PULL_THRESHOLD_PX) * 270}deg)` }
            }
          />
        </span>
      </div>
      <p className="sr-only" role="status">
        {announcement}
      </p>
    </>
  );
}
