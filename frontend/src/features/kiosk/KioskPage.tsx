import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CheckIcon, MapPinIcon } from '@heroicons/react/24/outline';
import { useMetaTags } from '@/hooks/useMetaTags';
import {
  kioskService,
  KioskLinkInactiveError,
  KIOSK_FALLBACK_POLL_SECONDS,
  type KioskTask,
} from '@/services/kioskService';
import { formatTime } from '@/i18n/format';

/**
 * The wall display. A spare tablet in the kitchen, an old monitor in an office
 * breakroom: it shows what needs doing today across the whole household, big
 * enough to read across a room, and anyone standing in front of it can tap a
 * task done. No login, no navigation, nothing to click into.
 *
 * Three properties this page must keep:
 *
 *   1. NO NAVIGATION. There is no header, no link home, no marketing. The
 *      token grants a task list and nothing else, so the page must not offer
 *      a door to anywhere else — including back to Family Greenhouse.
 *   2. IT DEGRADES HONESTLY. A failed read renders "couldn't load", never an
 *      empty "all done" screen. On a wall display nobody re-checks: an empty
 *      list is read as "everything is fine" and believed. When a refresh
 *      fails, the last good list stays on screen with a visible stale marker
 *      rather than being replaced by nothing.
 *   3. IT SAYS WHAT IT IS. A permanent notice tells whoever walks past that
 *      the screen is showing a household's plant tasks — a surface that
 *      displays other people's data to a room should announce itself.
 *
 * The security posture (a permanently displayed 256-bit token, assumed
 * leaked, scoped to read-today + complete, revocable in one click) is
 * documented at the top of `backend/src/services/kioskService.ts`.
 */

/** Milliseconds in a second — poll intervals arrive from the API in seconds. */
const MS = 1000;

type Status = 'loading' | 'ready' | 'inactive' | 'error';

function dueLabelKey(task: KioskTask, now: number): string {
  if (task.overdue) return 'kiosk.due.overdue';
  const days = Math.round((new Date(task.dueDate).getTime() - now) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'kiosk.due.today';
  return 'kiosk.due.tomorrow';
}

/**
 * Ask the browser to keep the screen awake. Supported on Chrome/Edge/Safari
 * 16.4+ over HTTPS; everywhere else the request throws or the API is absent,
 * and the page falls back to telling the household to turn off the device's
 * own sleep timer. Returns whether the lock is held, so the hint is shown
 * only when it is actually needed.
 */
function useScreenWakeLock(active: boolean): boolean {
  const [held, setHeld] = useState(false);
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const request = async () => {
      const wakeLock = navigator.wakeLock;
      if (!wakeLock) return;
      try {
        const sentinel = await wakeLock.request('screen');
        if (cancelled) {
          void sentinel.release();
          return;
        }
        sentinelRef.current = sentinel;
        setHeld(true);
        // The browser drops the lock whenever the tab is hidden; re-request
        // on release so a screensaver or an app switch doesn't permanently
        // end the wake lock on a display nobody is standing at.
        sentinel.addEventListener('release', () => setHeld(false));
      } catch {
        // Denied, unsupported, or insecure context — the on-screen hint
        // covers it. Never surface this as a page error.
        setHeld(false);
      }
    };

    void request();
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !sentinelRef.current) void request();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      const sentinel = sentinelRef.current;
      sentinelRef.current = null;
      if (sentinel) void sentinel.release().catch(() => undefined);
    };
  }, [active]);

  return held;
}

