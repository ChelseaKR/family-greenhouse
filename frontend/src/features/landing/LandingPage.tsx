import { Link } from 'react-router-dom';
import {
  CalendarDaysIcon,
  UserGroupIcon,
  BellAlertIcon,
  DevicePhoneMobileIcon,
  ChartBarIcon,
  ShieldCheckIcon,
  CheckIcon,
  StarIcon,
  HomeIcon,
  ClipboardDocumentListIcon,
  Cog6ToothIcon,
} from '@heroicons/react/24/outline';
import { Button } from '@/components/Button';
import { BrandMark } from '@/components/BrandMark';
import { PricingGrid } from '@/features/pricing/PricingGrid';
import { IS_BETA, BETA_BADGE } from '@/lib/betaMode';
import { TitleUnderline } from '@/components/brand/TitleUnderline';
import { SprigDivider } from '@/components/brand/SprigDivider';
import { MemorialFrame } from '@/components/brand/MemorialFrame';
import { DashboardHeaderArt } from '@/components/headers/DashboardHeaderArt';
import { WaterDropIcon } from '@/components/icons/WaterDropIcon';
import { FertilizeIcon } from '@/components/icons/FertilizeIcon';
import { PruneIcon } from '@/components/icons/PruneIcon';
import clsx from 'clsx';

const features = [
  {
    name: 'Smart Care Reminders',
    description:
      "Never forget to water your plants again. Get personalized reminders based on each plant's specific needs.",
    icon: BellAlertIcon,
  },
  {
    name: 'Family Collaboration',
    description:
      'Share plant care responsibilities with your whole household. Assign tasks and track who did what.',
    icon: UserGroupIcon,
  },
  {
    name: 'Care Calendar',
    description:
      'See all upcoming plant care tasks at a glance. Plan your week and never miss a feeding or pruning.',
    icon: CalendarDaysIcon,
  },
  {
    name: 'Mobile Friendly',
    description:
      'Access your greenhouse from anywhere. Check tasks, mark them complete, and add notes on the go.',
    icon: DevicePhoneMobileIcon,
  },
  {
    name: 'Plant Health Tracking',
    description:
      "Log observations and track your plants' health over time. See patterns and improve your care routine.",
    icon: ChartBarIcon,
  },
  {
    name: 'Secure & Private',
    description:
      'Your data stays yours. We use industry-standard encryption to keep your information safe.',
    icon: ShieldCheckIcon,
  },
];

const testimonials = [
  {
    content:
      'Family Greenhouse transformed how we care for our 30+ houseplants. No more "I thought you watered it!" arguments.',
    author: 'Sarah M.',
    role: 'Plant Mom of 3 Kids',
    rating: 5,
  },
  {
    content:
      "Finally, an app that understands plant care isn't a solo job. My partner and I split tasks perfectly now.",
    author: 'James & Devon',
    role: 'Apartment Gardeners',
    rating: 5,
  },
  {
    content:
      "I travel for work constantly. Now my roommates know exactly what each plant needs while I'm away.",
    author: 'Michelle K.',
    role: 'Frequent Traveler',
    rating: 5,
  },
];

// Pricing data lives in features/pricing/plans.ts so the standalone
// /pricing page and this anchor section stay in sync.

// Product facts the landing page can stand behind without lying about
// users we don't yet have. The earlier "50,000+ Happy Plants / 99.2%
// Plants Thriving" numbers were fabricated; replaced here with concrete,
// auditable claims about the app itself. When real adoption metrics
// exist, they belong in this list — sourced from analytics, not vibes.
const productFacts = [
  { value: 'Free', label: 'Up to 10 plants — no credit card' },
  { value: 'Multi-user', label: 'Share care across the whole household' },
  { value: '5 minutes', label: 'From signup to first task' },
  { value: 'Open APIs', label: 'Export your data any time' },
];

// Build-time flag — testimonials are hidden until we have real, sourced quotes.
// Flip on by setting `VITE_SHOW_TESTIMONIALS=1` in the env when running
// `vite build`. Truthy is anything non-empty, non-"0", non-"false".
const showTestimonials = (() => {
  const v = (import.meta.env.VITE_SHOW_TESTIMONIALS ?? '') as string;
  return v !== '' && v !== '0' && v.toLowerCase() !== 'false';
})();

