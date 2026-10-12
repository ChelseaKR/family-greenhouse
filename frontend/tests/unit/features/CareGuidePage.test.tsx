import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { CareGuidePage } from '@/features/care/CareGuidePage';
import { CARE_GUIDES } from '@/features/care/careGuides';
import { PET_TOXICITY } from '../../../../backend/src/models/petToxicity';

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
  Object.values(g.sections)
    .flat()
    .some((t) => t.includes('](/pet-safe)'))
)!;

/** A guide with link markup inside a FAQ answer, which FAQPage also publishes. */
const LINKED_FAQ = CARE_GUIDES.find((g) => g.faqs.some((f) => f.a.includes('](/')))!;

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
    const { container } = renderGuide(LINKED_FAQ.slug);
    const script = container.ownerDocument.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const graph = JSON.parse(script!.textContent!)['@graph'] as {
      '@type': string;
      mainEntity?: { acceptedAnswer: { text: string } }[];
    }[];
    const faq = graph.find((node) => node['@type'] === 'FAQPage')!;
    for (const question of faq.mainEntity!) {
      expect(question.acceptedAnswer.text).not.toContain('](');
      expect(question.acceptedAnswer.text).not.toMatch(/\[[^\]]+\]/);
    }
    // The prose survives, only the syntax is stripped.
    const linked = LINKED_FAQ.faqs.find((f) => f.a.includes('](/'))!;
    const anchor = /\[([^\]]+)\]/.exec(linked.a)![1]!;
    const answers = faq.mainEntity!.map((q) => q.acceptedAnswer.text).join(' ');
    expect(answers).toContain(anchor);
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

/**
 * The pet answer on the page and in its structured data. It comes only from
 * the cited table (careToxicity.ts): a verdict with its ASPCA listing linked
 * beside it, or "Unknown". FAQPage carries the pet question only when it is
 * cited for every animal.
 */
