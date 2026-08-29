import { SITE_URL, siteUrl } from './site.ts';
import { PUBLIC_REGISTRATION_AVAILABLE } from './commercialStatus.ts';
import type { CareGuide } from '../features/care/careGuides.ts';
import { postMetaDescription, type BlogPostMeta } from '../features/blog/posts/meta.ts';

/**
 * schema.org payloads for the indexable routes.
 *
 * These graphs used to be built inline inside the page components, which meant
 * they only existed after hydration — the served HTML carried no structured
 * data at all on any of the 25 sitemap URLs. Building them here lets
 * `scripts/prerender.mjs` bake the same graph into each route's shell while
 * `useMetaTags` still emits it in-tab, from one definition.
 *
 * Keep the imports above extension-qualified and alias-free: this module is
 * imported by plain Node build scripts as well as by the app.
 */
export type JsonLd = Record<string, unknown>;

const ORGANIZATION_ID = `${SITE_URL}/#organization`;

const publisher = {
  '@type': 'Organization',
  name: 'Family Greenhouse',
  logo: {
    '@type': 'ImageObject',
    url: siteUrl('/brand/icon-512.png'),
  },
};

/** Organization + WebSite + SoftwareApplication for the landing page. */
export function landingJsonLd(): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': ORGANIZATION_ID,
        name: 'Family Greenhouse',
        url: SITE_URL,
        logo: siteUrl('/brand/icon-512.png'),
      },
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        name: 'Family Greenhouse',
        url: SITE_URL,
        publisher: { '@id': ORGANIZATION_ID },
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
                description: 'Free for up to 10 plants and 6 household members',
              },
            }
          : {}),
        publisher: { '@id': ORGANIZATION_ID },
      },
    ],
  };
}

/**
 * Article + BreadcrumbList for a blog post. Article schema makes the post
 * eligible for Google's article rich-results treatment. We don't have author
 * photos or a publisher logo URL set up yet — those are nice-to-haves that
 * strengthen eligibility but aren't required.
 */
export function blogPostJsonLd(post: BlogPostMeta): JsonLd {
  const url = siteUrl(`/blog/${post.slug}`);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: post.title,
        description: postMetaDescription(post),
        datePublished: post.date,
        dateModified: post.date,
        author: { '@type': 'Organization', name: 'Family Greenhouse' },
        publisher,
        mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: 'Blog', item: siteUrl('/blog') },
          { '@type': 'ListItem', position: 3, name: post.title },
        ],
      },
    ],
  };
}

/**
 * Article + FAQPage + BreadcrumbList for a species care guide. The FAQ markup
 * is the highest-ROI schema for these queries because "how often to water X"
 * is a voice/quick-answer pattern.
 */
export function careGuideJsonLd(guide: CareGuide): JsonLd {
  const url = siteUrl(`/care/${guide.slug}`);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: `${guide.commonName} Care Guide`,
        description: guide.metaDescription,
        datePublished: guide.reviewed,
        dateModified: guide.reviewed,
        author: { '@type': 'Organization', name: 'Family Greenhouse' },
        publisher,
        mainEntityOfPage: { '@type': 'WebPage', '@id': url },
        about: {
          '@type': 'Thing',
          name: guide.commonName,
          alternateName: [guide.scientificName, ...guide.alsoKnownAs],
        },
      },
      {
        '@type': 'FAQPage',
        mainEntity: guide.faqs.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: 'Plant care', item: siteUrl('/care') },
          { '@type': 'ListItem', position: 3, name: `${guide.commonName} care` },
        ],
      },
    ],
  };
}