/**
 * Marketing-page mockup of the running app. Structure mirrors the live
 * `Layout` + redesigned `DashboardPage`:
 *
 *  - Browser chrome (traffic lights + URL bar) on top.
 *  - Dark green sidebar with the brand lockup + main nav, "Dashboard"
 *    pinned active.
 *  - Content area styled "garden journal" — paper background, Gloock
 *    serif welcome with hand-drawn underline, `DashboardHeaderArt` to
 *    the right, an inline metadata row (replaces the old KPI tile
 *    grid), a paper-variant Tasks card with botanical task-type icons,
 *    and an Activity card with avatar initials.
 *
 * The illustrative data is fixed (Sarah / Mike / Emma, a few plants);
 * this is a marketing mock, not a live screenshot. Names and counts
 * aren't claims — they're representative content.
 */
function AppMockup() {
  const navItems = [
    { name: 'Dashboard', icon: HomeIcon, active: true },
    { name: 'Plants', icon: SidebarLeafIcon, active: false },
    { name: 'Tasks', icon: ClipboardDocumentListIcon, active: false },
    { name: 'Analytics', icon: ChartBarIcon, active: false },
    { name: 'Household', icon: UserGroupIcon, active: false },
    { name: 'Settings', icon: Cog6ToothIcon, active: false },
  ];

  const todayTasks: Array<{
    type: 'water' | 'fertilize' | 'prune';
    plant: string;
    when: string;
  }> = [
    { type: 'water', plant: 'Monstera', when: 'Today' },
    { type: 'fertilize', plant: 'Snake plant', when: 'Today' },
    { type: 'prune', plant: 'Boston fern', when: 'Tomorrow' },
  ];

  const activity = [
    { name: 'Sarah', action: 'watered', target: 'Fiddle leaf fig', when: '2h ago' },
    { name: 'Mike', action: 'added', target: 'Pothos', when: '5h ago' },
    { name: 'Emma', action: 'completed 3 tasks', target: '', when: 'Yesterday' },
  ];

  const taskIcons = { water: WaterDropIcon, fertilize: FertilizeIcon, prune: PruneIcon };
  const taskChip: Record<keyof typeof taskIcons, string> = {
    water: 'bg-sky-50 text-sky-700 ring-sky-200/70',
    fertilize: 'bg-primary-50 text-primary-700 ring-primary-200/70',
    prune: 'bg-accent-50 text-accent-700 ring-accent-200/70',
  };

  return (
    <div className="mt-16 sm:mt-24">
      <div className="relative -m-2 rounded-xl bg-primary-900/10 p-2 ring-1 ring-inset ring-primary-900/15 lg:-m-4 lg:rounded-2xl lg:p-4">
        <div className="rounded-lg bg-paper shadow-2xl ring-1 ring-primary-900/10 overflow-hidden">
          {/* Browser chrome */}
          <div className="bg-parchment px-4 py-3 border-b border-primary-200/60 flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-3 h-3 rounded-full bg-accent-400/80" />
              <div className="w-3 h-3 rounded-full bg-secondary-400/80" />
              <div className="w-3 h-3 rounded-full bg-primary-400/80" />
            </div>
            <div className="flex-1 text-center text-sm text-primary-900/70">
              app.familygreenhouse.com
            </div>
          </div>

          {/* App body — sidebar + content. */}
          <div className="flex bg-paper">
            {/* Sidebar — matches the live `Layout` (bg-primary-800 with a
                soft brand-tinted ring on active nav). */}
            <aside className="hidden sm:flex sm:flex-col sm:w-52 lg:w-60 bg-primary-800 px-4 py-5 gap-y-5">
              <div className="flex items-center gap-2">
                <span className="block rounded-md bg-primary-50 p-1">
                  <img src="/brand/icon.svg" alt="" aria-hidden="true" className="h-7 w-auto" />
                </span>
                <span className="flex flex-col leading-tight">
                  <span className="font-serif text-sm font-semibold tracking-tight text-white">
                    Family Greenhouse
                  </span>
                  <span className="text-[8px] uppercase tracking-[0.2em] text-primary-200">
                    Grow together
                  </span>
                </span>
              </div>

              <div className="rounded-md bg-primary-900/40 ring-1 ring-primary-600/30 px-3 py-2">
                <p className="text-[10px] text-primary-200">Active household</p>
                <p className="text-sm font-medium text-white">Apartment 3B</p>
              </div>

              <nav className="flex-1 -mx-2 space-y-1" aria-label="Mock navigation">
                {navItems.map((item) => (
                  <span
                    key={item.name}
                    className={clsx(
                      'group flex items-center gap-x-3 rounded-md p-2 text-sm font-medium leading-6',
                      item.active
                        ? 'bg-primary-700/80 text-white shadow-sm ring-1 ring-primary-600/50'
                        : 'text-primary-100/90'
                    )}
                  >
                    <item.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                    {item.name}
                  </span>
                ))}
              </nav>
            </aside>

            {/* Main content — mirrors the redesigned `DashboardPage`. */}
            <main className="flex-1 p-4 sm:p-6 min-w-0">
              <header className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-primary-700/70 font-semibold">
                    Your household
                  </p>
                  <h2 className="mt-1 font-serif text-2xl text-ink leading-tight">
                    Welcome back, Chelsea
                  </h2>
                  <TitleUnderline className="mt-1 ml-0.5 h-2 w-28 text-primary-600" />
                  <p className="mt-2 text-xs text-gray-600">
                    Here&rsquo;s what&rsquo;s happening with your plants today.
                  </p>
                </div>
                <div className="hidden lg:block flex-shrink-0 w-28">
                  <DashboardHeaderArt className="w-full h-auto" />
                </div>
              </header>

              {/* Inline metadata row (replaces the old 3-tile KPI grid). */}
              <dl className="mt-5 flex flex-wrap items-baseline gap-x-6 gap-y-2 text-xs">
                <Metric label="Plants" value="12" />
                <Metric label="Due today" value="3" />
                <Metric label="Overdue" value="0" />
              </dl>

              {/* Today's tasks + Activity. */}
              <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-4">
                <section className="rounded-xl bg-paper border border-primary-100/70 shadow-journal overflow-hidden">
                  <header className="px-4 py-3 border-b border-primary-100/70">
                    <h3 className="text-sm font-semibold text-ink">Upcoming tasks</h3>
                  </header>
                  <ul className="divide-y divide-primary-100/60">
                    {todayTasks.map((t) => {
                      const Icon = taskIcons[t.type];
                      return (
                        <li
                          key={`${t.type}-${t.plant}`}
                          className="flex items-center gap-3 px-4 py-3"
                        >
                          <span
                            className={clsx(
                              'inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ring-1',
                              taskChip[t.type]
                            )}
                            aria-hidden="true"
                          >
                            <Icon className="h-5 w-5" />
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-ink truncate">{t.plant}</p>
                            <p className="text-[11px] text-gray-600 capitalize">
                              {t.type} • {t.when}
                            </p>
                          </div>
                          <span
                            className="hidden sm:inline-flex items-center justify-center h-6 w-6 rounded-full border border-primary-200/70 text-primary-400"
                            aria-hidden="true"
                          >
                            <CheckIcon className="h-3.5 w-3.5" />
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>

                <section className="rounded-xl bg-paper border border-primary-100/70 shadow-journal overflow-hidden">
                  <header className="px-4 py-3 border-b border-primary-100/70">
                    <h3 className="text-sm font-semibold text-ink">Family activity</h3>
                  </header>
                  <ul className="divide-y divide-primary-100/60">
                    {activity.map((a, i) => (
                      <li key={i} className="flex items-center gap-3 px-4 py-3">
                        <span
                          className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-100 ring-1 ring-primary-200/60 text-primary-800 text-xs font-semibold"
                          aria-hidden="true"
                        >
                          {a.name.charAt(0)}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-ink truncate">
                            <span className="font-medium">{a.name}</span> {a.action}
                            {a.target && (
                              <>
                                {' '}
                                <span className="font-medium">{a.target}</span>
                              </>
                            )}
                          </p>
                          <p className="text-[11px] text-gray-600">{a.when}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}

interface MetricProps {
  label: string;
  value: string;
}

function Metric({ label, value }: MetricProps) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-[10px] uppercase tracking-[0.14em] text-gray-500">{label}</dt>
      <dd className="font-serif text-base text-ink leading-none tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Decorative cluster of botanical sprigs that flank the hero. Used twice
 * (mirrored) to flank the headline at low opacity so the hero reads as
 * a hand-illustrated garden page rather than a default-Tailwind landing.
 * Stroke is `currentColor` so opacity tints come from the caller.
 */
function HeroSprigs({
  className,
  ...rest
}: React.SVGProps<SVGSVGElement> & { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 240 320"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {/* Tall stem with alternating leaves */}
      <path d="M 60 320 Q 58 220 70 120 Q 72 80 70 40" />
      <path d="M 70 100 Q 30 90 18 110 Q 50 118 70 102 Z" fill="currentColor" opacity="0.7" />
      <path d="M 70 160 Q 110 150 122 170 Q 90 178 70 162 Z" fill="currentColor" opacity="0.7" />
      <path d="M 70 220 Q 30 212 22 230 Q 50 240 70 222 Z" fill="currentColor" opacity="0.7" />
      <circle cx="70" cy="40" r="3" fill="currentColor" />

      {/* Short companion sprig */}
      <path d="M 140 320 Q 142 260 150 210" />
      <path d="M 150 230 Q 180 224 188 238 Q 168 244 150 232 Z" fill="currentColor" opacity="0.7" />
      <path d="M 148 270 Q 120 264 114 280 Q 138 288 150 272 Z" fill="currentColor" opacity="0.7" />
      <circle cx="150" cy="210" r="2.4" fill="currentColor" />

      {/* Small ground tuft */}
      <path d="M 30 318 Q 28 304 32 292" opacity="0.6" />
      <path d="M 30 302 Q 18 296 16 308 Q 26 312 30 302 Z" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

/** Inline leaf icon used in the mockup nav + KPI tile so it lines up with
 *  the in-app Plants nav item without dragging a new heroicon import. */
function SidebarLeafIcon({ className }: { className?: string }) {
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

export function LandingPage() {
  return (
    <div className="bg-paper">
      {/* Navigation */}
      <header className="absolute inset-x-0 top-0 z-50">
        <nav className="flex items-center justify-between p-6 lg:px-8 max-w-7xl mx-auto">
          <div className="flex lg:flex-1 items-center gap-2">
            <Link to="/" aria-label="Family Greenhouse home">
              <BrandMark variant="wordmark" />
            </Link>
            {IS_BETA && (
              <span className="rounded-full bg-accent-100 text-accent-800 text-xs font-semibold px-2 py-0.5 border border-accent-200/70">
                {BETA_BADGE}
              </span>
            )}
          </div>
          <div className="hidden lg:flex lg:gap-x-8">
            <a
              href="#features"
              className="text-sm font-semibold text-ink hover:text-primary-700 transition-colors"
            >
              Features
            </a>
            {showTestimonials && (
              <a
                href="#testimonials"
                className="text-sm font-semibold text-ink hover:text-primary-700 transition-colors"
              >
                Testimonials
              </a>
            )}
            <a
              href="#pricing"
              className="text-sm font-semibold text-ink hover:text-primary-700 transition-colors"
            >
              Pricing
            </a>
          </div>
          <div className="flex flex-1 justify-end items-center gap-x-6">
            <Link
              to="/login"
              className="text-sm font-semibold text-ink hover:text-primary-700 transition-colors py-2"
            >
              Log in
            </Link>
            <Link to="/register" className="block">
              <Button size="md">Sign up free</Button>
            </Link>
          </div>
        </nav>
      </header>

      {/* Hero Section — botanical wash on paper, no clip-path blurs. The
          two flanking sprig clusters give the page a hand-drawn feel
          without the cookie-cutter "abstract gradient blob" pattern. */}
      <div className="relative isolate pt-14 overflow-hidden">
        {/* Left botanical wash */}
        <HeroSprigs
          className="pointer-events-none absolute left-0 top-24 -z-10 hidden md:block w-64 h-auto text-primary-300/40"
          aria-hidden="true"
        />
        {/* Right botanical wash, mirrored */}
        <HeroSprigs
          className="pointer-events-none absolute right-0 top-32 -z-10 hidden md:block w-72 h-auto text-primary-300/40 -scale-x-100"
          aria-hidden="true"
        />

        <div className="py-24 sm:py-32 lg:py-40">
          <div className="mx-auto max-w-7xl px-6 lg:px-8">
            <div className="mx-auto max-w-2xl text-center">
              {showTestimonials && (
                <div className="mb-8 flex justify-center">
                  <div className="relative rounded-full bg-paper px-3 py-1 text-sm text-gray-600 ring-1 ring-primary-200/60 hover:ring-primary-300">
                    Trusted by 12,000+ plant-loving families.{' '}
                    <a href="#testimonials" className="font-semibold text-primary-700">
                      <span className="absolute inset-0" aria-hidden="true" />
                      See their stories <span aria-hidden="true">&rarr;</span>
                    </a>
                  </div>
                </div>
              )}
              <p className="text-xs uppercase tracking-[0.22em] text-primary-700/80 font-semibold mb-6">
                A garden journal for the whole house
              </p>
              <h1 className="font-serif text-5xl tracking-tight text-ink sm:text-7xl leading-[1.05]">
                Keep your plants thriving, <span className="italic text-primary-700">together</span>
              </h1>
              <div className="mt-4 flex justify-center">
                <TitleUnderline className="h-4 w-56 text-primary-600" />
              </div>
              <p className="mt-6 text-lg leading-8 text-gray-700">
                The collaborative plant care app for busy households. Never miss a watering, share
                responsibilities, and watch your indoor jungle flourish.
              </p>
              <div className="mt-10 flex items-center justify-center gap-x-6">
                <Link to="/register">
                  <Button size="lg">Start growing free</Button>
                </Link>
                <a
                  href="#features"
                  className="text-sm font-semibold leading-6 text-ink flex items-center gap-1 hover:text-primary-700 transition-colors"
                >
                  See how it works <span aria-hidden="true">→</span>
                </a>
              </div>
            </div>

            {/* App Preview — a faithful mock of the real product chrome
                styled to match the redesigned dashboard (paper bg,
                botanical task icons, inline metadata row, Gloock serif
                welcome). The visual is the product. */}
            <AppMockup />
          </div>
        </div>
      </div>

      {/* Product facts band — kept on the dark-green brand surface so it
          punches between the paper hero and the paper features section.
          Sprig dividers above + below give it the journal frame. */}
      <div className="bg-primary-800 py-16 relative">
        <SprigDivider
          className="absolute left-1/2 -top-3 h-6 w-40 -translate-x-1/2 text-paper"
          aria-hidden="true"
        />
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
            {productFacts.map((fact) => (
              <div key={fact.label} className="text-center">
                <div className="font-serif text-3xl text-white sm:text-4xl tabular-nums">
                  {fact.value}
                </div>
                <div className="mt-2 text-sm text-primary-100">{fact.label}</div>
              </div>
            ))}
          </div>
        </div>
        <SprigDivider
          className="absolute left-1/2 -bottom-3 h-6 w-40 -translate-x-1/2 -scale-y-100 text-paper"
          aria-hidden="true"
        />
      </div>

      {/* Features Section */}
      <div id="features" className="py-24 sm:py-32 bg-paper">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <SectionHeading
            eyebrow="Everything you need"
            title="Plant care made simple"
            description="Whether you're a seasoned plant parent or just starting out, Family Greenhouse has the tools to help your plants thrive."
          />
          <div className="mx-auto mt-16 max-w-2xl sm:mt-20 lg:mt-24 lg:max-w-none">
            <dl className="grid max-w-xl grid-cols-1 gap-x-8 gap-y-10 lg:max-w-none lg:grid-cols-3">
              {features.map((feature) => (
                <div
                  key={feature.name}
                  className="relative bg-paper rounded-2xl p-8 shadow-journal hover:shadow-journal-hover transition-shadow border border-primary-100/60"
                >
                  <dt className="flex flex-col items-start gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary-100 ring-1 ring-primary-200/60">
                      <feature.icon className="h-6 w-6 text-primary-700" aria-hidden="true" />
                    </div>
                    <span className="text-lg font-semibold leading-7 text-ink">{feature.name}</span>
                  </dt>
                  <dd className="mt-2 text-base leading-7 text-gray-700">{feature.description}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </div>

      {/* How It Works Section */}
      <div className="py-24 sm:py-32 bg-parchment">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <SectionHeading eyebrow="Simple setup" title="Get started in minutes" />
          <div className="mx-auto mt-16 max-w-5xl">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              {[
                {
                  step: '1',
                  title: 'Add your plants',
                  description:
                    "Snap a photo and enter basic info. We'll help you set up the perfect care schedule.",
                },
                {
                  step: '2',
                  title: 'Invite your family',
                  description:
                    'Share your greenhouse with household members. Everyone gets their own tasks.',
                },
                {
                  step: '3',
                  title: 'Watch them thrive',
                  description:
                    'Get smart reminders, track progress, and enjoy a home full of happy plants.',
                },
              ].map((item) => (
                <div key={item.step} className="text-center">
                  <div
                    className="mx-auto w-16 h-16 rounded-full bg-primary-700 ring-4 ring-primary-100 text-paper flex items-center justify-center font-serif text-2xl mb-6"
                    aria-hidden="true"
                  >
                    {item.step}
                  </div>
                  <h3 className="font-serif text-xl text-ink mb-3">{item.title}</h3>
                  <p className="text-gray-700">{item.description}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Testimonials Section. Hidden by default — flip on by setting
          VITE_SHOW_TESTIMONIALS=1 at build time once we have real quotes. */}
      {showTestimonials && (
        <div id="testimonials" className="py-24 sm:py-32 bg-paper">
          <div className="mx-auto max-w-7xl px-6 lg:px-8">
            <SectionHeading eyebrow="Testimonials" title="Loved by plant families everywhere" />
            <div className="mx-auto mt-16 grid max-w-2xl grid-cols-1 gap-8 lg:mx-0 lg:max-w-none lg:grid-cols-3">
              {testimonials.map((testimonial) => (
                <div
                  key={testimonial.author}
                  className="flex flex-col justify-between bg-paper p-8 rounded-2xl shadow-journal border border-primary-100/60"
                >
                  <div>
                    <div className="flex gap-1 mb-4">
                      {[...Array(testimonial.rating)].map((_, i) => (
                        <StarIcon key={i} className="h-5 w-5 text-accent-500 fill-accent-500" />
                      ))}
                    </div>
                    <p className="text-gray-700 leading-relaxed">"{testimonial.content}"</p>
                  </div>
                  <div className="mt-6 pt-6 border-t border-primary-100/70">
                    <p className="font-semibold text-ink">{testimonial.author}</p>
                    <p className="text-sm text-gray-500">{testimonial.role}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Pricing Section */}
      <div id="pricing" className="py-24 sm:py-32 bg-parchment">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <SectionHeading
            eyebrow="Pricing"
            title="Plans for every greenhouse"
            description="Start free and grow with us. Upgrade anytime as your plant family expands."
          />
          <PricingGrid />
          <p className="mt-12 text-center text-sm text-gray-700">
            See more on the dedicated{' '}
            <Link to="/pricing" className="font-medium text-primary-700 hover:underline">
              pricing page
            </Link>
            , including a small FAQ.
          </p>
        </div>
      </div>

      {/* CTA Section */}
      <div className="bg-primary-800 relative">
        <SprigDivider
          className="absolute left-1/2 -top-3 h-6 w-40 -translate-x-1/2 text-paper"
          aria-hidden="true"
        />
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32 lg:px-8 lg:flex lg:items-center lg:justify-between">
          <div>
            <h2 className="font-serif text-4xl tracking-tight text-white sm:text-5xl">
              Ready to grow <span className="italic text-primary-200">together</span>?
            </h2>
            <p className="mt-4 text-lg text-primary-100 max-w-xl">
              Set up a household, share access with the people you live with, and let the right
              person be reminded at the right time. Free for up to 10 plants.
            </p>
          </div>
          <div className="mt-10 flex items-center gap-x-6 lg:mt-0 lg:flex-shrink-0">
            <Link to="/register">
              {/* Inverted CTA on the dark green band. The `!` prefix on
                  the override classes forces them to win over the Button
                  variant's `bg-primary-700 text-white`, which otherwise
                  ties on specificity and renders white-on-white. */}
              <Button size="lg" className="!bg-paper !text-primary-800 hover:!bg-primary-50">
                Get started free
              </Button>
            </Link>
            <a
              href="#features"
              className="text-sm font-semibold leading-6 text-primary-100 hover:text-white"
            >
              Learn more <span aria-hidden="true">→</span>
            </a>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="bg-primary-900">
        <div className="mx-auto max-w-7xl px-6 py-12 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            <div className="col-span-2 md:col-span-1">
              <Link to="/" aria-label="Family Greenhouse home">
                <BrandMark variant="wordmark" tone="light" />
              </Link>
              <p className="mt-4 text-sm text-primary-200">
                Collaborative plant care for households. Grow together.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Product</h3>
              <ul className="mt-4 space-y-2">
                <li>
                  <a href="#features" className="text-sm text-primary-200 hover:text-white">
                    Features
                  </a>
                </li>
                <li>
                  <a href="#pricing" className="text-sm text-primary-200 hover:text-white">
                    Pricing
                  </a>
                </li>
                <li>
                  <a href="/coming-soon" className="text-sm text-primary-200 hover:text-white">
                    Mobile App
                  </a>
                </li>
                <li>
                  <Link to="/blog" className="text-sm text-primary-200 hover:text-white">
                    Blog
                  </Link>
                </li>
                <li>
                  <Link to="/changelog" className="text-sm text-primary-200 hover:text-white">
                    Changelog
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Company</h3>
              <ul className="mt-4 space-y-2">
                <li>
                  <a href="/coming-soon" className="text-sm text-primary-200 hover:text-white">
                    About
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Legal</h3>
              <ul className="mt-4 space-y-2">
                <li>
                  <Link to="/legal/privacy" className="text-sm text-primary-200 hover:text-white">
                    Privacy
                  </Link>
                </li>
                <li>
                  <Link to="/legal/terms" className="text-sm text-primary-200 hover:text-white">
                    Terms
                  </Link>
                </li>
                <li>
                  <Link to="/status" className="text-sm text-primary-200 hover:text-white">
                    Status
                  </Link>
                </li>
              </ul>
            </div>
          </div>
          <div className="mt-12 pt-8 border-t border-primary-700/60 text-center">
            <p className="text-sm text-primary-200">
              &copy; {new Date().getFullYear()} Family Greenhouse. All rights reserved.
            </p>
            <div className="mt-6 flex items-center justify-center gap-4">
              <MemorialFrame className="h-8 w-32 text-primary-300/50 hidden sm:block" />
              <p className="text-sm italic text-primary-200">
                In loving memory of my mom, Joyce — who taught us to keep growing.
              </p>
              <MemorialFrame className="h-8 w-32 text-primary-300/50 hidden sm:block -scale-x-100" />
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

interface SectionHeadingProps {
  eyebrow: string;
  title: string;
  description?: string;
}

/** Section title pattern shared by Features / How / Pricing /
 *  Testimonials. The Gloock title sits over a TitleUnderline to match
 *  the in-app `PageHeader` rhythm. */
function SectionHeading({ eyebrow, title, description }: SectionHeadingProps) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-xs uppercase tracking-[0.22em] font-semibold text-primary-700/80">
        {eyebrow}
      </p>
      <h2 className="mt-3 font-serif text-4xl tracking-tight text-ink sm:text-5xl leading-tight">
        {title}
      </h2>
      <div className="mt-2 flex justify-center">
        <TitleUnderline className="h-3 w-40 text-primary-600" />
      </div>
      {description && <p className="mt-6 text-lg leading-8 text-gray-700">{description}</p>}
    </div>
  );
}
