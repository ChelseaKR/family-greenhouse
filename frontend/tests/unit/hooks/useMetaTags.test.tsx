import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMetaTags } from '@/hooks/useMetaTags';

describe('useMetaTags canonical', () => {
  it('creates a canonical link + og:url, and removes the link it created on unmount', () => {
    const { unmount } = renderHook(() =>
      useMetaTags({ title: 'Pothos Care', canonical: 'https://familygreenhouse.net/care/pothos' })
    );

    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      'https://familygreenhouse.net/care/pothos'
    );
    expect(document.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(
      'https://familygreenhouse.net/care/pothos'
    );

    unmount();
    // The link/meta this hook created are cleaned up so the next route doesn't
    // inherit a stale canonical.
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.querySelector('meta[property="og:url"]')).toBeNull();
  });

  it('keeps Open Graph, Twitter, and robots metadata in sync per route', () => {
    const { unmount } = renderHook(() =>
      useMetaTags({
        title: 'A dramatic fern',
        description: 'Fern care without the guesswork.',
        ogImage: 'https://familygreenhouse.net/fern.png',
        ogType: 'article',
        robots: 'noindex, follow',
      })
    );

    expect(document.querySelector('meta[name="twitter:title"]')?.getAttribute('content')).toBe(
      'A dramatic fern'
    );
    expect(
      document.querySelector('meta[name="twitter:description"]')?.getAttribute('content')
    ).toBe('Fern care without the guesswork.');
    expect(document.querySelector('meta[name="twitter:image"]')?.getAttribute('content')).toBe(
      'https://familygreenhouse.net/fern.png'
    );
    expect(document.querySelector('meta[property="og:type"]')?.getAttribute('content')).toBe(
      'article'
    );
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'noindex, follow'
    );

    unmount();
  });

  it('overrides a pre-existing homepage canonical and restores its href on unmount', () => {
    // If a canonical link already exists (e.g. one route navigating to another
    // before cleanup), the hook overrides its href and restores it on unmount
    // rather than removing a link it didn't create.
    const pre = document.createElement('link');
    pre.setAttribute('rel', 'canonical');
    pre.setAttribute('href', 'https://familygreenhouse.net/');
    document.head.appendChild(pre);

    const { unmount } = renderHook(() =>
      useMetaTags({
        canonical: 'https://familygreenhouse.net/blog/how-to-remember-to-water-plants',
      })
    );
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      'https://familygreenhouse.net/blog/how-to-remember-to-water-plants'
    );

    unmount();
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(
      'https://familygreenhouse.net/'
    );
    pre.remove();
  });
});
