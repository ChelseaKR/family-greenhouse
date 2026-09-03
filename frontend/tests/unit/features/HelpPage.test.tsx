import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { HelpPage } from '@/features/help/HelpPage';
import { HelpTopicPage } from '@/features/help/HelpTopicPage';
import { HELP_SECTIONS, POPULAR, visibleSections } from '@/features/help/helpContent';

vi.mock('@/lib/platform', () => ({
  isNativeApp: vi.fn(() => false),
  getNativePlatform: vi.fn(() => 'web'),
}));

import { isNativeApp } from '@/lib/platform';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/help" element={<HelpPage />} />
        <Route path="/help/:topicId" element={<HelpTopicPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('help content', () => {
  it('gives every article a plain-text twin, because that text is published as FAQ data', () => {
    // `text` feeds both the search filter and the FAQPage JSON-LD on the topic
    // pages. An empty or stub `text` publishes a blank answer to search engines
    // under a real-looking question.
    for (const section of HELP_SECTIONS) {
      for (const article of section.articles) {
        expect(article.text.trim().length, `${section.id}/${article.id}`).toBeGreaterThan(80);
      }
    }
  });

  it('keeps article ids unique so anchors in support replies stay unambiguous', () => {
    const ids = HELP_SECTIONS.flatMap((s) => s.articles.map((a) => `${s.id}#${a.id}`));
    expect(new Set(ids).size).toBe(ids.length);
    const sectionIds = HELP_SECTIONS.map((s) => s.id);
    expect(new Set(sectionIds).size).toBe(sectionIds.length);
  });

  it('points every "start here" shortcut at an article that exists', () => {
    for (const item of POPULAR) {
      const section = HELP_SECTIONS.find((s) => s.id === item.section);
      expect(section, `unknown section ${item.section}`).toBeDefined();
      expect(
        section!.articles.some((a) => a.id === item.article),
        `unknown article ${item.section}#${item.article}`
      ).toBe(true);
    }
  });

  it('hides the billing topic in native builds, which cannot sell a plan', () => {
    expect(visibleSections(false).some((s) => s.id === 'billing')).toBe(true);
    expect(visibleSections(true).some((s) => s.id === 'billing')).toBe(false);
  });
});

describe('HelpPage', () => {
  it('renders answers into the DOM while collapsed, so find-in-page and crawlers see them', () => {
    renderAt('/help');
    // The cancellation answer must be present without anyone opening anything.
    expect(
      screen.getByText(/only place a live subscription can be changed or cancelled/i)
    ).toBeInTheDocument();
  });

  it('uses real disclosure widgets rather than a JS-only accordion', () => {
    const { container } = renderAt('/help');
    const details = container.querySelectorAll('details');
    expect(details.length).toBeGreaterThan(20);
    // Native <details> is keyboard-operable for free; nothing should be forced
    // open, and more than one may be opened at a time.
    details.forEach((d) => expect(d.open).toBe(false));
  });

  it('filters on answer text, not just on the question wording', async () => {
    const user = userEvent.setup();
    renderAt('/help');
    // "Former member" appears only in answer bodies.
    await user.type(screen.getByLabelText(/search the help pages/i), 'Former member');
    expect(await screen.findByText(/answers? match/i)).toBeInTheDocument();
    expect(screen.getByText(/How do I remove someone from my household\?/i)).toBeInTheDocument();
    expect(screen.queryByText(/Is there a dark mode\?/i)).not.toBeInTheDocument();
  });

  it('offers a way out instead of a blank page when nothing matches', async () => {
    const user = userEvent.setup();
    renderAt('/help');
    await user.type(screen.getByLabelText(/search the help pages/i), 'zzzzqqq');
    const empty = screen.getByText(/Nothing here matches/i);
    expect(empty).toBeInTheDocument();
    // The dead end offers both a way back to browsing and a human to email.
    expect(within(empty).getByRole('button', { name: /full list/i })).toBeInTheDocument();
    expect(
      within(empty).getByRole('link', { name: /support@familygreenhouse\.net/i })
    ).toBeInTheDocument();
  });

  it('drops billing questions from search inside the native shell', async () => {
    vi.mocked(isNativeApp).mockReturnValue(true);
    try {
      const user = userEvent.setup();
      renderAt('/help');
      await user.type(screen.getByLabelText(/search the help pages/i), 'cancel');
      expect(screen.queryByText(/^How do I cancel\?$/)).not.toBeInTheDocument();
    } finally {
      vi.mocked(isNativeApp).mockReturnValue(false);
    }
  });
});

describe('HelpTopicPage', () => {
  it('renders one topic with a heading per question and a stable anchor id', () => {
    const { container } = renderAt('/help/sitters');
    const sitters = HELP_SECTIONS.find((s) => s.id === 'sitters')!;
    for (const article of sitters.articles) {
      const heading = container.querySelector(`h2#${CSS.escape(article.id)}`);
      expect(heading, `missing anchor for ${article.id}`).not.toBeNull();
      expect(heading!.textContent).toBe(article.q);
    }
  });

  it('publishes FAQ structured data whose answers match the rendered ones', () => {
    renderAt('/help/billing');
    const script = document.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const payload = JSON.parse(script!.textContent!);
    expect(payload['@type']).toBe('FAQPage');
    const billing = HELP_SECTIONS.find((s) => s.id === 'billing')!;
    expect(payload.mainEntity).toHaveLength(billing.articles.length);
    const cancel = payload.mainEntity.find((q: { name: string }) => q.name === 'How do I cancel?');
    expect(cancel.acceptedAnswer.text).toContain('Manage subscription');
  });

  it('sends an unknown topic to a signposted dead end rather than a blank page', () => {
    renderAt('/help/not-a-topic');
    expect(screen.getByText(/We don’t have that topic/i)).toBeInTheDocument();
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('link').length).toBe(HELP_SECTIONS.length);
    // A valid-looking URL that resolves to nothing must not be indexed.
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'noindex, nofollow'
    );
  });
});
