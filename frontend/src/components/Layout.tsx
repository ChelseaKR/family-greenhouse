import { Fragment, useEffect, useState } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Dialog, Transition } from '@headlessui/react';
import {
  Bars3Icon,
  XMarkIcon,
  HomeIcon,
  ClipboardDocumentListIcon,
  UserGroupIcon,
  Cog6ToothIcon,
  QuestionMarkCircleIcon,
  ChartBarIcon,
  SparklesIcon,
  HomeModernIcon,
} from '@heroicons/react/24/outline';
import { useAuthStore } from '@/store/authStore';
import { BrandMark } from './BrandMark';
import { HouseholdSwitcher } from './HouseholdSwitcher';
import { CommandPalette } from './CommandPalette';
import { SidebarPattern } from './brand/SidebarPattern';
import { MemorialFrame } from './brand/MemorialFrame';
import { billingService, effectivePlanId } from '@/services/billingService';
import { useActiveHouseholdId } from '@/hooks/useActiveHouseholdId';
import { DoubleCarePrompt } from '@/features/tasks/DoubleCarePrompt';
import { PaymentFailedBanner } from '@/features/billing/PaymentFailedBanner';
import { ConnectionNotice } from './ConnectionNotice';
import { PullToRefresh } from './PullToRefresh';
import { useNativeResumeRefresh } from '@/hooks/useNativeResumeRefresh';
import { setNativeStatusBarOverDarkSurface } from '@/services/nativeShell';
import clsx from 'clsx';

/**
 * The sidebar, in catalog keys only.
 *
 * Eight of these labels used to be English string literals in this array,
 * with `nav.today` the single exception — added with a comment noting that a
 * `labelKey` keeps the label out of "this file's hardcoded-string baseline".
 * That is exactly the hole: the hardcoded-string ratchet reads JSX text nodes
 * and the attributes a screen reader speaks, so a label sitting in a module
 * constant is invisible to it. The gate was green, `nav.dashboard` … had
 * Spanish sitting in both catalogs unused, and the primary navigation of every
 * authenticated screen rendered in English under `es`.
 */
const navigation = [
  { labelKey: 'nav.dashboard', href: '/dashboard', icon: HomeIcon },
  { labelKey: 'nav.plants', href: '/plants', icon: PlantIcon },
  { labelKey: 'nav.tasks', href: '/tasks', icon: ClipboardDocumentListIcon },
  // Cross-home Today (ADR 0017). Shown to every tier: the page itself
  // renders the Greenhouse explanation for the others, never a 404.
  { labelKey: 'nav.today', href: '/today', icon: HomeModernIcon },
  { labelKey: 'nav.chat', href: '/chat', icon: SparklesIcon },
  { labelKey: 'nav.analytics', href: '/analytics', icon: ChartBarIcon },
  { labelKey: 'nav.household', href: '/household', icon: UserGroupIcon },
  { labelKey: 'nav.settings', href: '/settings', icon: Cog6ToothIcon },
  { labelKey: 'nav.help', href: '/help', icon: QuestionMarkCircleIcon },
];

function PlantIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 21c-2-2-5-3-5-8 0-3 2-5 5-5s5 2 5 5c0 5-3 6-5 8z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 13V21" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 6c0-2 1.5-4 3-4s3 2 3 4" />
    </svg>
  );
}

