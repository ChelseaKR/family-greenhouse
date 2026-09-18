import { useEffect } from 'react';
import { Link } from 'react-router';
import { Trans, useTranslation } from 'react-i18next';
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
  CloudIcon,
  CameraIcon,
  BellAlertIcon,
} from '@heroicons/react/24/outline';
import { buttonStyles } from '@/components/buttonStyles';
import { BrandMark } from '@/components/BrandMark';
import { PricingGrid } from '@/features/pricing/PricingGrid';
import { IS_BETA, BETA_BADGE } from '@/lib/betaMode';
import { TitleUnderline } from '@/components/brand/TitleUnderline';
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
import { PUBLIC_REGISTRATION_AVAILABLE, COMMERCIAL_HOLD_ACTIVE } from '@/config/commercialStatus';
import { planBandFor } from './planBand';
import clsx from 'clsx';

// Hero copy for the two framings under test. Variant A (control) is the
// existing household / shared-care-journal hero. Variant B leads with
// keeping your own plants alive and names the solo case first, mentioning
// sharing second — same voice, same layout, same CTAs. The headline is
// split into an optional pre-quote / emphasized / post-quote so A can keep
// its italic "you" without giving B fake quotation marks.
//
// The copy lives in the catalogs under `landing.hero.a` / `landing.hero.b`
// (#467: this page rendered in English for Spanish-speaking visitors).
//
// Removing the experiment: delete variant B below and its catalog keys, and
// drop the variant plumbing in LandingPage.
const HERO_COPY_KEY: Record<Variant, string> = {
  A: 'landing.hero.a',
  B: 'landing.hero.b',
};

// Sets expectations right next to the primary CTA instead of a scroll away
// in the product-facts band (paid-acquisition readiness review, §4 note 4:
// "'No credit card' is one scroll below the fold... not literally next to
// the primary CTA button"). Also names the actual signup steps up front —
// full name, email, a password, then an emailed confirmation code — so a
// cold paid-traffic visitor isn't surprised mid-flow, which the same review
// flagged as "the most likely place a paid-traffic visitor abandons" (§4
// note 1). Reuses the "five minutes" figure already stated in the Setup
// section below rather than inventing a new one. Not part of the hero A/B
// test (HERO_COPY_KEY above): this renders identically under both variants.
// Copy: `landing.hero.signupNote`.

