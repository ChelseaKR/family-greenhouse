import { Fragment, useState } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
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
} from '@heroicons/react/24/outline';
import { useAuthStore } from '@/store/authStore';
import { BrandMark } from './BrandMark';
import { HouseholdSwitcher } from './HouseholdSwitcher';
import { CommandPalette } from './CommandPalette';
import { SidebarPattern } from './brand/SidebarPattern';
import { MemorialFrame } from './brand/MemorialFrame';
import clsx from 'clsx';

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: HomeIcon },
  { name: 'Plants', href: '/plants', icon: PlantIcon },
  { name: 'Tasks', href: '/tasks', icon: ClipboardDocumentListIcon },
  { name: 'Chat', href: '/chat', icon: SparklesIcon },
  { name: 'Analytics', href: '/analytics', icon: ChartBarIcon },
  { name: 'Household', href: '/household', icon: UserGroupIcon },
  { name: 'Settings', href: '/settings', icon: Cog6ToothIcon },
  { name: 'Help', href: '/help', icon: QuestionMarkCircleIcon },
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
  const isChatRoute = location.pathname === '/chat';

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-paper">
      <CommandPalette />
      {/* Mobile sidebar */}
      <Transition.Root show={sidebarOpen} as={Fragment}>
        <Dialog as="div" className="relative z-50 lg:hidden" onClose={setSidebarOpen}>
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
                  <div className="absolute left-full top-0 flex w-16 justify-center pt-5">
                    <button
                      type="button"
                      className="-m-2.5 p-2.5"
                      onClick={() => setSidebarOpen(false)}
                    >
                      <span className="sr-only">Close sidebar</span>
                      <XMarkIcon className="h-6 w-6 text-white" aria-hidden="true" />
                    </button>
                  </div>
                </Transition.Child>

                <SidebarContent
                  user={user}
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
        <SidebarContent user={user} onLogout={handleLogout} onNavigate={() => {}} />
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
        <div className="sticky top-0 z-40 flex min-h-16 shrink-0 items-center gap-x-4 border-b border-dew/60 bg-paper/95 px-4 pt-[env(safe-area-inset-top)] backdrop-blur-sm sm:gap-x-6 sm:px-6 lg:hidden">
          <button
            type="button"
            className="-m-2.5 p-2.5 text-gray-700"
            onClick={() => setSidebarOpen(true)}
          >
            <span className="sr-only">Open sidebar</span>
            <Bars3Icon className="h-6 w-6" aria-hidden="true" />
          </button>

          <div className="flex flex-1 items-center justify-center">
            <BrandMark variant="wordmark" size="sm" />
          </div>
        </div>

        <main className={isChatRoute ? '' : 'py-6'}>
          <div className={isChatRoute ? '' : 'px-4 sm:px-6 lg:px-8'}>
            <Outlet />
          </div>
        </main>

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
  onLogout: () => void;
  /** Called when a nav item is tapped. The mobile drawer instance closes
   *  itself; the desktop instance passes a no-op. */
  onNavigate: () => void;
}

function SidebarContent({ user, onLogout, onNavigate }: SidebarContentProps) {
  return (
    <div className="relative flex grow flex-col gap-y-5 overflow-y-auto bg-primary-900 px-6 pb-4">
      {/* Pane lines + a climbing vine turn the rail into the edge of the
          greenhouse without competing with navigation labels. */}
      <SidebarPattern className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.11]" />

      <div className="relative flex h-16 shrink-0 items-center">
        <BrandMark variant="wordmark" tone="light" size="sm" />
      </div>

      <div className="relative">
        <HouseholdSwitcher />
      </div>

      <nav className="relative flex flex-1 flex-col" aria-label="Main navigation">
        <ul className="flex flex-1 flex-col gap-y-7">
          <li>
            <ul className="-mx-2 space-y-1">
              {navigation.map((item) => (
                <li key={item.name}>
                  <NavLink
                    to={item.href}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      clsx(
                        'group flex min-h-touch items-center gap-x-3 rounded-lg border-l-2 p-2 text-sm font-semibold leading-6 transition-colors',
                        isActive
                          ? 'border-accent-400 bg-white/10 text-white shadow-sm ring-1 ring-white/10'
                          : 'border-transparent text-primary-100/90 hover:bg-white/[0.07] hover:text-white'
                      )
                    }
                  >
                    <item.icon className="h-6 w-6 shrink-0" aria-hidden="true" />
                    {item.name}
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
              className="mt-2 inline-flex min-h-touch w-full items-center justify-center rounded-lg border border-primary-600/80 bg-primary-950/35 px-4 py-2 text-sm font-medium text-primary-100 transition-colors hover:bg-primary-700/75 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 focus-visible:ring-offset-2 focus-visible:ring-offset-primary-900"
            >
              Sign out
            </button>
          </li>
        </ul>
      </nav>
    </div>
  );
}
