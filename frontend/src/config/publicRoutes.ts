import { PUBLIC_REGISTRATION_AVAILABLE } from './commercialStatus.ts';
import { siteUrl } from './site.ts';
import { HERO_HEADLINES, headlineText } from '../features/landing/heroHeadlines.ts';

/**
 * The public, indexable routes with fixed paths, and the head each one must
 * serve. One entry per URL search engines are invited to crawl; the two
 * generated families (`/blog/:slug`, `/care/:slug`) come from their own
 * content manifests and are joined onto this list by `scripts/seo-routes.mjs`.
 *
 * Why this file exists: every route used to state its own title, description
 * and canonical inline in its component, which meant nothing outside React
 * could know them. The served HTML was therefore the same shell for all 25
 * sitemap URLs — one title, one description, no <h1>, no canonical — because
 * the only code that knew a route's head ran after hydration. Build-time
 * prerendering needs that knowledge in a module a plain Node script can read,
 * so it lives here and the components read it too. A route's head is written
 * once and used by both.
 *
 * The `.ts` extensions on the imports above are load-bearing, not a style
 * choice: `scripts/prerender.mjs` and `scripts/build-sitemap.mjs` import this
 * module directly under Node's type stripping, and Node's ESM resolver does
 * not add extensions. Keep every relative import in this dependency chain
 * extension-qualified and free of `@/` aliases.
 */
export interface PublicRoute {
  /** Root-relative path, exactly as it appears in the sitemap. */
  path: string;
  /** The route's `<title>`. */
  title: string;
  /** The route's `<meta name="description">`. */
  description: string;
  /** The route's single `<h1>`, as the page renders it. */
  heading: string;
  /** Open Graph object type. Marketing/index pages are websites; posts and
   *  care guides are articles. */
  ogType: 'website' | 'article';
  changefreq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  priority: number;
  /**
   * Source files whose last change is this route's real content change date.
   * `build-sitemap.mjs` reads git for these to date `<lastmod>` instead of
   * guessing "today" or leaving it off.
   */
  sources: string[];
}

/** The canonical URL for a route: absolute, and always on the apex host. */
export function canonicalUrl(path: string): string {
  return siteUrl(path);
}

const registrationOpen = PUBLIC_REGISTRATION_AVAILABLE;