export function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Select only the fields used so a silent token refresh (which rewrites
  // idToken/accessToken) doesn't re-render the whole layout subtree.
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const householdId = useActiveHouseholdId();
  const { data: subscription } = useQuery({
    queryKey: ['subscription', householdId],
    queryFn: billingService.getCurrentSubscription,
    enabled: Boolean(householdId),
    staleTime: 60_000,
  });
  // The backend rejects Seedling chat turns with 402. Hide the navigation
  // until the household is proven to hold an existing chat entitlement so a
  // free user never lands on a working-looking composer that cannot send.
  // A no-card Garden trial counts (ADR 0027): the tier whose features apply now.
  const chatPlanId = effectivePlanId(subscription);
  const chatAvailable = chatPlanId === 'garden' || chatPlanId === 'greenhouse';
  const isChatRoute = location.pathname === '/chat' && chatAvailable;
  // Settings → Plan status renders the full payment-failed notice itself, at
  // the top of the card it explains; the banner there would say it twice. The
  // chat route is a full-height composer with no page padding to sit in.
  const showPaymentFailedBanner = !isChatRoute && location.pathname !== '/settings/billing';
  // Native shells: refetch what's on screen when the app comes back from the
  // background (a no-op on the web).
  useNativeResumeRefresh();

  // The drawer is forest green and runs under the status bar in the native
  // shells, where the bar otherwise carries dark icons for the light app.
  useEffect(() => {
    setNativeStatusBarOverDarkSurface(sidebarOpen);
  }, [sidebarOpen]);

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-paper">
      <CommandPalette />
      {/* Mobile sidebar */}
      <Transition.Root show={sidebarOpen} as={Fragment}>
        {/* Named, so VoiceOver and TalkBack announce "Main navigation,
            dialog" rather than an unnamed dialog. */}
        <Dialog
          as="div"
          className="relative z-50 lg:hidden"
          onClose={setSidebarOpen}
          aria-label={t('nav.mainNavigation')}
        >
          <Transition.Child
            as={Fragment}
            enter="transition-opacity ease-linear duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="transition-opacity ease-linear duration-300"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-primary-950/80" />
          </Transition.Child>

          <div className="fixed inset-0 flex">
            <Transition.Child
              as={Fragment}
              enter="transition ease-in-out duration-300 transform"
              enterFrom="-translate-x-full"
              enterTo="translate-x-0"
              leave="transition ease-in-out duration-300 transform"
              leaveFrom="translate-x-0"
              leaveTo="-translate-x-full"
            >
              <Dialog.Panel className="relative mr-16 flex w-full max-w-xs flex-1">
                <Transition.Child
                  as={Fragment}
                  enter="ease-in-out duration-300"
                  enterFrom="opacity-0"
                  enterTo="opacity-100"
                  leave="ease-in-out duration-300"
                  leaveFrom="opacity-100"
                  leaveTo="opacity-0"
                >
                  <div className="absolute left-full top-0 flex w-16 justify-center pt-[calc(1.25rem+env(safe-area-inset-top))]">
                    <button
                      type="button"
                      className="-m-2.5 p-2.5"
                      onClick={() => setSidebarOpen(false)}
                    >
                      <span className="sr-only">{t('nav.closeSidebar')}</span>
                      <XMarkIcon className="h-6 w-6 text-white" aria-hidden="true" />
                    </button>
                  </div>
                </Transition.Child>

                <SidebarContent
                  user={user}
                  chatAvailable={chatAvailable}
                  onLogout={handleLogout}
                  onNavigate={() => setSidebarOpen(false)}
                />
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </Dialog>
      </Transition.Root>

      {/* Desktop sidebar — no drawer to close, so navigation is a no-op. */}
      <div className="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-72 lg:flex-col">
        <SidebarContent
          user={user}
          chatAvailable={chatAvailable}
          onLogout={handleLogout}
          onNavigate={() => {}}
        />
      </div>

      {/* Main content */}
      <div className="lg:pl-72">
        {/* Mobile header. Solid bg-paper (no /opacity + blur): a translucent
            sticky bar lets page text show through at reduced contrast while
            scrolling, which both fails WCAG AA for the underlying text and
            makes axe color-contrast results nondeterministic. */}
        {/* min-h + safe-area padding (not fixed h-16): with viewport-fit=cover
            the native shells and installed PWAs draw edge-to-edge, so the bar
            extends its own background under the iOS/Android status bar and
            keeps its content below it. env() is 0 in regular browser tabs. */}
        {/* At the iOS accessibility text sizes the wordmark wraps and the bar
            grows to about a quarter of the screen, so there it scrolls away
            with the page instead of covering that much of every screen. */}
        <div className="sticky top-0 z-40 flex min-h-16 shrink-0 items-center gap-x-4 border-b border-dew/60 bg-paper/95 px-4 pt-[env(safe-area-inset-top)] backdrop-blur-xs sm:gap-x-6 sm:px-6 lg:hidden large-text:static">
          <button
            type="button"
            className="-m-2.5 p-2.5 text-gray-700"
            onClick={() => setSidebarOpen(true)}
          >
            <span className="sr-only">{t('nav.openSidebar')}</span>
            <Bars3Icon className="h-6 w-6" aria-hidden="true" />
          </button>

          <div className="flex flex-1 items-center justify-center">
            <BrandMark variant="wordmark" size="sm" />
          </div>
        </div>

        {/* Native only, and not on the full-height chat composer, which
            scrolls inside itself. */}
        {!isChatRoute && <PullToRefresh />}
        <main className={isChatRoute ? '' : 'py-6'}>
          <div className={isChatRoute ? '' : 'px-4 sm:px-6 lg:px-8'}>
            {!isChatRoute && <ConnectionNotice />}
            {showPaymentFailedBanner && <PaymentFailedBanner subscription={subscription} />}
            <Outlet />
          </div>
        </main>
        {/* Double-care "already done — log it anyway?" prompt, fed by every
            task-completion mutation through the double-care store. */}
        <DoubleCarePrompt />

        {/* Memorial closing line, flanked by mirrored botanical sprigs. The
            text itself is unchanged from the original; only the decoration
            around it is new. Sprigs are aria-hidden as decoration. */}
        {!isChatRoute && (
          <footer className="px-4 pb-8 pt-6 sm:px-6 lg:px-8">
            <div className="flex items-center justify-center gap-4">
              <MemorialFrame className="h-8 w-32 text-primary-700/40 hidden sm:block" />
              <p className="text-center text-xs italic text-gray-600">
                In loving memory of my mom, Joyce — who taught us to keep growing.
              </p>
              <MemorialFrame className="h-8 w-32 text-primary-700/40 hidden sm:block -scale-x-100" />
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}

interface SidebarContentProps {
  user: { name: string; email: string } | null;
  chatAvailable: boolean;
  onLogout: () => void;
  /** Called when a nav item is tapped. The mobile drawer instance closes
   *  itself; the desktop instance passes a no-op. */
  onNavigate: () => void;
}

function SidebarContent({ user, chatAvailable, onLogout, onNavigate }: SidebarContentProps) {
  const { t } = useTranslation();
  return (
    // Safe-area padding keeps the wordmark out from under the status bar and
    // Dynamic Island, and Sign out above the home indicator, in the native
    // shells and installed PWAs. env() is 0 in a browser tab, where this is
    // the same px-6 pb-4 it always was.
    <div className="relative flex grow flex-col gap-y-5 overflow-y-auto bg-primary-900 pt-[env(safe-area-inset-top)] pr-6 pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1.5rem,env(safe-area-inset-left))]">
      {/* Pane lines + a climbing vine turn the rail into the edge of the
          greenhouse without competing with navigation labels. */}
      <SidebarPattern className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.11]" />

      <div className="relative flex h-16 shrink-0 items-center">
        <BrandMark variant="wordmark" tone="light" size="sm" />
      </div>

      <div className="relative">
        <HouseholdSwitcher />
      </div>

      <nav className="relative flex flex-1 flex-col" aria-label={t('nav.mainNavigation')}>
        <ul className="flex flex-1 flex-col gap-y-7">
          <li>
            <ul className="-mx-2 space-y-1">
              {navigation
                .filter((item) => item.href !== '/chat' || chatAvailable)
                .map((item) => (
                  <li key={item.href}>
                    <NavLink
                      to={item.href}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        clsx(
                          'group flex min-h-touch items-center gap-x-3 rounded-lg border-l-2 p-2 text-sm font-semibold leading-6 transition-colors',
                          isActive
                            ? 'border-accent-400 bg-white/10 text-white shadow-xs ring-1 ring-white/10'
                            : 'border-transparent text-primary-100/90 hover:bg-white/[0.07] hover:text-white'
                        )
                      }
                    >
                      <item.icon className="h-6 w-6 shrink-0" aria-hidden="true" />
                      {t(item.labelKey)}
                    </NavLink>
                  </li>
                ))}
            </ul>
          </li>

          <li className="mt-auto">
            <div className="flex items-center gap-x-4 py-3 text-sm font-semibold text-primary-100">
              <div
                className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-700 ring-1 ring-dew/40"
                aria-hidden="true"
              >
                {user?.name?.charAt(0).toUpperCase() || 'U'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="truncate text-white">{user?.name}</p>
                <p className="truncate text-primary-300 text-xs">{user?.email}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="mt-2 inline-flex min-h-touch w-full items-center justify-center rounded-lg border border-primary-600/80 bg-primary-950/35 px-4 py-2 text-sm font-medium text-primary-100 transition-colors hover:bg-primary-700/75 hover:text-white focus:outline-hidden focus-visible:ring-2 focus-visible:ring-primary-300 focus-visible:ring-offset-2 focus-visible:ring-offset-primary-900"
            >
              {t('nav.signOut')}
            </button>
          </li>
        </ul>
      </nav>
    </div>
  );
}