describe('CareGuidePage pet toxicity', () => {
  type Graph = {
    '@type': string;
    mainEntity?: { name: string; acceptedAnswer: { text: string } }[];
  }[];
  const faqNames = (container: HTMLElement) => {
    const script = container.ownerDocument.querySelector('script[type="application/ld+json"]');
    const graph = JSON.parse(script!.textContent!)['@graph'] as Graph;
    return graph.find((n) => n['@type'] === 'FAQPage')!.mainEntity!;
  };
  const section = (container: HTMLElement) =>
    container.querySelector('[data-testid="care-toxicity"]') as HTMLElement;

  it('prints a cited verdict with its ASPCA listing, and marks it up', () => {
    const { container } = renderGuide('pothos');
    const cats = section(container).querySelector('[data-claim="cats"]')!;
    expect(cats.getAttribute('data-state')).toBe('toxic');
    expect(cats.textContent).toMatch(/^Toxic\./);
    expect(section(container).querySelector('[data-testid="toxicity-caution"]')).toBeNull();
    const source = cats.querySelector('a')!;
    expect(source.getAttribute('href')).toBe(
      'https://www.aspca.org/pet-care/animal-poison-control/toxic-and-non-toxic-plants/golden-pothos'
    );
    expect(source.textContent).toBe('ASPCA, Golden Pothos (Epipremnum aureum)');
    expect(screen.getByRole('link', { name: /pothos pet-safety page/i }).getAttribute('href')).toBe(
      '/pet-safe/pothos'
    );

    const question = faqNames(container).find((q) => /toxic to cats and dogs/.test(q.name))!;
    expect(question.name).toBe('Is a pothos toxic to cats and dogs?');
    expect(question.acceptedAnswer.text).toMatch(/^Yes\. The ASPCA lists Golden Pothos/);
  });

  it('says "Unknown" for a plant with no listing, and keeps it out of the markup', () => {
    const { container } = renderGuide('zz-plant');
    for (const animal of ['cats', 'dogs']) {
      const line = section(container).querySelector(`[data-claim="${animal}"]`)!;
      expect(line.getAttribute('data-state')).toBe('not-assessed');
      expect(line.textContent).toMatch(/^Unknown\./);
      expect(line.querySelector('a')).toBeNull();
    }
    // Shown to the reader...
    expect(screen.getByText('Is a ZZ plant toxic to cats and dogs?')).toBeInTheDocument();
    // ...but not published as structured data, because nothing cites it.
    expect(faqNames(container).map((q) => q.name)).not.toContain(
      'Is a ZZ plant toxic to cats and dogs?'
    );
    expect(section(container).textContent).not.toMatch(/non-toxic|pet-safe|\bsafe\b to/i);
    // The plain caution, with a dialable poison-control link.
    const caution = section(container).querySelector('[data-testid="toxicity-caution"]')!;
    expect(caution.textContent).toMatch(
      /^ZZ plant isn’t on the ASPCA’s list, so we can’t give a verdict\. Keep it out of reach of pets, and if a pet eats some, call your vet or the ASPCA Animal Poison Control Center \(888-426-4435\)\./
    );
    expect(caution.querySelector('a')!.getAttribute('href')).toBe('tel:+18884264435');
  });

  it('never states a verdict for people', () => {
    const { container } = renderGuide('dieffenbachia');
    const people = section(container).querySelector('[data-claim="people"]')!;
    expect(people.getAttribute('data-state')).toBe('not-assessed');
    expect(people.textContent).toMatch(/^Not covered by our source\./);
    expect(people.querySelector('a')!.getAttribute('href')).toBe('tel:+18002221222');
  });

  it('negative control: removing a listing turns the page to "Unknown" and drops the markup', () => {
    const entry = PET_TOXICITY.find((e) => e.slug === 'pothos')!;
    const saved = entry.aspcaListing;
    try {
      entry.aspcaListing = undefined;
      // Prove the sabotage landed before reading anything off the page.
      expect(PET_TOXICITY.find((e) => e.slug === 'pothos')!.aspcaListing).toBeUndefined();
      const { container } = renderGuide('pothos');
      const cats = section(container).querySelector('[data-claim="cats"]')!;
      expect(cats.getAttribute('data-state')).toBe('not-assessed');
      expect(cats.textContent).toMatch(/^Unknown\./);
      expect(
        section(container).querySelector('[data-testid="toxicity-caution"]')!.textContent
      ).toMatch(/^Pothos isn’t on the ASPCA’s list/);
      // The hand-written quick fact still says "Toxic", but the page must not
      // promote it to a cited verdict or into the structured data.
      expect(faqNames(container).map((q) => q.name)).not.toContain(
        'Is a pothos toxic to cats and dogs?'
      );
      expect(screen.queryByRole('link', { name: /pet-safety page/i })).toBeNull();
    } finally {
      entry.aspcaListing = saved;
    }
    expect(PET_TOXICITY.find((e) => e.slug === 'pothos')!.aspcaListing).toBeDefined();
  });

  it('marks up every FAQ it shows except an unsourced pet answer, and nothing else', () => {
    for (const guide of CARE_GUIDES) {
      const { container, unmount } = renderGuide(guide.slug);
      const shown = [...container.querySelectorAll('article dl dt')]
        .map((dt) => dt.textContent!)
        .filter((t) => t.endsWith('?'));
      const marked = faqNames(container).map((q) => q.name);
      for (const name of marked) expect(shown, `${guide.slug}: ${name}`).toContain(name);
      const petQuestion = shown.find((t) => /toxic to cats and dogs\?$/.test(t))!;
      expect(petQuestion, guide.slug).toBeDefined();
      expect(marked.includes(petQuestion), guide.slug).toBe(guide.slug !== 'zz-plant');
      unmount();
    }
  });
});

describe('CareGuidePage structure', () => {
  it('answers propagation, humidity and related plants on every guide', () => {
    for (const guide of CARE_GUIDES) {
      const { container, unmount } = renderGuide(guide.slug);
      const headings = [...container.querySelectorAll('h2')].map((h) => h.textContent!);
      expect(
        headings.some((h) => h.startsWith('How to propagate')),
        guide.slug
      ).toBe(true);
      expect(headings, guide.slug).toContain('Light and humidity');
      expect(headings, guide.slug).toContain('Related plants');
      const related = [...container.querySelectorAll('section a[href^="/care/"]')].map((a) =>
        a.getAttribute('href')
      );
      expect(related, guide.slug).toEqual(guide.related.map((s) => `/care/${s}`));
      expect(
        container.ownerDocument.querySelector('link[rel="canonical"]')?.getAttribute('href'),
        guide.slug
      ).toBe(`https://familygreenhouse.net/care/${guide.slug}`);
      unmount();
    }
  });
});
