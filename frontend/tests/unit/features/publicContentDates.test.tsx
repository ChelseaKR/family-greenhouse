import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { BlogIndex } from '@/features/blog/BlogIndex';
import { BlogPost } from '@/features/blog/BlogPost';
import { POSTS } from '@/features/blog/posts';
import { ChangelogPage } from '@/features/changelog/ChangelogPage';
import { groupByMonth } from '@/features/changelog/groupByMonth';

/**
 * The visible date on a public page is the day its `date:` literal names.
 *
 * `new Date('2026-07-01')` is UTC midnight, and `toLocaleDateString` with no
 * zone renders that instant in the host's zone — 20:00 on 30 June anywhere in
 * the US. So /blog and /blog/<slug> printed "June 30, 2026" over an
 * `article:published_time` of 2026-07-01, and /changelog printed "Sep 1"
 * beside entries dated the 2nd. The prerender runs in UTC and got it right;
 * hydration in a US browser then rewrote it wrong. vitest.config.ts pins TZ to
 * America/New_York, so every assertion below is live against the naive call.
 */
const FIRST_OF_MONTH = POSTS.find((p) => p.date.endsWith('-01'))!;

describe('public pages print the day their date literal names', () => {
  it('has a first-of-the-month post to test with', () => {
    // 2026-07-01 when this landed. If every such post is ever gone, the
    // month-boundary case below is untested and this says so.
    expect(FIRST_OF_MONTH?.date).toMatch(/-01$/);
  });

  it('/blog lists the post on the 1st, not the 30th', () => {
    const { container } = render(
      <MemoryRouter>
        <BlogIndex />
      </MemoryRouter>
    );
    expect(container.textContent).toContain('July 1, 2026');
    expect(container.textContent).not.toContain('June 30, 2026');
  });

  it('/blog/<slug> shows the same day it publishes as article:published_time', () => {
    const { container } = render(
      <MemoryRouter initialEntries={[`/blog/${FIRST_OF_MONTH.slug}`]}>
        <Routes>
          <Route path="/blog/:slug" element={<BlogPost />} />
        </Routes>
      </MemoryRouter>
    );
    const published = container.ownerDocument
      .querySelector('meta[property="article:published_time"]')
      ?.getAttribute('content');
    expect(published).toBe(FIRST_OF_MONTH.date);
    expect(container.textContent).toContain('July 1, 2026');
    expect(container.textContent).not.toContain('June 30, 2026');
  });

  it('/changelog dates each entry on its own day and files it under its own month', () => {
    const { container } = render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>
    );
    // Three entries are dated 2026-09-02 and none 2026-09-01.
    expect(container.textContent).toContain('Sep 2');
    expect(container.textContent).not.toContain('Sep 1');
    expect(container.textContent).toContain('September 2026');
  });

  it('files a changelog entry dated the 1st under its own month', () => {
    // No shipped entry falls on a 1st, so the rendered page cannot show this
    // failing: with the naive call, 2026-09-01 groups under August 2026 in
    // any US zone. A synthetic entry is the only fixture that can go red.
    const grouped = groupByMonth([{ date: '2026-09-01', category: 'Fix', title: 't', body: null }]);
    expect([...grouped.keys()]).toEqual(['September 2026']);
  });
});
