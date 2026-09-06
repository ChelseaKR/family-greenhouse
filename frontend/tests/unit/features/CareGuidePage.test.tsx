import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { CareGuidePage } from '@/features/care/CareGuidePage';
import { CARE_GUIDES } from '@/features/care/careGuides';

/**
 * The template's inline-link handling. `careGuides.ts` prose is `string`
 * rendered straight into JSX, so a path written in the copy used to reach the
 * reader as literal characters — "the free pet-safe checker at /pet-safe" with
 * nothing clickable. These cases pin the two halves of the fix: an anchor in
 * the DOM, and the same sentence WITHOUT the markup in the JSON-LD.
 */
function renderGuide(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/care/${slug}`]}>
      <Routes>
        <Route path="/care/:slug" element={<CareGuidePage />} />
      </Routes>
    </MemoryRouter>
  );
}

/** A guide whose copy links the checker. */
const LINKED = CARE_GUIDES.find((g) =>
  [...g.sections.problems, ...g.faqs.map((f) => f.a)].some((t) => t.includes('](/pet-safe)'))
)!;

describe('CareGuidePage inline links', () => {
  it('renders a real anchor for a path written in the prose', () => {
    renderGuide(LINKED.slug);
    const link = screen.getAllByRole('link', { name: /free pet-safe (checker|tool)/i })[0]!;
    expect(link).toHaveAttribute('href', '/pet-safe');
  });

  it('never renders the link markup as visible text', () => {
    const { container } = renderGuide(LINKED.slug);
    expect(container.textContent).not.toContain('](/pet-safe)');
    // The bare path is what readers saw before withLinks existed.
    expect(container.textContent).not.toMatch(/\sat \/pet-safe/);
  });

  it('publishes the FAQ answer to search engines without the markup', () => {
    const { container } = renderGuide(LINKED.slug);
    const script = container.ownerDocument.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const graph = JSON.parse(script!.textContent!)['@graph'] as {
      '@type': string;
      mainEntity?: { acceptedAnswer: { text: string } }[];
    }[];
    const faq = graph.find((node) => node['@type'] === 'FAQPage')!;
    for (const question of faq.mainEntity!) {
      expect(question.acceptedAnswer.text).not.toContain('](');
      expect(question.acceptedAnswer.text).not.toContain('[free pet-safe');
    }
    // The prose survives, only the syntax is stripped.
    const answers = faq.mainEntity!.map((q) => q.acceptedAnswer.text).join(' ');
    expect(answers).toMatch(/free pet-safe (checker|tool)/i);
  });
});
