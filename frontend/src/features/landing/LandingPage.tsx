import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  // The marketing feature grid uses the custom botanical icons below.
  // These Heroicons serve the AppMockup chrome plus the secondary
  // persona / "beyond the basics" bands, where a small line icon reads
  // as a label rather than competing with the hand-drawn feature icons.
  UserGroupIcon,
  ChartBarIcon,
  CheckIcon,
  HomeIcon,
  ClipboardDocumentListIcon,
  Cog6ToothIcon,
  BriefcaseIcon,
  SparklesIcon,
  ChatBubbleLeftRightIcon,
  CloudIcon,
  CameraIcon,
  BellAlertIcon,
} from '@heroicons/react/24/outline';
import { BrandMark } from '@/components/BrandMark';
import { CommercialHoldNotice } from '@/components/CommercialHoldNotice';
import { PricingGrid } from '@/features/pricing/PricingGrid';
import { IS_BETA, BETA_BADGE } from '@/lib/betaMode';
import { TitleUnderline } from '@/components/brand/TitleUnderline';
import { SprigDivider } from '@/components/brand/SprigDivider';
import { MemorialFrame } from '@/components/brand/MemorialFrame';
import { DashboardHeaderArt } from '@/components/headers/DashboardHeaderArt';
import { WaterDropIcon } from '@/components/icons/WaterDropIcon';
import { FertilizeIcon } from '@/components/icons/FertilizeIcon';
import { PruneIcon } from '@/components/icons/PruneIcon';
import { ReminderBellbloomIcon } from '@/components/icons/ReminderBellbloomIcon';
import { HouseholdSproutsIcon } from '@/components/icons/HouseholdSproutsIcon';
import { CalendarLeafIcon } from '@/components/icons/CalendarLeafIcon';
import { PhoneLeafIcon } from '@/components/icons/PhoneLeafIcon';
import { GrowthRingsIcon } from '@/components/icons/GrowthRingsIcon';
import { RootLockIcon } from '@/components/icons/RootLockIcon';
import { useHeroVariant, HERO_EXPERIMENT, type Variant } from '@/lib/experiment';
import { track, registerSuperProperties } from '@/services/analytics';
import { useMetaTags } from '@/hooks/useMetaTags';
import { SITE_URL, siteUrl } from '@/config/site';
import clsx from 'clsx';

// Hero copy for the two framings under test. Variant A (control) is the
// existing household / shared-care-journal hero. Variant B leads with
// keeping your own plants alive and names the solo case first, mentioning
// sharing second — same voice, same layout, same CTAs. The headline is
// split into an optional pre-quote / emphasized / post-quote so A can keep
// its italic "you" without giving B fake quotation marks.
//
// Removing the experiment: delete variant B below, inline variant A's copy
// back into the hero, and drop the variant plumbing in LandingPage.
const heroCopy: Record<
  Variant,
  {
    eyebrow: string;
    headlinePre: string;
    headlineEmphasis: string;
    headlinePost: string;
    subhead: React.ReactNode;
  }
> = {
  A: {
    eyebrow: 'A garden journal for the whole house',
    headlinePre: '“I thought ',
    headlineEmphasis: 'you',
    headlinePost: ' watered it.”',
    subhead: (
      <>
        Family Greenhouse is a shared care journal for the plants in your house. Everyone sees
        what&rsquo;s due and what&rsquo;s already done, so the fern doesn&rsquo;t get watered twice
        on Tuesday and then forgotten for two weeks.
      </>
    ),
  },
  B: {
    eyebrow: 'A care journal for your plants',
    headlinePre: 'Keep ',
    headlineEmphasis: 'every',
    headlinePost: ' plant alive.',
    subhead: (
      <>
        Family Greenhouse keeps a watering and care schedule for every plant you own, so nothing
        gets missed or drowned. It works just as well for one person and a windowsill as it does for
        a whole household sharing the watering can.
      </>
    ),
  },
};

