import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { listMyHouseholds } from '@/services/householdService';
import { useSwitchHousehold } from '@/hooks/useSwitchHousehold';
import { NativeChrome } from '@/services/nativeChrome';
import {
  HOUSEHOLD_ID_PREFIX,
  RIGHT_BUTTON_PATHS,
  SIGN_OUT_ID,
  buildConfiguration,
  buildUpdate,
  sameTitle,
} from '@/config/nativeFrame';

/**
 * Keeps the iOS app's native tab bar and navigation bar in step with the web
 * router, both ways:
 *
 * - On every route change, and whenever the page's h1 changes (a plant's name
 *   arrives), it sends `update`: the path, the title, the tab, whether there
 *   is a screen to go back to, and whether the bars show at all. When the bar
 *   shows the same words as the h1, the h1 is marked `data-native-title="bar"`
 *   and hidden from sight (index.css), still read by VoiceOver.
 * - A tab, the back button, the edge swipe or a More row arrives as an event
 *   carrying the route to show, and it navigates there.
 *
 * Swift keeps each tab's back stack; this only reports and follows.
 */
export default function NativeFrameBridge() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);
  const activeHouseholdId = useAuthStore((s) => s.activeHouseholdId);
  const logout = useAuthStore((s) => s.logout);
  const switchHousehold = useSwitchHousehold();
  const hasHousehold = user?.householdId != null;

  const { data: memberships } = useQuery({
    queryKey: ['me', 'households'],
    queryFn: listMyHouseholds,
    enabled: isAuthenticated && Boolean(user),
    staleTime: 60_000,
  });

  // The tabs' labels, the More list and the sign-out sheet, in the app's
  // language, again whenever the language or the household list changes.
  useEffect(() => {
    const list = memberships ?? [];
    const active = activeHouseholdId ?? user?.householdId ?? list[0]?.householdId ?? null;
    void NativeChrome.configure(buildConfiguration(t, list, active)).catch(() => undefined);
  }, [t, i18n.language, memberships, activeHouseholdId, user?.householdId]);

  // The latest handlers, so the listeners below are added once.
  const act = useRef({ navigate, logout, switchHousehold });
  act.current = { navigate, logout, switchHousehold };

  useEffect(() => {
    const handles = [
      NativeChrome.addListener('tabSelect', ({ path }) => {
        // More's first screen is native: nothing for the web to show.
        if (path) act.current.navigate(path, { replace: true });
      }),
      NativeChrome.addListener('back', ({ path }) => {
        act.current.navigate(path, { replace: true });
      }),
      NativeChrome.addListener('moreSelect', ({ id, path }) => {
        if (id === SIGN_OUT_ID) {
          // What the drawer's Sign out does.
          act.current.logout();
          act.current.navigate('/');
        } else if (id.startsWith(HOUSEHOLD_ID_PREFIX)) {
          act.current.switchHousehold(id.slice(HOUSEHOLD_ID_PREFIX.length));
        } else if (path) {
          act.current.navigate(path);
        }
      }),
      NativeChrome.addListener('rightButton', ({ id }) => {
        const path = RIGHT_BUTTON_PATHS[id];
        if (path) act.current.navigate(path);
      }),
    ];
    return () => {
      for (const handle of handles) {
        void handle.then((h) => h.remove()).catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    const session = { signedIn: isAuthenticated, hasHousehold };
    let lastSent = '';
    const send = () => {
      const h1 = document.querySelector<HTMLElement>('#main-content h1');
      const update = buildUpdate({
        pathname: location.pathname,
        search: location.search,
        key: location.key,
        navigationType,
        pageTitle: h1?.textContent ?? '',
        fallbackHeading: h1
          ? ''
          : (document.querySelector('#main-content main h2')?.textContent ?? ''),
        session,
        t,
      });
      if (h1) {
        if (sameTitle(h1.textContent ?? '', update.title)) h1.dataset.nativeTitle = 'bar';
        else delete h1.dataset.nativeTitle;
      }
      const message = JSON.stringify(update);
      if (message === lastSent) return;
      lastSent = message;
      void NativeChrome.update(update).catch(() => undefined);
    };
    send();
    // Pages load in pieces (a lazy chunk, then data): follow the h1 as it
    // appears or changes, at most once a frame.
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(send);
    });
    const root = document.getElementById('main-content');
    if (root) observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [
    location.key,
    location.pathname,
    location.search,
    navigationType,
    isAuthenticated,
    hasHousehold,
    t,
  ]);

  return null;
}
