import { useEffect } from 'react';

/**
 * Mutate <head> meta tags imperatively for the lifetime of a route. Cleans
 * up on unmount so leaving an article doesn't leak that article's
 * description onto the next page.
 *
 * Why imperative DOM rather than a Helmet-style abstraction: the SPA
 * doesn't pre-render, so the OG/Twitter scrapers see the index HTML
 * regardless. These tags are for the in-tab experience (browser title,
 * shared link previews from a logged-in user, etc.). For real social
 * preview of blog posts, we need server-rendered or build-time meta —
 * tracked separately.
 */
export interface MetaTags {
  title?: string;
  description?: string;
  /** Path under /og-cards/ for a per-post OG image, if shipped. */
  ogImage?: string;
  /** Optional JSON-LD payload (Article, FAQ, etc.). The shape isn't
   *  validated here — caller is responsible for emitting valid schema.org. */
  jsonLd?: Record<string, unknown>;
}

function setMeta(name: string, content: string, attr: 'name' | 'property' = 'name'): () => void {
  const selector = `meta[${attr}="${name}"]`;
  const existing = document.querySelector<HTMLMetaElement>(selector);
  if (existing) {
    const previous = existing.getAttribute('content') ?? '';
    existing.setAttribute('content', content);
    return () => existing.setAttribute('content', previous);
  }
  const tag = document.createElement('meta');
  tag.setAttribute(attr, name);
  tag.setAttribute('content', content);
  document.head.appendChild(tag);
  return () => tag.remove();
}

export function useMetaTags(meta: MetaTags): void {
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    if (meta.title) {
      const previousTitle = document.title;
      document.title = meta.title;
      cleanups.push(() => {
        document.title = previousTitle;
      });
    }
    if (meta.description) {
      cleanups.push(setMeta('description', meta.description));
      cleanups.push(setMeta('og:description', meta.description, 'property'));
    }
    if (meta.title) {
      cleanups.push(setMeta('og:title', meta.title, 'property'));
    }
    if (meta.ogImage) {
      cleanups.push(setMeta('og:image', meta.ogImage, 'property'));
    }
    if (meta.jsonLd) {
      // JSON-LD goes in a dedicated <script type="application/ld+json">.
      // We tag it with a data attribute we own so we can clean up on
      // unmount without disturbing any future structured-data scripts
      // that might be added by other surfaces.
      const script = document.createElement('script');
      script.type = 'application/ld+json';
      script.dataset.useMetaTags = '1';
      script.textContent = JSON.stringify(meta.jsonLd);
      document.head.appendChild(script);
      cleanups.push(() => script.remove());
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [meta.title, meta.description, meta.ogImage, meta.jsonLd]);
}