const features = [
  {
    name: 'Reminders per plant',
    description:
      "Each plant gets its own schedule, and the nudge goes to whoever the task belongs to. The cactus stops getting watered on the fern's timetable.",
    icon: ReminderBellbloomIcon,
  },
  {
    name: 'Shared, with names attached',
    description:
      "Everyone in the household sees what's due and what's done. The log shows who did what, which settles the watering arguments quickly.",
    icon: HouseholdSproutsIcon,
  },
  {
    name: 'A week you can scan',
    description:
      'Every upcoming task on one calendar. A look on Sunday night tells you whether the week ahead is heavy or quiet.',
    icon: CalendarLeafIcon,
  },
  {
    name: 'Works at the sink',
    description:
      'Installs to your phone like any app. Mark a task done with one thumb, add a note, get back to the watering can.',
    icon: PhoneLeafIcon,
  },
  {
    name: 'A memory for each plant',
    description:
      'Notes, photos, and the full care log live with the plant. When leaves yellow, you check what happened instead of guessing.',
    icon: GrowthRingsIcon,
  },
  {
    name: 'Yours to keep',
    description:
      "Your household's data is encrypted in transit and at rest, and you can export all of it whenever you like.",
    icon: RootLockIcon,
  },
];

// Per-card surface/border/layout variation for the features grid, keyed
// by index. Breaks the six-identical-cards template read: backgrounds
// rotate through paper / parchment / white, border tints alternate
// green and terracotta, and two cards (2nd and 6th) go horizontal at
// lg. The `chip` class also carries the icon's text color so terracotta
// cards get a terracotta icon without touching the icon components.
const featureCardVariants = [
  {
    surface: 'bg-paper border-primary-100/60',
    chip: 'bg-primary-100 ring-primary-200/60 text-primary-700',
    horizontal: false,
  },
  {
    surface: 'bg-parchment border-primary-200/60',
    chip: 'bg-primary-100 ring-primary-200/60 text-primary-700',
    horizontal: true,
  },
  {
    surface: 'bg-white border-accent-200/50',
    chip: 'bg-accent-50 ring-accent-200/60 text-accent-700',
    horizontal: false,
  },
  {
    surface: 'bg-white border-primary-200/60',
    chip: 'bg-primary-100 ring-primary-200/60 text-primary-700',
    horizontal: false,
  },
  {
    surface: 'bg-paper border-accent-200/50',
    chip: 'bg-accent-50 ring-accent-200/60 text-accent-700',
    horizontal: false,
  },
  {
    surface: 'bg-parchment border-primary-100/60',
    chip: 'bg-primary-100 ring-primary-200/60 text-primary-700',
    horizontal: true,
  },
];

// The stable pricing anchor currently renders the repository-level commercial
// hold rather than plan or purchase content.

// Product facts the landing page can stand behind without lying about
// users we don't yet have. The earlier "50,000+ Happy Plants / 99.2%
// Plants Thriving" numbers were fabricated; replaced here with concrete,
// auditable claims about the app itself. When real adoption metrics
// exist, they belong in this list — sourced from analytics, not vibes.
const productFacts = [
  { value: 'Demo', label: 'New account registration is paused' },
  { value: 'Multi-user', label: 'Share care across the whole household' },
  { value: 'Existing accounts', label: 'Sign-in and stored care data remain available' },
  { value: 'Open APIs', label: 'Export your data any time' },
];

// Testimonials were removed outright (not just gated): the quotes were
// invented, and invented praise has no place on the page. When real,
// sourced quotes exist, reintroduce a section for them deliberately.

// "Who it's for" on-ramp band. The hero sells the couple/roommate case
// hard; these four cards let the other big personas the app actually
// serves self-identify and jump to the part that's for them. Each claim
// maps to a shipped feature: assign/claim + activity log; unlimited +
// CSV import; vacation coverage; the care-guide library.
const personas = [
  {
    icon: HouseholdSproutsIcon,
    label: 'Sharing a place',
    body: "A partner, roommates, a family — and no one's sure who watered what. Assign tasks or leave them up for grabs, and the activity log quietly keeps score.",
    href: '#features',
  },
  {
    icon: GrowthRingsIcon,
    label: 'A growing collection',
    body: 'Ten plants turned into forty. Import the spreadsheet you have been keeping, and let one dashboard hold every due date.',
    href: '#pricing',
  },
  {
    icon: BriefcaseIcon,
    label: 'Away a lot',
    body: "Gone for work or just the weekend. Set your dates and your tasks hand off to whoever's covering, marked so nothing quietly lapses.",
    href: '#features',
  },
  {
    icon: SparklesIcon,
    label: 'New and a little nervous',
    body: 'One sad succulent and a dented ego. Start with a plant that forgives you, lean on the care guides, and let the reminders do the remembering.',
    href: '/care',
  },
];

