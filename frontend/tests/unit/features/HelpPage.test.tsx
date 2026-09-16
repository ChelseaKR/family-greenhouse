import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { HelpPage } from '@/features/help/HelpPage';
import { HelpTopicPage } from '@/features/help/HelpTopicPage';
import { HELP_SECTIONS, POPULAR, visibleSections } from '@/features/help/helpContent';
import {
  SITTER_LINK_MAX_DAYS_CEILING,
  sitterLinkLimitsFor,
} from '@/features/household/sitterPlanLimits';

/** The published plain-text answer for one article, by section and id. */
function articleText(sectionId: string, articleId: string): string {
  const article = HELP_SECTIONS.find((s) => s.id === sectionId)?.articles.find(
    (a) => a.id === articleId
  );
  if (!article) throw new Error(`no help article ${sectionId}#${articleId}`);
  return article.text;
}

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

  // The plan facts in these answers are also published as FAQPage JSON-LD, so
  // a stale number here is a wrong answer served to search engines as well as
  // to the person who came looking for it. Both articles below had drifted
  // from the catalog: `household-full` named caps of 6/6/50 and sent the
  // reader to Greenhouse, and the sitter articles named a 60-day ceiling that
  // has never existed in `sitterPlanLimits`.

  it('answers "the household is full" with the caps the catalog actually enforces', () => {
    const article = articleText('households', 'household-full');

    // backend/src/models/plans.ts: seedling members 3, garden and greenhouse
    // UNLIMITED. The retired numbers must not come back.
    expect(article).toMatch(/three people/i);
    expect(article).not.toMatch(/\b6 on (Seedling|Garden)\b/i);
    expect(article).not.toMatch(/\b50 on Greenhouse\b/i);
    expect(article).toMatch(/no member limit/i);

    // Garden is where the member cap is lifted, and it is the cheaper tier.
    // Naming Greenhouse instead bills the reader twice over for nothing.
    expect(article).toMatch(/move to Garden/i);
    expect(article).not.toMatch(/move to Greenhouse/i);

    // The free cap here must agree with the one the billing topic states.
    expect(articleText('billing', 'whats-free')).toMatch(/up to 3 members/i);
  });

  // Not a stale number this time, but a privacy assurance a household acts on,
  // and it has now been rewritten twice in opposite directions — so read the
  // history before changing it again.
  //
  // #609 found this answer telling every household flatly that a sitter sees
  // no "plant or task notes, photos", while the Away Kit brief was in fact
  // handing over the photo and, through `resolveCareNote`, the plant's
  // free-text notes whenever no care rule was written. The fix then was to
  // make the help page disclose the notes, and this test was written to hold
  // it there.
  //
  // #709 settled it the other way, and settled it in code: the privacy policy
  // had always promised that a sitter link does not expose plant private
  // notes, and a published promise outranks a fallback, so the fallback was
  // removed rather than the sentence. The brief now carries the house rule
  // (`careRule`) and nothing else, and a plant without one reads as having no
  // note. So the assertions below are inverted ON PURPOSE: what this test used
  // to require the page to admit, it now requires the page to deny, because
  // the behaviour underneath it changed. The photo half is untouched — a
  // sitter on Garden or Greenhouse does still see it.
  it('says the Away Kit brief shows the house rule and the photo, and NOT the plant’s notes', () => {
    const article = articleText('sitters', 'sitter-sees');

    // The absolutes retired by #609 stay retired: the brief does show photos,
    // and it lists every plant in active care, not only the ones with a task
    // due.
    expect(article).not.toMatch(/plant or task notes, photos/i);
    expect(article).not.toMatch(/cannot even see plants that have nothing due/i);

    // Task notes are private on both surfaces — a brief task carries only
    // taskId, type, due date and overdue — and since #709 plant notes are too.
    expect(article).toMatch(/task notes/i);
    expect(article).toMatch(/plant notes/i);

    // What the brief adds, and which plans add it.
    expect(article).toMatch(/Garden and Greenhouse/);
    expect(article).toMatch(/latest photo/i);
    expect(article).toMatch(/house rule/i);

    // The claim that must not come back: the notes fallback, in either the
    // page's words or the ones #609 put here.
    expect(article).not.toMatch(/plant notes and plant photos/i);
    expect(article).not.toMatch(/the plant.s own notes,? word for word/i);

    // Rule 2 of helpContent.tsx: `text` is a plain-text twin of `a`. A twin
    // that kept the old disclosure would publish it as FAQPage JSON-LD under a
    // corrected on-page answer, which is the worse half to get wrong.
    const rendered = renderAt('/help/sitters').container.textContent ?? '';
    expect(rendered).toMatch(/Garden and Greenhouse/);
    expect(rendered).toMatch(/latest photo/i);
    expect(rendered).toMatch(/house rule/i);
    expect(rendered).not.toMatch(/plant notes and plant photos/i);
  });

  it('does not promise a sitter cannot send photos, which the Away Kit lets them do', () => {
    // POST /sitter/:token/photos (backend/src/handlers/tasks/sitterPhotos.ts)
    // is admitted on any plan with the Away Kit, and SitterPhotoBack renders
    // the control for it on the sitter's own page.
    const article = articleText('sitters', 'sitter-can-do');
    expect(article).not.toMatch(/upload photos/i);
    expect(article).toMatch(/send you a photo/i);
    expect(article).toMatch(/Garden and Greenhouse/);
  });

  it('names only sitter-link windows that a plan actually allows', () => {
    // Derived from the client's own mirror of the catalog rather than
    // restated, so a future change to the caps fails here instead of leaving
    // the help pages quietly wrong again.
    const planDays = (['seedling', 'garden', 'greenhouse'] as const).map(
      (id) => sitterLinkLimitsFor(id)!.maxDays
    );
    expect(planDays).toContain(SITTER_LINK_MAX_DAYS_CEILING);
    // 14 is the create form's suggested default (SitterLinksCard.tsx).
    const allowed = new Set([...planDays, 14]);

    const sitters = HELP_SECTIONS.find((s) => s.id === 'sitters')!;
    for (const article of sitters.articles) {
      for (const [, n] of article.text.matchAll(/\b(\d+)\s+days?\b/g)) {
        expect(allowed, `${article.id} names a ${n}-day window no plan grants`).toContain(
          Number(n)
        );
      }
    }
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
    // The payload is a @graph now that the page also emits a BreadcrumbList,
    // so the FAQPage is a node inside it rather than the root.
    const graph = payload['@graph'] as { '@type': string; mainEntity?: unknown[] }[];
    const faq = graph.find((node) => node['@type'] === 'FAQPage')!;
    expect(faq).toBeDefined();
    const billing = HELP_SECTIONS.find((s) => s.id === 'billing')!;
    expect(faq.mainEntity).toHaveLength(billing.articles.length);
    const cancel = (faq.mainEntity as { name: string; acceptedAnswer: { text: string } }[]).find(
      (q) => q.name === 'How do I cancel?'
    )!;
    expect(cancel.acceptedAnswer.text).toContain('Manage subscription');
  });

  it('publishes a breadcrumb trail for the topic page', () => {
    renderAt('/help/billing');
    const payload = JSON.parse(
      document.querySelector('script[type="application/ld+json"]')!.textContent!
    );
    const crumbs = (payload['@graph'] as { '@type': string; itemListElement?: unknown[] }[]).find(
      (node) => node['@type'] === 'BreadcrumbList'
    )!;
    expect(crumbs).toBeDefined();
    const names = (crumbs.itemListElement as { name: string; position: number }[]).map(
      (c) => c.name
    );
    const billing = HELP_SECTIONS.find((s) => s.id === 'billing')!;
    expect(names).toEqual(['Home', 'Help', billing.title]);
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

/**
 * FAQPage content parity, across every topic rather than the one substring
 * check above.
 *
 * `helpContent.tsx` states its own rule 2: `text` is a plain-text RENDERING
 * of `a` that must "SAY THE SAME THING" — a hand-maintained paraphrase, not
 * a literal transcript (`a`'s "optionally add a photo and a space
 * (“kitchen window”)" is `text`'s "optionally add a photo and a space such
 * as kitchen window"). A byte-for-byte DOM-vs-schema assertion would be
 * false to that design and would fail on every legitimate rewording, so
 * this checks the two things that are supposed to hold exactly:
 *
 *  - the schema publishes precisely the `text` field the article declares —
 *    guards the plumbing in HelpTopicPage.tsx between the source and the
 *    published `acceptedAnswer`, for every article in every visible topic,
 *    not just the one question HelpTopicPage.test.tsx samples;
 *  - `a` and `text` never disagree on a NUMBER — a dollar price, a day
 *    window, a member/plant cap. Wording may legitimately differ; the facts
 *    a reader (or a search engine) takes away must not. This is exactly the
 *    #643/#609 bug class this file's other tests were written to hold shut,
 *    generalised to every article instead of the two it names.
 */
describe('help FAQPage schema, across every topic', () => {
  it('publishes exactly the declared `text` for every article in every visible topic', () => {
    for (const section of visibleSections(false)) {
      const { unmount } = renderAt(`/help/${section.id}`);
      // `useMetaTags` appends its script to `document.head` and only removes
      // it on unmount — a render left mounted from a prior iteration would
      // leave its script in the DOM too, and `querySelector` returns
      // whichever one comes first, not this iteration's.
      const script = document.head.querySelector('script[type="application/ld+json"]');
      expect(script, section.id).not.toBeNull();
      const graph = JSON.parse(script!.textContent!)['@graph'] as {
        '@type': string;
        mainEntity?: { name: string; acceptedAnswer: { text: string } }[];
      }[];
      const faq = graph.find((node) => node['@type'] === 'FAQPage')!;
      expect(faq.mainEntity, section.id).toHaveLength(section.articles.length);
      for (const article of section.articles) {
        const question = faq.mainEntity!.find((q) => q.name === article.q);
        expect(question, `${section.id}/${article.id}`).toBeDefined();
        expect(question!.acceptedAnswer.text, `${section.id}/${article.id}`).toBe(article.text);
      }
      unmount();
    }
  });

  it('never lets a number drift between the rendered answer and its FAQ twin', () => {
    // Trailing punctuation trimmed: prose commas ("10, and the fourth
    // costs...") are not part of the number, unlike an internal one
    // ("1,000"), and `text`'s plainer prose doesn't always repeat them.
    const numbers = (s: string) => [...s.matchAll(/\d[\d,.]*\d|\d/g)].map((m) => m[0]).sort();

    for (const section of visibleSections(false)) {
      const { container, unmount } = renderAt(`/help/${section.id}`);
      for (const article of section.articles) {
        const heading = container.querySelector(`#${CSS.escape(article.id)}`);
        expect(heading, `${section.id}/${article.id}`).not.toBeNull();
        // The answer is the heading's next sibling (see HelpTopicPage.tsx),
        // not the whole <article> — the <article> also contains the
        // heading's own text, which is redundant here and, for a question
        // that itself contains a number ("14-day trial?"), would double it.
        const answerNode = heading!.nextElementSibling as HTMLElement | null;
        expect(answerNode, `${section.id}/${article.id}`).not.toBeNull();
        expect(numbers(answerNode!.textContent ?? ''), `${section.id}/${article.id}`).toEqual(
          numbers(article.text)
        );
      }
      unmount();
    }
  });
});
