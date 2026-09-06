import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('@/config/commercialStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/commercialStatus')>()),
  PUBLIC_REGISTRATION_AVAILABLE: false,
}));

vi.mock('@/services/petToxicityService', () => ({
  petToxicityService: { lookup: vi.fn() },
}));

import { PetSafePage } from '@/features/petsafe/PetSafePage';
import { CARE_GUIDES } from '@/features/care/careGuides';

/**
 * `/pet-safe`'s only internal links used to sit inside
 * `PUBLIC_REGISTRATION_AVAILABLE &&`, so with registration closed the highest
 * commercial-intent page on the site shipped to a crawler with no outbound
 * internal links at all — a hub with no spokes. Whether we are taking signups
 * has nothing to do with whether a peace lily is toxic, and this pins that the
 * two are no longer wired together.
 */
describe('PetSafePage with public registration closed', () => {
  function renderPage() {
    return render(
      <MemoryRouter initialEntries={['/pet-safe']}>
        <Routes>
          <Route path="/pet-safe" element={<PetSafePage />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it('still links every care guide, the care index, and both pet-safety posts', () => {
    const { container } = renderPage();

    const hrefs = [...container.querySelectorAll('a[href^="/care/"]')].map((a) =>
      a.getAttribute('href')
    );
    expect(hrefs).toHaveLength(CARE_GUIDES.length);
    // The shell links /care too, so name the page's own link rather than the
    // href — otherwise the assertion passes on the chrome alone.
    expect(screen.getByRole('link', { name: /browse all plant care guides/i })).toHaveAttribute(
      'href',
      '/care'
    );
    expect(
      container.querySelector('a[href="/blog/pet-safe-houseplants-that-are-hard-to-kill"]')
    ).not.toBeNull();
    expect(
      container.querySelector('a[href="/blog/most-common-toxic-houseplants-and-safer-swaps"]')
    ).not.toBeNull();
  });

  it('publishes the same ItemList of species', () => {
    const { container } = renderPage();

    const script = container.ownerDocument.querySelector(
      'script[type="application/ld+json"][data-use-meta-tags]'
    );
    const graph = JSON.parse(script!.textContent!)['@graph'] as { '@type': string }[];
    const list = graph.find((node) => node['@type'] === 'ItemList') as {
      itemListElement: unknown[];
    };
    expect(list.itemListElement).toHaveLength(CARE_GUIDES.length);
  });

  it('does drop the signup call to action, so the gate is genuinely off', () => {
    const { container } = renderPage();
    expect(screen.queryByRole('link', { name: /get started/i })).not.toBeInTheDocument();
    expect(container.querySelector('a[href="/register"]')).toBeNull();
  });
});