// "Beyond the basics" band. The feature grid covers the shared-schedule
// core; these are the parts that show up once you have more than a
// couple of plants, and the ones competitors mostly don't have. Paid
// gates are stated plainly rather than hidden.
const differentiators = [
  {
    icon: ChatBubbleLeftRightIcon,
    label: 'Ask the care assistant',
    body: 'Why are the leaves dropping? Ask in plain words and get an answer that can see your plants. Garden plan and up.',
  },
  {
    icon: CloudIcon,
    label: 'Weather-aware nudges',
    body: 'Add your location and the app offers to skip a watering when rain or a cold snap is on the way.',
  },
  {
    icon: CameraIcon,
    label: 'Check a leaf from a photo',
    body: 'Upload a struggling leaf and get a read on what might be going wrong. Garden plan and up.',
  },
  {
    icon: PruneIcon,
    label: 'Share a cutting',
    body: 'Propagating? Track which plant came from which, and send a friend a link to the cutting you are passing on.',
  },
  {
    icon: BellAlertIcon,
    label: "Reminders where you'll see them",
    body: 'Browser, email, or text. Pick the channel, set quiet hours, and both get respected.',
  },
  {
    icon: ChartBarIcon,
    label: 'A year, looked back on',
    body: 'Come December, see what the household actually did: plants added, tasks finished, the whole season.',
  },
];

// A few care guides to surface by name in the "before you buy" band.
// Slugs match features/care/careGuides.ts.
const featuredGuides = [
  { slug: 'pothos', name: 'Pothos' },
  { slug: 'snake-plant', name: 'Snake plant' },
  { slug: 'spider-plant', name: 'Spider plant' },
  { slug: 'monstera', name: 'Monstera' },
];

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
 * The illustrative data is fixed (Joyce / Briki / Steve / Kaitlin /
 * Chelsea, a few plants); this is a marketing mock, not a live
 * screenshot. Names and counts aren't claims — they're representative
 * content.
 */
