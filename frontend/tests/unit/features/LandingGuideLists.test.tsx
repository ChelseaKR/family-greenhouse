import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n, { ensureLanguageCatalog } from '@/i18n';
import { LandingPage } from '@/features/landing/LandingPage';
import { findPost } from '@/features/blog/posts';

/**
 * The ranked and list-style blog posts ("Seven houseplants that survive being
 * forgotten", the pet-safe list, the toxic-plant swaps) were reachable only
 * from /blog. The home page now links them by name. These checks pin that the
 * links exist, that every one resolves to a published post, and that the
 * Spanish page shows Spanish labels.
 */
const EXPECTED_SLUGS = [
  'low-maintenance-houseplants-for-forgetful-people',
  'pet-safe-houseplants-that-are-hard-to-kill',
  'most-common-toxic-houseplants-and-safer-swaps',
  // The two household posts Google has not indexed; see smallTrafficLinks.test.tsx.
  'how-to-remember-to-water-plants',
  'sharing-plant-care-without-becoming-the-nag',
];

function renderLanding(): HTMLElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    </QueryClientProvider>
  ).container;
}

const postLinks = (root: ParentNode) =>
  Array.from(root.querySelectorAll('a')).filter((a) =>
    (a.getAttribute('href') ?? '').startsWith('/blog/')
  );

const slugOf = (a: HTMLAnchorElement) => (a.getAttribute('href') ?? '').slice('/blog/'.length);

/** Hrefs on the page that do not resolve to a published post. */
const unresolved = (root: ParentNode) =>
  postLinks(root)
    .map(slugOf)
    .filter((slug) => findPost(slug) === undefined);

describe('the home page links the list-style guides', () => {
  beforeAll(async () => {
    await ensureLanguageCatalog('es');
  });
  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage('en');
  });

  it('links each list post by name, and every link resolves to a published post', () => {
    const container = renderLanding();
    const links = postLinks(container);
    expect(links.map(slugOf)).toEqual(EXPECTED_SLUGS);
    expect(unresolved(container)).toEqual([]);
    for (const a of links) {
      const label = a.textContent?.trim() ?? '';
      expect(label.length).toBeGreaterThan(20);
      // A raw i18n key would render as text; that must never ship.
      expect(label).not.toMatch(/^landing\./);
    }
  });

  it('the Spanish home page links the same posts, with Spanish labels', async () => {
    await i18n.changeLanguage('es');
    const container = renderLanding();
    const links = postLinks(container);
    expect(links.map(slugOf)).toEqual(EXPECTED_SLUGS);
    const labels = links.map((a) => a.textContent?.trim());
    expect(labels).not.toContain('Seven houseplants that survive being forgotten');
    expect(labels.every((label) => label && !label.startsWith('landing.'))).toBe(true);
  });

  it('negative control: a link to a post that does not exist is reported', () => {
    const container = renderLanding();
    const first = postLinks(container)[0];
    expect(first).toBeDefined();
    first.setAttribute('href', '/blog/no-such-post');
    // The sabotage applied: the href really changed, and the check now flags it.
    expect(first.getAttribute('href')).toBe('/blog/no-such-post');
    expect(unresolved(container)).toEqual(['no-such-post']);
  });
});