export const STATIC_PUBLIC_ROUTES: PublicRoute[] = [
  {
    path: '/',
    title: 'Family Greenhouse — Shared Plant Care & Watering Reminders',
    description: registrationOpen
      ? 'Share plant watering schedules, reminders, care logs, and tasks with your household. Family Greenhouse is free for up to 10 plants and 6 members.'
      : 'A shared care journal for household plant watering schedules, reminders, tasks, and care logs. Existing account holders can still sign in.',
    // The hero headline is A/B tested, so there is no single rendered h1. The
    // shell serves variant A (the control), read from the same module the hero
    // renders from so the two cannot drift.
    heading: headlineText(HERO_HEADLINES.A),
    ogType: 'website',
    changefreq: 'weekly',
    priority: 1.0,
    sources: ['src/features/landing/LandingPage.tsx', 'src/features/landing/heroHeadlines.ts'],
  },
  {
    path: '/pricing',
    title: registrationOpen
      ? 'Free accounts and plan status — Family Greenhouse'
      : 'Plan status — Family Greenhouse',
    description: registrationOpen
      ? 'Create a free Family Greenhouse account for up to 10 plants. Paid plans, purchases, and plan changes remain paused.'
      : 'Paid plans, purchases, plan changes, and new account registration are paused.',
    heading: registrationOpen ? 'Start with a free account' : 'Paid plans are paused',
    ogType: 'website',
    changefreq: 'monthly',
    priority: 0.9,
    sources: ['src/features/pricing/PricingPage.tsx', 'src/features/pricing/PricingGrid.tsx'],
  },
  {
    path: '/blog',
    title: 'Blog — Family Greenhouse',
    description:
      'Notes on plant care, shared chores, and not letting your fiddle leaf die. From the team building Family Greenhouse.',
    heading: 'Notes on growing things',
    ogType: 'website',
    changefreq: 'weekly',
    priority: 0.8,
    sources: ['src/features/blog/BlogIndex.tsx', 'src/features/blog/posts/meta.ts'],
  },
  {
    path: '/care',
    title: 'Plant Care Guides — How Often to Water Common Houseplants',
    description:
      'Straight, no-nonsense care guides for common houseplants: how often to water, how much light, and why yours might be dying.',
    heading: 'Plant care guides',
    ogType: 'website',
    changefreq: 'weekly',
    priority: 0.8,
    sources: ['src/features/care/CareIndex.tsx', 'src/features/care/careGuides.ts'],
  },
  {
    path: '/pet-safe',
    title: 'Is This Plant Safe for Pets? — Cat & Dog Toxicity Checker',
    description:
      'Free, no-signup checker: type a houseplant name and see whether it’s toxic to cats and dogs, in plain language. Based on the ASPCA’s plant safety data.',
    heading: 'Is this plant safe for pets?',
    ogType: 'website',
    changefreq: 'monthly',
    priority: 0.8,
    sources: ['src/features/petsafe/PetSafePage.tsx'],
  },
  {
    path: '/changelog',
    title: 'Changelog — Family Greenhouse',
    description:
      "What's new in Family Greenhouse, in plain language. Shipped changes, most recent first.",
    heading: 'What’s new',
    ogType: 'website',
    changefreq: 'weekly',
    priority: 0.5,
    sources: ['src/features/changelog/ChangelogPage.tsx'],
  },
  {
    path: '/status',
    title: 'Status — Family Greenhouse',
    description:
      'Current operational status of Family Greenhouse and recent incidents, checked against the live health endpoint.',
    heading: 'System status',
    ogType: 'website',
    changefreq: 'daily',
    priority: 0.3,
    sources: ['src/features/status/StatusPage.tsx'],
  },
  {
    path: '/support',
    title: 'Support — Family Greenhouse',
    description:
      'Get help with your Family Greenhouse account and plant-care workspace: where to email us, how to change or delete an account, and where to check service status.',
    heading: 'Support',
    ogType: 'website',
    changefreq: 'monthly',
    priority: 0.3,
    sources: ['src/features/legal/SupportPage.tsx'],
  },
  {
    path: '/account-deletion',
    title: 'Delete your account — Family Greenhouse',
    description:
      'How to permanently delete a Family Greenhouse account and the data attached to it, from inside the app or without signing in.',
    heading: 'Delete your account',
    ogType: 'website',
    changefreq: 'yearly',
    priority: 0.3,
    sources: ['src/features/legal/AccountDeletionPage.tsx'],
  },
  {
    path: '/legal/privacy',
    title: 'Privacy — Family Greenhouse',
    description:
      'How Family Greenhouse handles your data: what is collected, why, where it is stored, and what you can ask us to delete.',
    heading: 'Privacy',
    ogType: 'website',
    changefreq: 'yearly',
    priority: 0.3,
    sources: ['src/features/legal/PrivacyPage.tsx'],
  },
  {
    path: '/legal/terms',
    title: 'Terms — Family Greenhouse',
    description:
      'The terms of using Family Greenhouse, in plain language: who may use it, what we promise, and how an account ends.',
    heading: 'Terms of Service',
    ogType: 'website',
    changefreq: 'yearly',
    priority: 0.3,
    sources: ['src/features/legal/TermsPage.tsx'],
  },
];

/** Look up a fixed public route by path. Throws rather than returning a
 *  partial head: a route with no entry must not silently fall back to the
 *  shell's homepage title, which is the defect this manifest exists to end. */
export function publicRoute(path: string): PublicRoute {
  const route = STATIC_PUBLIC_ROUTES.find((r) => r.path === path);
  if (!route) throw new Error(`No public route registered for "${path}"`);
  return route;
}