function AppMockup({ className }: { className?: string }) {
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
    { name: 'Joyce', action: 'watered', target: 'Fiddle leaf fig', when: '2h ago' },
    { name: 'Briki', action: 'added', target: 'Pothos', when: '5h ago' },
    { name: 'Steve', action: 'repotted', target: 'Snake plant', when: 'Yesterday' },
    { name: 'Kaitlin', action: 'completed 3 tasks', target: '', when: 'Yesterday' },
    { name: 'Chelsea', action: 'pruned', target: 'Monstera', when: '2 days ago' },
  ];

  const taskIcons = { water: WaterDropIcon, fertilize: FertilizeIcon, prune: PruneIcon };
  const taskChip: Record<keyof typeof taskIcons, string> = {
    water: 'bg-sky-50 text-sky-700 ring-sky-200/70',
    fertilize: 'bg-primary-50 text-primary-700 ring-primary-200/70',
    prune: 'bg-accent-50 text-accent-700 ring-accent-200/70',
  };

  return (
    <div
      className={className}
      role="img"
      aria-label="Preview of the Family Greenhouse dashboard showing upcoming plant-care tasks and household activity."
    >
      <div
        aria-hidden="true"
        className="relative -m-2 rounded-2xl bg-glass/60 p-2 ring-1 ring-inset ring-dew lg:-m-4 lg:rounded-[1.75rem] lg:p-4"
      >
        <div className="rounded-lg bg-paper shadow-2xl ring-1 ring-primary-900/10 overflow-hidden">
          {/* Browser chrome */}
          <div className="bg-parchment px-4 py-3 border-b border-primary-200/60 flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-3 h-3 rounded-full bg-accent-400/80" />
              <div className="w-3 h-3 rounded-full bg-secondary-400/80" />
              <div className="w-3 h-3 rounded-full bg-primary-400/80" />
            </div>
            <div className="flex-1 text-center text-sm text-primary-900/70">
              familygreenhouse.net
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
                  <span className="font-serif text-sm tracking-tight text-white">
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
                  <p className="text-[10px] uppercase tracking-[0.18em] text-primary-700 font-semibold">
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
 * Decorative cluster of botanical sprigs behind the hero copy, at low
 * opacity so the hero reads as a hand-illustrated garden page rather
 * than a default-Tailwind landing. (Formerly mirrored on the right too;
 * the asymmetric hero's bleeding app mockup now owns that side.)
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
  // A/B test of the hero framing (control vs solo-first). Bucketing is
  // stable per browser; see lib/experiment.ts.
  const variant = useHeroVariant();

  useMetaTags({
    title: 'Family Greenhouse — Shared Plant Care & Watering Reminders',
    description:
      'A technical demonstration of shared plant watering schedules, reminders, care logs, and household tasks. New account registration is paused.',
    canonical: siteUrl('/'),
    ogType: 'website',
    ogImage: siteUrl('/brand/og-image.png'),
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Organization',
          '@id': `${SITE_URL}/#organization`,
          name: 'Family Greenhouse',
          url: SITE_URL,
          logo: siteUrl('/brand/icon-512.png'),
        },
        {
          '@type': 'WebSite',
          '@id': `${SITE_URL}/#website`,
          name: 'Family Greenhouse',
          url: SITE_URL,
          publisher: { '@id': `${SITE_URL}/#organization` },
        },
        {
          '@type': 'SoftwareApplication',
          '@id': `${SITE_URL}/#app`,
          name: 'Family Greenhouse',
          applicationCategory: 'LifestyleApplication',
          operatingSystem: 'Web',
          description:
            'A collaborative plant care app for household watering schedules, reminders, tasks, and care logs.',
          url: SITE_URL,
          publisher: { '@id': `${SITE_URL}/#organization` },
        },
      ],
    },
  });

  useEffect(() => {
    // Fire once per landing-page mount: records the impression and pins the
    // assignment as a super-property so the later signup_completed event (on
    // ConfirmEmailPage) is attributable to the variant this visitor saw.
    registerSuperProperties({ [HERO_EXPERIMENT]: variant });
    track('experiment_viewed', { experiment: HERO_EXPERIMENT, variant });
  }, [variant]);

  return (
    <div className="bg-paper">
      {/* Navigation */}
      <header className="absolute inset-x-0 top-0 z-50">
        <nav className="flex items-center justify-between gap-3 px-4 py-5 sm:p-6 lg:px-8 max-w-7xl mx-auto">
          <div className="flex lg:flex-1 items-center gap-2 min-w-0">
            <Link to="/" aria-label="Family Greenhouse home">
              <BrandMark variant="wordmark" size="sm" compactOnMobile />
            </Link>
            {IS_BETA && (
              <span className="rounded-full bg-accent-100 text-accent-800 text-xs font-semibold px-2 py-0.5 border border-accent-200/70 whitespace-nowrap">
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
            <a
              href="#pricing"
              className="text-sm font-semibold text-ink hover:text-primary-700 transition-colors"
            >
              Demo status
            </a>
          </div>
          <div className="flex shrink-0 justify-end items-center gap-x-3 sm:gap-x-6 lg:flex-1">
            <Link
              to="/login"
              className="text-sm font-semibold text-ink hover:text-primary-700 transition-colors py-2 whitespace-nowrap"
            >
              Log in
            </Link>
          </div>
        </nav>
      </header>

      {/* Hero Section — botanical wash on paper, no clip-path blurs. At
          lg the hero goes asymmetric: copy left-aligned in the left
          column, the app mockup bleeding off the right edge (the
          overflow-hidden wrapper crops it). Below lg it stays the
          stacked, centered layout. */}
      <div className="greenhouse-grid relative isolate overflow-hidden bg-paper pt-14">
        {/* Botanical wash behind the hero copy. `origin-bottom
            animate-sway` rocks the sprigs from the soil line; the
            global prefers-reduced-motion rule freezes it. */}
        <HeroSprigs
          className="pointer-events-none absolute left-0 top-24 -z-10 hidden md:block w-64 h-auto text-primary-300/25 origin-bottom animate-sway"
          aria-hidden="true"
        />

        <div className="py-24 sm:py-32 lg:py-36">
          <div className="mx-auto max-w-7xl px-6 lg:px-8">
            <div className="grid grid-cols-1 items-center lg:grid-cols-2 lg:gap-x-16">
              <div className="mx-auto max-w-2xl text-center lg:mx-0 lg:max-w-xl lg:text-left">
                <p className="text-xs uppercase tracking-[0.22em] text-primary-700 font-semibold mb-6">
                  {heroCopy[variant].eyebrow}
                </p>
                <h1 className="font-serif text-5xl tracking-tight text-ink sm:text-7xl lg:text-6xl xl:text-7xl leading-[1.05]">
                  {heroCopy[variant].headlinePre}
                  <span className="italic text-primary-700">
                    {heroCopy[variant].headlineEmphasis}
                  </span>
                  {heroCopy[variant].headlinePost}
                </h1>
                <div className="mt-4 flex justify-center lg:justify-start">
                  <TitleUnderline className="h-4 w-56 text-primary-600" />
                </div>
                <p className="mt-6 text-lg leading-8 text-gray-700">{heroCopy[variant].subhead}</p>
                <div className="mt-10 space-y-4">
                  <CommercialHoldNotice compact />
                  <a
                    href="#features"
                    className="inline-flex text-sm font-semibold leading-6 text-ink items-center gap-1 hover:text-primary-700 transition-colors"
                  >
                    See how it works <span aria-hidden="true">→</span>
                  </a>
                </div>
              </div>

              {/* App Preview — a faithful mock of the real product chrome
                  styled to match the redesigned dashboard (paper bg,
                  botanical task icons, inline metadata row, Gloock serif
                  welcome). The visual is the product. At lg it renders at
                  a readable fixed width and bleeds off the right edge of
                  the viewport rather than squeezing into the column. */}
              <AppMockup className="mt-16 sm:mt-24 lg:mt-0 lg:w-[56rem] lg:max-w-none" />
            </div>
          </div>
        </div>
      </div>

      {/* Product facts band — kept on the dark-green brand surface so it
          punches between the paper hero and the paper features section.
          Sprig dividers above + below give it the journal frame. */}
      <div className="bg-primary-900 py-16 relative">
        <SprigDivider
          className="absolute left-1/2 -top-3 h-6 w-40 -translate-x-1/2 text-paper"
          aria-hidden="true"
        />
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="grid grid-cols-2 gap-8 lg:grid-cols-4">
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

      {/* Who it's for — persona on-ramp. The facts band's bottom sprig
          already straddles the green → parchment seam above. Each card
          is a link into the part of the page (or the care guides) that
          speaks to that persona. */}
      <div className="py-20 sm:py-28 bg-parchment">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <SectionHeading
            eyebrow="Who it's for"
            title="However you ended up with plants"
            description="The whole house arguing over the watering can is one story. Here are a few of the others."
          />
          <div className="mx-auto mt-12 grid max-w-xl grid-cols-1 gap-6 sm:mt-16 sm:max-w-none sm:grid-cols-2 lg:grid-cols-4">
            {personas.map((persona) => (
              <a
                key={persona.label}
                href={persona.href}
                className="group flex flex-col rounded-2xl bg-paper p-6 shadow-journal ring-1 ring-primary-100/60 transition hover:ring-accent-300/70 hover:shadow-journal-hover"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-100 text-primary-700 ring-1 ring-primary-200/60 transition group-hover:bg-accent-50 group-hover:text-accent-700 group-hover:ring-accent-200/60">
                  <persona.icon className="h-6 w-6" aria-hidden="true" />
                </span>
                <span className="mt-4 font-serif text-lg text-ink">{persona.label}</span>
                <span className="mt-2 text-sm leading-6 text-gray-700">{persona.body}</span>
                <span className="mt-4 text-sm font-semibold text-primary-700 group-hover:text-accent-700">
                  See how <span aria-hidden="true">→</span>
                </span>
              </a>
            ))}
          </div>
        </div>
      </div>

      {/* Features Section */}
      <div id="features" className="py-20 sm:py-28 bg-paper">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <SectionHeading
            eyebrow="What it does"
            title="One schedule the whole house can see"
            description="Add a plant once and its schedule, reminders, photos, and history come along. The rest of the household sees the same thing you do."
          />
          <div className="mx-auto mt-12 max-w-2xl sm:mt-16 lg:mt-20 lg:max-w-none">
            <dl className="mx-auto grid max-w-xl grid-cols-1 gap-x-8 gap-y-10 md:max-w-none md:grid-cols-2 lg:grid-cols-3">
              {features.map((feature, index) => {
                const variant = featureCardVariants[index % featureCardVariants.length];
                return (
                  <div
                    key={feature.name}
                    className={clsx(
                      'relative rounded-2xl p-8 shadow-journal hover:shadow-journal-hover transition-shadow border',
                      variant.surface
                    )}
                  >
                    <dt
                      className={clsx(
                        'flex flex-col items-start gap-4',
                        variant.horizontal && 'lg:flex-row lg:items-center'
                      )}
                    >
                      <div
                        className={clsx(
                          'flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ring-1',
                          variant.chip
                        )}
                      >
                        <feature.icon className="h-6 w-6" aria-hidden="true" />
                      </div>
                      <span className="text-lg font-semibold leading-7 text-ink">
                        {feature.name}
                      </span>
                    </dt>
                    <dd
                      className={clsx(
                        'mt-2 text-base leading-7 text-gray-700',
                        variant.horizontal && 'lg:ml-16'
                      )}
                    >
                      {feature.description}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        </div>
      </div>

      {/* Beyond the basics — the differentiators that show up past a
          couple of plants. A sprig straddles the paper → parchment seam.
          Lighter weight than the feature grid: a small line icon + label
          + one line, so it reads as "and also" rather than a second
          headline act. */}
      <div className="py-20 sm:py-28 bg-parchment relative">
        <SprigDivider
          className="absolute left-1/2 -top-3 h-6 w-40 -translate-x-1/2 text-primary-600/80"
          aria-hidden="true"
        />
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <SectionHeading
            eyebrow="Beyond the basics"
            title="More than a reminder app"
            description="The shared schedule is where it starts. These are the parts you grow into."
          />
          {/* A list of features, not term/definition pairs — so a plain
              role="list" rather than a <dl> (which axe requires to contain
              only <dt>/<dd> groups, not the icon span + wrapper here). */}
          <ul
            role="list"
            className="mx-auto mt-12 grid max-w-xl grid-cols-1 gap-x-10 gap-y-8 sm:mt-16 sm:max-w-none sm:grid-cols-2 lg:grid-cols-3"
          >
            {differentiators.map((item) => (
              <li key={item.label} className="flex gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white text-primary-700 ring-1 ring-primary-200/60">
                  <item.icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <p className="font-semibold text-ink">{item.label}</p>
                  <p className="mt-1 text-sm leading-6 text-gray-700">{item.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* How It Works Section — now on paper, between two parchment
          bands; the sprig marks the seam. */}
      <div className="py-20 sm:py-28 bg-paper relative">
        <SprigDivider
          className="absolute left-1/2 -top-3 h-6 w-40 -translate-x-1/2 text-primary-600/80"
          aria-hidden="true"
        />
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <SectionHeading eyebrow="Setup" title="Three steps, about five minutes" />
          <div className="mx-auto mt-12 sm:mt-16 max-w-5xl">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              {[
                {
                  step: '1',
                  title: 'Add your plants',
                  description:
                    'A name and a photo will do. Pick a watering rhythm yourself or start from a species suggestion.',
                },
                {
                  step: '2',
                  title: 'Invite your household',
                  description:
                    'Send one link. Whoever lives with you joins and sees the same plants and the same task list.',
                },
                {
                  step: '3',
                  title: 'Split the work',
                  description:
                    "Assign tasks, or let whoever's home claim them. Reminders go out, the history fills in.",
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

      {/* Before you buy — the care-guide library doubles as a reason to
          trust the app and a stop for pet owners and nervous beginners.
          Two columns: the honest pitch, then a few guides by name. */}
      <div className="py-20 sm:py-28 bg-parchment relative">
        <SprigDivider
          className="absolute left-1/2 -top-3 h-6 w-40 -translate-x-1/2 text-primary-600/80"
          aria-hidden="true"
        />
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] font-semibold text-primary-700">
                Before you buy
              </p>
              <h2 className="mt-3 font-serif text-4xl tracking-tight text-ink sm:text-5xl leading-tight">
                Know what you&rsquo;re getting into
              </h2>
              <TitleUnderline className="mt-2 h-3 w-40 text-primary-600" />
              <p className="mt-6 text-lg leading-8 text-gray-700">
                The care guides are honest about the parts the plant-shop label skips: how often it
                actually needs water, what the brown tips are telling you, and whether it&rsquo;s
                safe around a cat or a curious toddler. Worth a read before the plant comes home.
              </p>
            </div>
            <div className="rounded-2xl bg-paper p-6 shadow-journal ring-1 ring-primary-100/60 sm:p-8">
              <h3 className="font-serif text-lg text-ink">Start with a guide</h3>
              <ul className="mt-4 grid grid-cols-2 gap-3">
                {featuredGuides.map((guide) => (
                  <li key={guide.slug}>
                    <Link
                      to={`/care/${guide.slug}`}
                      className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-ink ring-1 ring-primary-100/70 transition hover:bg-primary-50 hover:ring-primary-200"
                    >
                      <CheckIcon className="h-4 w-4 shrink-0 text-primary-600" aria-hidden="true" />
                      {guide.name}
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold">
                <Link to="/care" className="text-primary-700 hover:underline">
                  All care guides <span aria-hidden="true">→</span>
                </Link>
                <Link to="/blog" className="text-primary-700 hover:underline">
                  Read the blog <span aria-hidden="true">→</span>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Stable plan-status anchor. Commercial pricing and purchase content is
          absent while the repository-level hold remains active. */}
      <div id="pricing" className="py-20 sm:py-28 bg-paper relative">
        <SprigDivider
          className="absolute left-1/2 -top-3 h-6 w-40 -translate-x-1/2 text-primary-600/80"
          aria-hidden="true"
        />
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <SectionHeading
            eyebrow="Demo status"
            title="Commercial activity is paused"
            description="Family Greenhouse remains available as a technical demonstration. New account registration, paid plans, purchases, and plan changes are unavailable."
          />
          <PricingGrid />
          <p className="mt-12 text-center text-sm text-gray-700">
            Read the full{' '}
            <Link to="/pricing" className="font-medium text-primary-700 hover:underline">
              demo-status notice
            </Link>
            .
          </p>
        </div>
      </div>

      {/* Footer */}
      <footer className="bg-primary-900">
        <div className="mx-auto max-w-7xl px-6 py-12 lg:px-8">
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 lg:grid-cols-5">
            <div className="col-span-2 sm:col-span-3 lg:col-span-1">
              <Link to="/" aria-label="Family Greenhouse home">
                <BrandMark variant="wordmark" tone="light" />
              </Link>
              <p className="mt-4 text-sm text-primary-200">
                A shared care journal for the plants in your house.
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
                    Demo status
                  </a>
                </li>
                <li>
                  <a href="/coming-soon" className="text-sm text-primary-200 hover:text-white">
                    Mobile App
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Learn</h3>
              <ul className="mt-4 space-y-2">
                <li>
                  <Link to="/care" className="text-sm text-primary-200 hover:text-white">
                    Plant care guides
                  </Link>
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
                <li>
                  <a
                    href="mailto:hello@familygreenhouse.net"
                    className="text-sm text-primary-200 hover:text-white"
                  >
                    Contact
                  </a>
                </li>
                <li>
                  <Link to="/status" className="text-sm text-primary-200 hover:text-white">
                    Status
                  </Link>
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

/** Section title pattern shared by the marketing sections (Who it's
 *  for, Features, Beyond the basics, Setup, Pricing). The Gloock title
 *  sits over a TitleUnderline to match the in-app `PageHeader` rhythm. */
function SectionHeading({ eyebrow, title, description }: SectionHeadingProps) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-xs uppercase tracking-[0.22em] font-semibold text-primary-700">
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
