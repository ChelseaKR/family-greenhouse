import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { BlogIndex } from '@/features/blog/BlogIndex';
import { BlogPost } from '@/features/blog/BlogPost';
import { POSTS } from '@/features/blog/posts';
import { CareGuidePage } from '@/features/care/CareGuidePage';
import { CareIndex } from '@/features/care/CareIndex';
import { CARE_GUIDE_INDEX } from '@/features/care/careGuideContent';

/**
 * The structured data on the two content hubs, /care and /blog, and the
 * Article author on the pages they list. Search Console (2026-11-15) showed
 * /pet-safe — the one hub that published CollectionPage/ItemList — as the
 * model; /care and /blog published nothing. These pin the new graphs to the
 * visible lists, so the markup cannot name a guide or post the page does not
 * link, or link them in another order.
 */

type Node = Record<string, unknown>;

function graphOf(container: HTMLElement): Node[] {
  const script = container.ownerDocument.querySelector(
    'script[type="application/ld+json"][data-use-meta-tags]'
  );
  expect(script).not.toBeNull();
  return JSON.parse(script!.textContent!)['@graph'] as Node[];
}

function renderAt(path: string, routePath: string, element: ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={routePath} element={element} />
      </Routes>
    </MemoryRouter>
  );
}

/** The hrefs of a list's links, in DOM order, as absolute URLs. */
function listedUrls(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole('link')
    .map((a) => `https://familygreenhouse.net${a.getAttribute('href')}`);
}

const ORGANIZATION = {
  '@type': 'Organization',
  '@id': 'https://familygreenhouse.net/#organization',
  name: 'Family Greenhouse',
  url: 'https://familygreenhouse.net',
};

describe('/care structured data', () => {
  it('publishes a CollectionPage whose ItemList is the visible guide list', () => {
    const { container } = renderAt('/care', '/care', <CareIndex />);
    const graph = graphOf(container);

    const page = graph.find((n) => n['@type'] === 'CollectionPage')!;
    expect(page['@id']).toBe('https://familygreenhouse.net/care');
    expect(page.name).toBe(document.title);

    const list = graph.find((n) => n['@type'] === 'ItemList') as {
      '@id': string;
      numberOfItems: number;
      itemListElement: { position: number; name: string; url: string }[];
    };
    expect(page.mainEntity).toEqual({ '@id': list['@id'] });
    expect(list.numberOfItems).toBe(CARE_GUIDE_INDEX.length);
    expect(list.itemListElement.map((i) => i.position)).toEqual(
      CARE_GUIDE_INDEX.map((_, i) => i + 1)
    );
    expect(list.itemListElement.map((i) => i.name)).toEqual(
      CARE_GUIDE_INDEX.map((g) => g.commonName)
    );

    // The guide grid is the first <ul> outside the short "Holiday plants" list
    // that sits above it (HolidayCareGuides, which repeats six of the guides).
    const grid = screen
      .getAllByRole('list')
      .find((ul) => !ul.closest('[aria-labelledby="care-index-holiday"]'))!;
    expect(list.itemListElement.map((i) => i.url)).toEqual(listedUrls(grid));
  });

  it('names itself in its breadcrumb the way every guide breadcrumb does', () => {
    const { container } = renderAt('/care', '/care', <CareIndex />);
    const crumbs = graphOf(container).find((n) => n['@type'] === 'BreadcrumbList')!;
    expect(crumbs.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://familygreenhouse.net/' },
      { '@type': 'ListItem', position: 2, name: 'Plant care' },
    ]);
  });
});

describe('/blog structured data', () => {
  it('publishes a CollectionPage whose ItemList is the visible post list, newest first', () => {
    const { container } = renderAt('/blog', '/blog', <BlogIndex />);
    const graph = graphOf(container);

    const page = graph.find((n) => n['@type'] === 'CollectionPage')!;
    expect(page['@id']).toBe('https://familygreenhouse.net/blog');
    expect(page.name).toBe(document.title);

    const list = graph.find((n) => n['@type'] === 'ItemList') as {
      '@id': string;
      numberOfItems: number;
      itemListElement: { position: number; name: string; url: string }[];
    };
    expect(page.mainEntity).toEqual({ '@id': list['@id'] });
    expect(list.numberOfItems).toBe(POSTS.length);
    expect(list.itemListElement.map((i) => i.url)).toEqual(
      listedUrls(screen.getAllByRole('list')[0]!)
    );
    const titles = new Map(POSTS.map((p) => [`https://familygreenhouse.net/blog/${p.slug}`, p]));
    for (const item of list.itemListElement) {
      expect(item.name).toBe(titles.get(item.url)!.title);
    }
    const dates = list.itemListElement.map((i) => titles.get(i.url)!.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('publishes the breadcrumb every post already points at', () => {
    const { container } = renderAt('/blog', '/blog', <BlogIndex />);
    const crumbs = graphOf(container).find((n) => n['@type'] === 'BreadcrumbList')!;
    expect(crumbs.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://familygreenhouse.net/' },
      { '@type': 'ListItem', position: 2, name: 'Blog' },
    ]);
  });
});

describe('Article author', () => {
  it('is the site Organization, with an id and url, on a care guide', () => {
    const { container } = renderAt('/care/pothos', '/care/:slug', <CareGuidePage />);
    const article = graphOf(container).find((n) => n['@type'] === 'Article')!;
    expect(article.author).toEqual(ORGANIZATION);
    expect((article.publisher as Node)['@id']).toBe(ORGANIZATION['@id']);
  });

  it('is the site Organization, with an id and url, on a blog post', () => {
    const slug = POSTS[0]!.slug;
    const { container } = renderAt(`/blog/${slug}`, '/blog/:slug', <BlogPost />);
    const article = graphOf(container).find((n) => n['@type'] === 'Article')!;
    expect(article.author).toEqual(ORGANIZATION);
    expect((article.publisher as Node)['@id']).toBe(ORGANIZATION['@id']);
  });
});