// Each entry's copy is `landing.features.<id>.name` / `.description`.
const features = [
  { id: 'reminders', icon: ReminderBellbloomIcon },
  { id: 'shared', icon: HouseholdSproutsIcon },
  { id: 'week', icon: CalendarLeafIcon },
  { id: 'sink', icon: PhoneLeafIcon },
  { id: 'memory', icon: GrowthRingsIcon },
  { id: 'yours', icon: RootLockIcon },
  {
    // The Away Kit was shipped but never named in this grid — the
    // paid-acquisition readiness review (§4 note 2) found that a visitor
    // clicking the sitter/vacation ad or keyword landed on a page that
    // never mentioned sitters, handoff, or vacation coverage by name
    // outside one persona-card sentence. Grounded in the real feature at
    // frontend/src/features/sitter/SitPage.tsx (base link, every plan) and
    // backend/src/models/plans.ts (sitterLinkMaxDays/sitterLinksActive;
    // Away Kit gating via planIncludesAwayKit).
    id: 'cover',
    icon: BriefcaseIcon,
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

// The stable pricing anchor keeps paid activity on hold while free Seedling
// registration remains available.

// Product facts the landing page can stand behind without lying about
// users we don't yet have. The earlier "50,000+ Happy Plants / 99.2%
// Plants Thriving" numbers were fabricated; replaced here with concrete,
// auditable claims about the app itself. When real adoption metrics
// exist, they belong in this list — sourced from analytics, not vibes.
// Each fact's copy is `landing.facts.<id>.value` / `.label`; the free-plan
// caps in it are re-derived from plans.ts by scripts/check-plan-copy.mjs.
const productFacts = [
  PUBLIC_REGISTRATION_AVAILABLE ? 'free' : 'existing',
  'people',
  'minutes',
  'portable',
];

// Testimonials were removed outright (not just gated): the quotes were
// invented, and invented praise has no place on the page. When real,
// sourced quotes exist, reintroduce a section for them deliberately.

// "Who it's for" on-ramp band. The hero sells the couple/roommate case
// hard; these four cards let the other big personas the app actually
// serves self-identify and jump to the part that's for them. Each claim
// maps to a shipped feature: assign/claim + activity log; unlimited +
// CSV import; vacation coverage; the care-guide library. Copy:
// `landing.who.<id>.label` / `.body`.
const personas = [
  { id: 'sharing', icon: HouseholdSproutsIcon, href: '#features' },
  { id: 'growing', icon: GrowthRingsIcon, href: '#pricing' },
  // Body names the actual mechanism (a link, no account, no app) rather
  // than the vaguer "hand off to whoever's covering" — the paid-acquisition
  // review (§4 note 2) found a visitor clicking the vacation/sitter ad or
  // keyword landed on a page that didn't reinforce what the ad promised.
  // It mirrors Creative 2's own hook line ("no app, no account, no
  // confusion") in the section that persona actually reads first.
  { id: 'away', icon: BriefcaseIcon, href: '#features' },
  { id: 'new', icon: SparklesIcon, href: '/care' },
];

// "Beyond the basics" band. The feature grid covers the shared-schedule
// core; these are the parts that show up once you have more than a
// couple of plants, and the ones competitors mostly don't have. Copy:
// `landing.beyond.<id>.label` / `.body`.
const differentiators = [
  { id: 'weather', icon: CloudIcon },
  { id: 'leaf', icon: CameraIcon },
  { id: 'cutting', icon: PruneIcon },
  // `landing.beyond.reminders.body` names browser and email only: SMS is
  // built but gated on SMS_NOTIFICATIONS_ENABLED, which production leaves
  // empty (environments/production/terraform.tfvars), so the toggle is
  // disabled for every real user and the help page says as much. "or text"
  // goes back in when the flag is on, not before.
  //
  // Quiet hours cover both channels. Until #343's owner decision (2026-09-17)
  // they covered only email — browser push was exempt, and this band had to
  // say so (#702). Now `eligibleReminderChannels`
  // (backend/src/services/reminders.ts) routes every channel through
  // `inDnd ? dndDeferred : eligible` and `notifier.sendToUser` suppresses
  // push inside the window too. PublicAcquisitionHold.test.tsx reads that
  // function, in both catalogs, so if push is ever exempted again this
  // sentence has to change.
  { id: 'reminders', icon: BellAlertIcon },
  { id: 'year', icon: ChartBarIcon },
];

// A few care guides to surface by name in the "before you buy" band.
// Slugs match features/care/careGuides.ts. Monstera and Pothos are genus
// names, the same in every locale; the other two have common names that
// differ, so they come from the catalog.
const featuredGuides = [
  { slug: 'pothos', name: 'Pothos' },
  { slug: 'snake-plant', nameKey: 'landing.plants.snakePlant' },
  { slug: 'spider-plant', nameKey: 'landing.plants.spiderPlant' },
  { slug: 'monstera', name: 'Monstera' },
];

/** Shown in the mock browser's address bar. */
const MOCK_HOST = 'familygreenhouse.net';

/**
 * Marketing-page mockup of the running app. Structure mirrors the live
 * `Layout` + redesigned `DashboardPage`:
 *
 *  - Browser chrome (traffic lights + URL bar) on top.
 *  - Dark green sidebar with the brand lockup + main nav, "Dashboard"
 *    pinned active.
 *  - Content area styled "garden journal" — paper background, Bitter
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
  const { t } = useTranslation();
  // The in-app nav's own labels, so the mock reads exactly like the product
  // does in the visitor's language.
  const navItems = [
    { id: 'dashboard', name: t('nav.dashboard'), icon: HomeIcon, active: true },
    { id: 'plants', name: t('nav.plants'), icon: SidebarLeafIcon, active: false },
    { id: 'tasks', name: t('nav.tasks'), icon: ClipboardDocumentListIcon, active: false },
    { id: 'analytics', name: t('nav.analytics'), icon: ChartBarIcon, active: false },
    { id: 'household', name: t('nav.household'), icon: UserGroupIcon, active: false },
    { id: 'settings', name: t('nav.settings'), icon: Cog6ToothIcon, active: false },
  ];

  const snakePlant = t('landing.plants.snakePlant');
  const todayTasks: Array<{
    type: 'water' | 'fertilize' | 'prune';
    plant: string;
    when: string;
  }> = [
    { type: 'water', plant: 'Monstera', when: t('common.today') },
    { type: 'fertilize', plant: snakePlant, when: t('common.today') },
    { type: 'prune', plant: t('landing.plants.bostonFern'), when: t('common.tomorrow') },
  ];

  // `plant` feeds the `{{plant}}` slot in `landing.mockup.activity.*`; the
  // people are fixed illustrative names, the same in every locale.
  const activity = [
    {
      name: 'Joyce',
      action: 'watered',
      plant: t('landing.plants.fiddleLeafFig'),
      when: t('landing.mockup.hoursAgo', { hours: 2 }),
    },
    {
      name: 'Briki',
      action: 'added',
      plant: 'Pothos',
      when: t('landing.mockup.hoursAgo', { hours: 5 }),
    },
    { name: 'Steve', action: 'repotted', plant: snakePlant, when: t('common.yesterday') },
    { name: 'Kaitlin', action: 'completedTasks', plant: '', when: t('common.yesterday') },
    {
      name: 'Chelsea',
      action: 'pruned',
      plant: 'Monstera',
      when: t('common.daysAgo', { count: 2 }),
    },
  ];

  const taskIcons = { water: WaterDropIcon, fertilize: FertilizeIcon, prune: PruneIcon };
  const taskChip: Record<keyof typeof taskIcons, string> = {
    water: 'bg-sky-50 text-sky-700 ring-sky-200/70',
    fertilize: 'bg-primary-50 text-primary-700 ring-primary-200/70',
    prune: 'bg-accent-50 text-accent-700 ring-accent-200/70',
  };

  return (
    <div className={className} role="img" aria-label={t('landing.mockup.label')}>
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
            <div className="flex-1 text-center text-sm text-primary-900/70">{MOCK_HOST}</div>
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
                    {t('brand.tagline')}
                  </span>
                </span>
              </div>

              <div className="rounded-md bg-primary-900/40 ring-1 ring-primary-600/30 px-3 py-2">
                <p className="text-[10px] text-primary-200">{t('nav.activeHousehold')}</p>
                <p className="text-sm font-medium text-white">
                  {t('landing.mockup.householdName')}
                </p>
              </div>

              <div className="flex-1 -mx-2 space-y-1">
                {navItems.map((item) => (
                  <span
                    key={item.id}
                    className={clsx(
                      'group flex items-center gap-x-3 rounded-md p-2 text-sm font-medium leading-6',
                      item.active
                        ? 'bg-primary-700/80 text-white shadow-xs ring-1 ring-primary-600/50'
                        : 'text-primary-100/90'
                    )}
                  >
                    <item.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                    {item.name}
                  </span>
                ))}
              </div>
            </aside>

            {/* Main content — mirrors the redesigned `DashboardPage`. */}
            <div className="flex-1 p-4 sm:p-6 min-w-0">
              <header className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-primary-700 font-semibold">
                    {t('landing.mockup.eyebrow')}
                  </p>
                  <p className="mt-1 font-serif text-2xl text-ink leading-tight">
                    {t('landing.mockup.welcome', { name: 'Chelsea' })}
                  </p>
                  <TitleUnderline className="mt-1 ml-0.5 h-2 w-28 text-primary-600" />
                  <p className="mt-2 text-xs text-gray-600">{t('landing.mockup.lede')}</p>
                </div>
                <div className="hidden lg:block shrink-0 w-28">
                  <DashboardHeaderArt className="w-full h-auto" />
                </div>
              </header>

              {/* Inline metadata row (replaces the old 3-tile KPI grid). */}
              <dl className="mt-5 flex flex-wrap items-baseline gap-x-6 gap-y-2 text-xs">
                <Metric label={t('nav.plants')} value="12" />
                <Metric label={t('landing.mockup.dueToday')} value="3" />
                <Metric label={t('landing.mockup.overdue')} value="0" />
              </dl>

              {/* Today's tasks + Activity. */}
              <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-4">
                <section className="rounded-xl bg-paper border border-primary-100/70 shadow-journal overflow-hidden">
                  <header className="px-4 py-3 border-b border-primary-100/70">
                    <p className="text-sm font-semibold text-ink">{t('landing.mockup.upcoming')}</p>
                  </header>
                  <ul className="divide-y divide-primary-100/60">
                    {todayTasks.map((task) => {
                      const Icon = taskIcons[task.type];
                      return (
                        <li key={task.type} className="flex items-center gap-3 px-4 py-3">
                          <span
                            className={clsx(
                              'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1',
                              taskChip[task.type]
                            )}
                            aria-hidden="true"
                          >
                            <Icon className="h-5 w-5" />
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-ink truncate">{task.plant}</p>
                            <p className="text-[11px] text-gray-600 capitalize">
                              {t(`tasks.types.${task.type}`)} • {task.when}
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
                    <p className="text-sm font-semibold text-ink">
                      {t('landing.mockup.activityTitle')}
                    </p>
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
                            <Trans
                              i18nKey={`landing.mockup.activity.${a.action}`}
                              values={{ name: a.name, plant: a.plant }}
                              components={{ b: <span className="font-medium" /> }}
                            />
                          </p>
                          <p className="text-[11px] text-gray-600">{a.when}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            </div>
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
      {/* `leading-4` (1rem) restates the line-height this label inherited under
          Tailwind v3. v3's font-size utilities set line-height as an absolute
          length (`text-xs` → `1rem`), so the enclosing `dl.text-xs` handed this
          10px label a fixed 16px. v4 expresses the same defaults as unitless
          ratios, which re-resolve against the child's own font-size (10px →
          13.3px) and shrink the row. */}
      <dt className="text-[10px] uppercase tracking-[0.14em] leading-4 text-gray-500">{label}</dt>
      <dd className="font-serif text-base text-ink leading-none tabular-nums">{value}</dd>
    </div>
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
  const { t } = useTranslation();
  // A/B test of the hero framing (control vs solo-first). Bucketing is
  // stable per browser; see lib/experiment.ts.
  const variant = useHeroVariant();
  // Both commercial gates decide the plans-band copy, not registration alone.
  const planBand = planBandFor(COMMERCIAL_HOLD_ACTIVE, PUBLIC_REGISTRATION_AVAILABLE, t);
  const hero = HERO_COPY_KEY[variant];

  useMetaTags({
    title: t('landing.meta.title'),
    description: PUBLIC_REGISTRATION_AVAILABLE
      ? t('landing.meta.descriptionOpen')
      : t('landing.meta.descriptionClosed'),
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
          ...(PUBLIC_REGISTRATION_AVAILABLE
            ? {
                offers: {
                  '@type': 'Offer',
                  price: '0',
                  priceCurrency: 'USD',
                  description: 'Free for one home, up to 3 household members and 20 plants',
                },
              }
            : {}),
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
            <Link to="/" aria-label={t('publicShell.homeLabel')}>
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
              {t('landing.nav.features')}
            </a>
            <a
              href="#pricing"
              className="text-sm font-semibold text-ink hover:text-primary-700 transition-colors"
            >
              {t('publicShell.pricing')}
            </a>
            <Link
              to="/gift"
              className="text-sm font-semibold text-ink hover:text-primary-700 transition-colors"
            >
              {t('giftLanding.navLink')}
            </Link>
          </div>
          <div className="flex shrink-0 justify-end items-center gap-x-3 sm:gap-x-6 lg:flex-1">
            <Link
              to="/login"
              className="text-sm font-semibold text-ink hover:text-primary-700 transition-colors py-2 whitespace-nowrap"
            >
              {t('landing.nav.logIn')}
            </Link>
            {PUBLIC_REGISTRATION_AVAILABLE && (
              <Link to="/register" className={buttonStyles()}>
                {t('auth.signUpFree')}
              </Link>
            )}
          </div>
        </nav>
      </header>

      {/* Everything between the site header and the footer is the page's
          main content. Without this the only <main> in the document was the
          one inside AppMockup — decorative chrome behind role="img"
          aria-hidden — so App.tsx's skip link, which resolves
          querySelector('main'), sent keyboard users into a picture. */}
      <main>
        {/* Hero Section — plain paper keeps the product preview in focus. At
          lg the hero goes asymmetric: copy left-aligned in the left
          column, the app mockup bleeding off the right edge (the
          overflow-hidden wrapper crops it). Below lg it stays the
          stacked, centered layout. */}
        <div className="overflow-hidden bg-paper pt-14">
          <div className="py-24 sm:py-32 lg:py-36">
            <div className="mx-auto max-w-7xl px-6 lg:px-8">
              <div className="grid grid-cols-1 items-center lg:grid-cols-2 lg:gap-x-16">
                <div className="mx-auto max-w-2xl text-center lg:mx-0 lg:max-w-xl lg:text-left">
                  <p className="text-xs uppercase tracking-[0.22em] text-primary-700 font-semibold mb-6">
                    {t(`${hero}.eyebrow`)}
                  </p>
                  {/* `sm:leading-none` pins the ≥sm line-height to 1. Under Tailwind v3
                    the responsive `text-*` utilities won over the unprefixed
                    `leading-[1.05]` purely on source order (their media queries came
                    later in the stylesheet), so this headline has always rendered at
                    a 1.0 ratio from `sm` up. v4 composes leading through
                    `--tw-leading`, which makes `leading-[1.05]` win at every
                    breakpoint — pinning keeps the shipped rendering unchanged. */}
                  <h1 className="font-serif text-5xl tracking-tight text-ink sm:text-7xl lg:text-6xl xl:text-7xl leading-[1.05] sm:leading-none">
                    {t(`${hero}.headlinePre`)}
                    <span className="italic text-primary-700">{t(`${hero}.headlineEmphasis`)}</span>
                    {t(`${hero}.headlinePost`)}
                  </h1>
                  <div className="mt-4 flex justify-center lg:justify-start">
                    <TitleUnderline className="h-4 w-56 text-primary-600" />
                  </div>
                  <p className="mt-6 text-lg leading-8 text-gray-700">{t(`${hero}.subhead`)}</p>
                  <div className="mt-10 flex items-center justify-center gap-x-6 lg:justify-start">
                    {PUBLIC_REGISTRATION_AVAILABLE && (
                      <Link to="/register" className={buttonStyles({ size: 'lg' })}>
                        {t('auth.signUpFree')}
                      </Link>
                    )}
                    <a
                      href="#features"
                      className="text-sm font-semibold leading-6 text-ink flex items-center gap-1 hover:text-primary-700 transition-colors"
                    >
                      {t('landing.hero.seeHowItWorks')} <span aria-hidden="true">→</span>
                    </a>
                  </div>
                  {PUBLIC_REGISTRATION_AVAILABLE && (
                    <p className="mt-4 text-sm text-gray-600">{t('landing.hero.signupNote')}</p>
                  )}
                </div>

                {/* App Preview — a faithful mock of the real product chrome
                  styled to match the redesigned dashboard (paper bg,
                  botanical task icons, inline metadata row, Bitter serif
                  welcome). The visual is the product. At lg it renders at
                  a readable fixed width and bleeds off the right edge of
                  the viewport rather than squeezing into the column. */}
                <AppMockup className="mt-16 sm:mt-24 lg:mt-0 lg:w-[56rem] lg:max-w-none" />
              </div>
            </div>
          </div>
        </div>

        {/* Product facts band — kept on the dark-green brand surface so it
          punches between the paper hero and the paper features section. */}
        <div className="bg-primary-900 py-16">
          <div className="mx-auto max-w-7xl px-6 lg:px-8">
            <div className="grid grid-cols-2 gap-8 lg:grid-cols-4">
              {productFacts.map((fact) => (
                <div key={fact} className="text-center">
                  <div className="font-serif text-3xl text-white sm:text-4xl tabular-nums">
                    {t(`landing.facts.${fact}.value`)}
                  </div>
                  <div className="mt-2 text-sm text-primary-100">
                    {t(`landing.facts.${fact}.label`)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Who it's for — persona on-ramp. Each card is a link into the part
          of the page (or the care guides) that speaks to that persona. */}
        <div className="py-20 sm:py-28 bg-parchment">
          <div className="mx-auto max-w-7xl px-6 lg:px-8">
            <SectionHeading
              eyebrow={t('landing.who.eyebrow')}
              title={t('landing.who.title')}
              description={t('landing.who.description')}
            />
            <div className="mx-auto mt-12 grid max-w-xl grid-cols-1 gap-6 sm:mt-16 sm:max-w-none sm:grid-cols-2 lg:grid-cols-4">
              {personas.map((persona) => (
                <a
                  key={persona.id}
                  href={persona.href}
                  className="group flex flex-col rounded-2xl bg-paper p-6 shadow-journal ring-1 ring-primary-100/60 transition hover:ring-accent-300/70 hover:shadow-journal-hover"
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-100 text-primary-700 ring-1 ring-primary-200/60 transition group-hover:bg-accent-50 group-hover:text-accent-700 group-hover:ring-accent-200/60">
                    <persona.icon className="h-6 w-6" aria-hidden="true" />
                  </span>
                  <span className="mt-4 font-serif text-lg text-ink">
                    {t(`landing.who.${persona.id}.label`)}
                  </span>
                  <span className="mt-2 text-sm leading-6 text-gray-700">
                    {t(`landing.who.${persona.id}.body`)}
                  </span>
                  <span className="mt-4 text-sm font-semibold text-primary-700 group-hover:text-accent-700">
                    {t('landing.who.seeHow')} <span aria-hidden="true">→</span>
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
              eyebrow={t('landing.features.eyebrow')}
              title={t('landing.features.title')}
              description={t('landing.features.description')}
            />
            <div className="mx-auto mt-12 max-w-2xl sm:mt-16 lg:mt-20 lg:max-w-none">
              <dl className="mx-auto grid max-w-xl grid-cols-1 gap-x-8 gap-y-10 md:max-w-none md:grid-cols-2 lg:grid-cols-3">
                {features.map((feature, index) => {
                  const variant = featureCardVariants[index % featureCardVariants.length];
                  return (
                    <div
                      key={feature.id}
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
                          {t(`landing.features.${feature.id}.name`)}
                        </span>
                      </dt>
                      <dd
                        className={clsx(
                          'mt-2 text-base leading-7 text-gray-700',
                          variant.horizontal && 'lg:ml-16'
                        )}
                      >
                        {t(`landing.features.${feature.id}.description`)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          </div>
        </div>

        {/* Beyond the basics — the differentiators that show up past a
          couple of plants. Lighter weight than the feature grid: a small line icon + label
          + one line, so it reads as "and also" rather than a second
          headline act. */}
        <div className="py-20 sm:py-28 bg-parchment">
          <div className="mx-auto max-w-7xl px-6 lg:px-8">
            <SectionHeading
              eyebrow={t('landing.beyond.eyebrow')}
              title={t('landing.beyond.title')}
              description={t('landing.beyond.description')}
            />
            {/* A list of features, not term/definition pairs — so a plain
              role="list" rather than a <dl> (which axe requires to contain
              only <dt>/<dd> groups, not the icon span + wrapper here). */}
            <ul
              role="list"
              className="mx-auto mt-12 grid max-w-xl grid-cols-1 gap-x-10 gap-y-8 sm:mt-16 sm:max-w-none sm:grid-cols-2 lg:grid-cols-3"
            >
              {differentiators.map((item) => (
                <li key={item.id} className="flex gap-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white text-primary-700 ring-1 ring-primary-200/60">
                    <item.icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div>
                    <p className="font-semibold text-ink">{t(`landing.beyond.${item.id}.label`)}</p>
                    <p className="mt-1 text-sm leading-6 text-gray-700">
                      {t(`landing.beyond.${item.id}.body`)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* How It Works Section — on paper between two parchment bands. */}
        <div className="py-20 sm:py-28 bg-paper">
          <div className="mx-auto max-w-7xl px-6 lg:px-8">
            <SectionHeading eyebrow={t('landing.setup.eyebrow')} title={t('landing.setup.title')} />
            <div className="mx-auto mt-12 sm:mt-16 max-w-5xl">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                {[
                  { step: '1', id: 'add' },
                  { step: '2', id: 'invite' },
                  { step: '3', id: 'split' },
                ].map((item) => (
                  <div key={item.step} className="text-center">
                    <div
                      className="mx-auto w-16 h-16 rounded-full bg-primary-700 ring-4 ring-primary-100 text-paper flex items-center justify-center font-serif text-2xl mb-6"
                      aria-hidden="true"
                    >
                      {item.step}
                    </div>
                    <h3 className="font-serif text-xl text-ink mb-3">
                      {t(`landing.setup.${item.id}.title`)}
                    </h3>
                    <p className="text-gray-700">{t(`landing.setup.${item.id}.description`)}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Before you bring a plant home — the care-guide library doubles as a reason to
          trust the app and a stop for pet owners and nervous beginners.
          Two columns: the honest pitch, then a few guides by name. */}
        <div className="py-20 sm:py-28 bg-parchment">
          <div className="mx-auto max-w-7xl px-6 lg:px-8">
            <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] font-semibold text-primary-700">
                  {t('landing.care.eyebrow')}
                </p>
                {/* `sm:leading-none` — see the hero h1: v3 let `sm:text-5xl` (line-height 1)
                  override the unprefixed `leading-tight` on source order, so this
                  heading has always rendered at 1.0 from `sm` up. */}
                <h2 className="mt-3 font-serif text-4xl tracking-tight text-ink sm:text-5xl leading-tight sm:leading-none">
                  {t('landing.care.title')}
                </h2>
                <TitleUnderline className="mt-2 h-3 w-40 text-primary-600" />
                <p className="mt-6 text-lg leading-8 text-gray-700">{t('landing.care.body')}</p>
              </div>
              <div className="rounded-2xl bg-paper p-6 shadow-journal ring-1 ring-primary-100/60 sm:p-8">
                <h3 className="font-serif text-lg text-ink">{t('landing.care.startWithGuide')}</h3>
                <ul className="mt-4 grid grid-cols-2 gap-3">
                  {featuredGuides.map((guide) => (
                    <li key={guide.slug}>
                      <Link
                        to={`/care/${guide.slug}`}
                        className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-ink ring-1 ring-primary-100/70 transition hover:bg-primary-50 hover:ring-primary-200"
                      >
                        <CheckIcon
                          className="h-4 w-4 shrink-0 text-primary-600"
                          aria-hidden="true"
                        />
                        {guide.nameKey ? t(guide.nameKey) : guide.name}
                      </Link>
                    </li>
                  ))}
                </ul>
                <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold">
                  <Link to="/care" className="text-primary-700 hover:underline">
                    {t('landing.care.allGuides')} <span aria-hidden="true">→</span>
                  </Link>
                  <Link to="/blog" className="text-primary-700 hover:underline">
                    {t('landing.care.readBlog')} <span aria-hidden="true">→</span>
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Plans band. Copy is chosen by BOTH commercial gates — see
          planBandFor — so this heading can never announce a pause over a
          catalog that is actually selling. `PricingGrid` remains the
          authority on whether any amount is shown at all. */}
        <div id="pricing" className="py-20 sm:py-28 bg-paper">
          <div className="mx-auto max-w-7xl px-6 lg:px-8">
            <SectionHeading
              eyebrow={t('landing.plans.eyebrow')}
              title={planBand.title}
              description={planBand.description}
            />
            <PricingGrid />
            <p className="mt-12 text-center text-sm text-gray-700">
              {planBand.footerNote}{' '}
              <Link to="/pricing" className="font-medium text-primary-700 hover:underline">
                {planBand.footerLink}
              </Link>
              .
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-primary-900">
        <div className="mx-auto max-w-7xl px-6 py-12 lg:px-8">
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 lg:grid-cols-5">
            <div className="col-span-2 sm:col-span-3 lg:col-span-1">
              <Link to="/" aria-label={t('publicShell.homeLabel')}>
                <BrandMark variant="wordmark" tone="light" />
              </Link>
              <p className="mt-4 text-sm text-primary-200">{t('landing.footer.tagline')}</p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">{t('landing.footer.product')}</h3>
              <ul className="mt-4 space-y-2">
                <li>
                  <a href="#features" className="text-sm text-primary-200 hover:text-white">
                    {t('landing.nav.features')}
                  </a>
                </li>
                <li>
                  <a href="#pricing" className="text-sm text-primary-200 hover:text-white">
                    {t('publicShell.pricing')}
                  </a>
                </li>
                <li>
                  <Link to="/gift" className="text-sm text-primary-200 hover:text-white">
                    {t('giftLanding.navLink')}
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">{t('landing.footer.learn')}</h3>
              <ul className="mt-4 space-y-2">
                <li>
                  <Link to="/care" className="text-sm text-primary-200 hover:text-white">
                    {t('landing.footer.plantCareGuides')}
                  </Link>
                </li>
                <li>
                  <Link to="/blog" className="text-sm text-primary-200 hover:text-white">
                    {t('publicShell.blog')}
                  </Link>
                </li>
                <li>
                  <Link to="/changelog" className="text-sm text-primary-200 hover:text-white">
                    {t('footer.changelog')}
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">{t('landing.footer.company')}</h3>
              <ul className="mt-4 space-y-2">
                <li>
                  <a
                    href="mailto:hello@familygreenhouse.net"
                    className="text-sm text-primary-200 hover:text-white"
                  >
                    {t('landing.footer.contact')}
                  </a>
                </li>
                <li>
                  <Link to="/status" className="text-sm text-primary-200 hover:text-white">
                    {t('footer.status')}
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">{t('landing.footer.legal')}</h3>
              <ul className="mt-4 space-y-2">
                <li>
                  <Link to="/legal/privacy" className="text-sm text-primary-200 hover:text-white">
                    {t('footer.privacy')}
                  </Link>
                </li>
                <li>
                  <Link to="/legal/terms" className="text-sm text-primary-200 hover:text-white">
                    {t('footer.terms')}
                  </Link>
                </li>
              </ul>
            </div>
          </div>
          <div className="mt-12 pt-8 border-t border-primary-700/60 text-center">
            <p className="text-sm text-primary-200">
              {t('landing.footer.copyright', { year: new Date().getFullYear() })}
            </p>
            <div className="mt-6 flex items-center justify-center gap-4">
              <MemorialFrame className="h-8 w-32 text-primary-300/50 hidden sm:block" />
              <p className="text-sm italic text-primary-200">{t('footer.memorial')}</p>
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
 *  for, Features, Beyond the basics, Setup, Pricing). The Bitter title
 *  sits over a TitleUnderline to match the in-app `PageHeader` rhythm. */
function SectionHeading({ eyebrow, title, description }: SectionHeadingProps) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-xs uppercase tracking-[0.22em] font-semibold text-primary-700">
        {eyebrow}
      </p>
      {/* `sm:leading-none` — see the hero h1: v3 let `sm:text-5xl` (line-height 1)
          override the unprefixed `leading-tight` on source order, so this heading
          has always rendered at 1.0 from `sm` up. */}
      <h2 className="mt-3 font-serif text-4xl tracking-tight text-ink sm:text-5xl leading-tight sm:leading-none">
        {title}
      </h2>
      <div className="mt-2 flex justify-center">
        <TitleUnderline className="h-3 w-40 text-primary-600" />
      </div>
      {description && <p className="mt-6 text-lg leading-8 text-gray-700">{description}</p>}
    </div>
  );
}
