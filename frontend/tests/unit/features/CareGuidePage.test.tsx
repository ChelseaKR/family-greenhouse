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

/**
 * The dates a care guide publishes.
 *
 * `reviewed` (facts last checked) was being emitted as `datePublished` AND
 * `dateModified` AND the sitemap's `<lastmod>`, so an edit that did not
 * re-verify anything left all three behind the content — 80 days behind on
 * six guides after #649 and #651 landed. `updated` is now the modification
 * date, and the page prints both so the claim is one a reader can check.
 */
describe('CareGuidePage content dates', () => {
  const graphOf = (container: HTMLElement) => {
    const script = container.ownerDocument.querySelector('script[type="application/ld+json"]');
    return JSON.parse(script!.textContent!)['@graph'] as Record<string, unknown>[];
  };

  /** A guide whose content changed after it was last reviewed. */
  const DRIFTED = CARE_GUIDES.find((g) => g.updated !== g.reviewed)!;

  it('reports the modification date, not the review date, as dateModified', () => {
    const { container } = renderGuide(DRIFTED.slug);
    const article = graphOf(container).find((n) => n['@type'] === 'Article')!;
    expect(article.dateModified).toBe(DRIFTED.updated);
    expect(article.dateModified).not.toBe(DRIFTED.reviewed);
  });

  it('emits article:modified_time from the same field', () => {
    const { container } = renderGuide(DRIFTED.slug);
    const tag = container.ownerDocument.querySelector('meta[property="article:modified_time"]');
    expect(tag?.getAttribute('content')).toBe(DRIFTED.updated);
  });

  it('shows the reader the dates its markup claims', () => {
    const { container } = renderGuide(DRIFTED.slug);
    const times = [...container.querySelectorAll('time')].map((t) => t.getAttribute('datetime'));
    expect(times).toContain(DRIFTED.reviewed);
    expect(times).toContain(DRIFTED.updated);
  });

  it('prints the day the date literal names, not the day before it', () => {
    // `new Date('2026-09-05').toLocaleDateString()` is UTC midnight rendered
    // in the host's zone, so it prints the 4th anywhere west of UTC — every
    // US reader, and a mismatch between the UTC-built prerender and the same
    // page after hydration. vitest.config.ts pins TZ to America/New_York, so
    // this assertion is live: the naive call fails it.
    const { container } = renderGuide(DRIFTED.slug);
    const [year, , day] = DRIFTED.updated.split('-');
    const rendered = [...container.querySelectorAll('time')].find(
      (t) => t.getAttribute('datetime') === DRIFTED.updated
    )!.textContent!;
    expect(rendered).toMatch(new RegExp(`\\b${Number(day)}, ${year}\\b`));
  });
});
