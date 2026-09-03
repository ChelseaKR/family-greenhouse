import { useContext, useEffect } from 'react';
import { MetaSinkContext } from './metaSink';
import type { MetaTags } from '@/config/seo';

/**
 * Mutate <head> meta tags imperatively for the lifetime of a route. Cleans
 * up on unmount so leaving an article doesn't leak that article's
 * description onto the next page.
 *
 * Why imperative DOM rather than a Helmet-style abstraction: this runs for the
 * in-tab experience (browser title, a link shared by a logged-in user). The
 * tags a crawler or a social unfurler sees are produced at BUILD time instead —
 * `scripts/prerender.mjs` renders each public route and writes the same tags as
 * literal HTML, from the same `MetaTags` payload, via `config/seo.ts`. The two
 * paths share that module so they can't disagree.
 */
export type { MetaTags } from '@/config/seo';

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

/** Set (or create) a <link rel="canonical">, restoring the prior href on
 *  cleanup so leaving the route doesn't leak its canonical onto the next. */
function setCanonical(href: string): () => void {
  const existing = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (existing) {
    const previous = existing.getAttribute('href');
    existing.setAttribute('href', href);
    return () => {
      // An href-less <link rel="canonical"> is worse than no tag at all: it
      // is the "empty canonical" a crawler reads as "this page canonicalizes
      // to nothing". Restoring an absent href by dropping the whole element
      // leaves the safe state (no canonical → Google uses the request URL).
      if (previous === null) existing.remove();
      else existing.setAttribute('href', previous);
    };
  }
  const tag = document.createElement('link');
  tag.setAttribute('rel', 'canonical');
  tag.setAttribute('href', href);
  document.head.appendChild(tag);
  return () => tag.remove();
}

export function useMetaTags(meta: MetaTags): void {
  // Prerender capture. Effects don't run during server rendering, so the
  // build-time prerender reads the route's head data out of this sink during
  // render instead. `MetaSinkContext` has no provider in the browser, so
  // `sink` is always null there and this line does nothing at runtime.
  const sink = useContext(MetaSinkContext);
  if (sink) sink.current = meta;

  // Callers construct `jsonLd` fresh each render, so a referential dep would
  // rebuild every head tag on every render (title/JSON-LD flicker). Depend on
  // a stable serialization instead.
  const jsonLdKey = meta.jsonLd ? JSON.stringify(meta.jsonLd) : undefined;
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
      cleanups.push(setMeta('twitter:description', meta.description));
    }
    if (meta.title) {
      cleanups.push(setMeta('og:title', meta.title, 'property'));
      cleanups.push(setMeta('twitter:title', meta.title));
    }
    if (meta.ogImage) {
      cleanups.push(setMeta('og:image', meta.ogImage, 'property'));
      cleanups.push(setMeta('twitter:image', meta.ogImage));
    }
    if (meta.ogType) {
      cleanups.push(setMeta('og:type', meta.ogType, 'property'));
    }
    if (meta.robots) {
      cleanups.push(setMeta('robots', meta.robots));
    }
    if (meta.canonical) {
      cleanups.push(setCanonical(meta.canonical));
      cleanups.push(setMeta('og:url', meta.canonical, 'property'));
    }
    if (jsonLdKey) {
      // JSON-LD goes in a dedicated <script type="application/ld+json">.
      // We tag it with a data attribute we own so we can clean up on
      // unmount without disturbing any future structured-data scripts
      // that might be added by other surfaces.
      const script = document.createElement('script');
      script.type = 'application/ld+json';
      script.dataset.useMetaTags = '1';
      script.textContent = jsonLdKey;
      document.head.appendChild(script);
      cleanups.push(() => script.remove());
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [
    meta.title,
    meta.description,
    meta.ogImage,
    meta.ogType,
    meta.canonical,
    meta.robots,
    jsonLdKey,
  ]);
}