export function KioskPage() {
  const { token = '' } = useParams<{ token: string }>();
  const { t } = useTranslation();

  useMetaTags({
    title: 'Plant care today — Family Greenhouse',
    description: 'A household wall display of the plant care due today.',
  });

  const [tasks, setTasks] = useState<KioskTask[] | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [pollSeconds, setPollSeconds] = useState(KIOSK_FALLBACK_POLL_SECONDS);
  /** ISO time of the last SUCCESSFUL read, so a stale screen can say so. */
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  /** True when the newest refresh failed but an older list is still shown. */
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());

  const wakeLockHeld = useScreenWakeLock(status === 'ready' || status === 'error');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const view = await kioskService.getView(token, signal);
        setTasks(view.tasks);
        setPollSeconds(view.pollIntervalSeconds);
        setLastLoadedAt(new Date().toISOString());
        setStale(false);
        setStatus('ready');
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof KioskLinkInactiveError) {
          setStatus('inactive');
          setTasks(null);
          return;
        }
        // A failed refresh must never blank the list into "all done". Keep
        // the last good read on screen and mark it stale; only a first read
        // with nothing to fall back on shows the error screen.
        setStale(true);
        setStatus((current) => (current === 'ready' ? 'ready' : 'error'));
      }
    },
    [token]
  );

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // The poll. Interval comes from the server (the household chose it), and
  // the cost of this feature scales with it — see KIOSK_FALLBACK_POLL_SECONDS
  // and backend/src/services/kioskService.ts. A revoked link stops the timer.
  useEffect(() => {
    if (status === 'inactive') return;
    const id = window.setInterval(() => void load(), pollSeconds * MS);
    return () => window.clearInterval(id);
  }, [load, pollSeconds, status]);

  const handleComplete = useCallback(
    async (task: KioskTask) => {
      setPending((p) => new Set(p).add(task.taskId));
      try {
        await kioskService.completeTask(token, task.taskId, task.dueDate);
        setTasks((current) =>
          current ? current.filter((candidate) => candidate.taskId !== task.taskId) : current
        );
      } catch (err) {
        if (err instanceof KioskLinkInactiveError) {
          setStatus('inactive');
          setTasks(null);
          return;
        }
        // Leave the row tappable so somebody standing there can try again.
        setStale(true);
      } finally {
        setPending((p) => {
          const next = new Set(p);
          next.delete(task.taskId);
          return next;
        });
      }
    },
    [token]
  );

  const now = Date.now();

  return (
    <div className="flex min-h-screen flex-col bg-ink text-white">
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-8 sm:px-10">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">{t('kiosk.title')}</h1>

        {status === 'loading' && (
          <p className="mt-10 text-2xl text-white/70" role="status">
            {t('kiosk.loading')}
          </p>
        )}

        {status === 'inactive' && (
          <div className="mt-10 rounded-2xl border-2 border-white/25 p-8" role="status">
            <p className="text-3xl font-medium">{t('kiosk.inactive.title')}</p>
            <p className="mt-3 text-xl text-white/70">{t('kiosk.inactive.body')}</p>
          </div>
        )}

        {status === 'error' && (
          // The honest-degradation screen. Explicitly NOT an empty task list:
          // "couldn't load" and "nothing to do" must never look the same.
          <div className="mt-10 rounded-2xl border-2 border-amber-300/60 p-8" role="alert">
            <p className="text-3xl font-medium text-amber-200">{t('kiosk.error.title')}</p>
            <p className="mt-3 text-xl text-white/70">
              {t('kiosk.error.body', { seconds: pollSeconds })}
            </p>
          </div>
        )}

        {status === 'ready' && tasks && (
          <>
            {stale && (
              <p className="mt-4 text-xl text-amber-200" role="status">
                {lastLoadedAt
                  ? t('kiosk.staleAt', { time: formatTime(lastLoadedAt) })
                  : t('kiosk.stale')}
              </p>
            )}

            <div className="mt-8 flex-1" aria-live="polite">
              {tasks.length === 0 ? (
                <p className="text-3xl text-white/80">{t('kiosk.allDone')}</p>
              ) : (
                <ul className="space-y-4">
                  {tasks.map((task) => {
                    const isPending = pending.has(task.taskId);
                    const location = [task.spaceName, task.placementNote]
                      .filter(Boolean)
                      .join(' · ');
                    return (
                      <li
                        key={task.taskId}
                        className="flex items-center justify-between gap-6 rounded-2xl border-2 border-white/20 bg-white/5 p-6"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-3xl font-medium sm:text-4xl">
                            {t(`kiosk.taskType.${task.taskType}`, {
                              defaultValue: task.taskType,
                            })}{' '}
                            — {task.plantName}
                          </p>
                          {location && (
                            <p className="mt-2 flex items-center gap-2 text-xl text-white/70">
                              <MapPinIcon className="h-6 w-6 shrink-0" aria-hidden="true" />
                              <span className="truncate">{location}</span>
                            </p>
                          )}
                          <p
                            className={
                              'mt-1 text-xl ' + (task.overdue ? 'text-amber-200' : 'text-white/60')
                            }
                          >
                            {t(dueLabelKey(task, now))}
                          </p>
                        </div>
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => void handleComplete(task)}
                          className="flex min-h-[5rem] shrink-0 items-center gap-3 rounded-2xl bg-white px-8 text-3xl font-semibold text-ink disabled:opacity-50"
                        >
                          <CheckIcon className="h-8 w-8" aria-hidden="true" />
                          {t('kiosk.done')}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </main>

      <footer className="border-t border-white/15 px-6 py-4 text-base text-white/60 sm:px-10">
        {/* Anyone walking past should know what they are looking at. This is
            a screen showing one household's data to a whole room. */}
        <p>{t('kiosk.publicNotice')}</p>
        {!wakeLockHeld && <p className="mt-1">{t('kiosk.sleepHint')}</p>}
      </footer>
    </div>
  );
}
