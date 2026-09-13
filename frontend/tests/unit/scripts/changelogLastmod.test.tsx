/**
 * `/changelog`'s sitemap `<lastmod>` must be a date the page actually shows.
 *
 * Issue #718, measured on the live host: `sitemap.xml` advertised
 * `2026-09-12` while the newest entry rendered on `/changelog` was
 * `2026-09-02`. The lastmod was derived from the newest `## [x.y.z]` heading
 * in the repo's CHANGELOG.md — a different document, on a different cadence,
 * that this page does not track. Ten days of freshness the reader could not
 * see.
 *
 * Nothing caught it, and it is worth being precise about why:
 * `build-sitemap.mjs --check` byte-compares the committed sitemap against what
 * the generator produces, so it can tell a STALE file from a fresh one and
 * cannot tell a RIGHT date from a WRONG one. Both sides of that comparison
 * read the same wrong source. So the assertion has to come from outside the
 * generator, which is what this file is.
 *
 * The oracle deliberately is not `readChangelogEntryDates()`. These tests
 * re-derive the page's dates two other ways — a differently-written regex over
 * the source, and a count of the entries React actually renders — so a parser
 * that silently stops matching cannot agree with itself into a pass.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ChangelogPage } from '@/features/changelog/ChangelogPage';
// @ts-expect-error - vanilla ESM build script, deliberately untyped
import { publicRoutes, readChangelogEntryDates } from '../../../scripts/public-routes.mjs';

const CHANGELOG_PAGE = resolve(__dirname, '../../../src/features/changelog/ChangelogPage.tsx');
const CHANGELOG_MD = resolve(__dirname, '../../../../CHANGELOG.md');

/**
 * Every ISO date literal in the page source, found with a pattern written
 * differently from the generator's: any `'YYYY-MM-DD'` quoted literal,
 * unanchored, rather than the generator's anchored `^\s+date: '…',$`. Two
 * patterns that fail the same way is the thing to avoid; two that differ in
 * anchoring and in what they key on do not.
 */
function pageDatesFromSource(): string[] {
  const src = readFileSync(CHANGELOG_PAGE, 'utf8');
  return [...src.matchAll(/'(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]);
}

/** The newest released `## [x.y.z] - YYYY-MM-DD` section in CHANGELOG.md. */
function newestReleaseDate(): string | undefined {
  const src = readFileSync(CHANGELOG_MD, 'utf8');
  return /^## \[\d+\.\d+\.\d+\][^\n]*?(\d{4}-\d{2}-\d{2})/m.exec(src)?.[1];
}

function changelogLastmod(): string | undefined {
  const route = publicRoutes().find((r: { path: string }) => r.path === '/changelog');
  expect(route, '/changelog is missing from the public route list').toBeTruthy();
  return (route as { lastmod?: string }).lastmod;
}

describe('/changelog sitemap lastmod', () => {
  it('is one of the dates the page itself carries', () => {
    const dates = pageDatesFromSource();
    expect(dates.length).toBeGreaterThan(0);
    expect(dates).toContain(changelogLastmod());
  });

  it('is the newest of them', () => {
    const newest = [...pageDatesFromSource()].sort().at(-1);
    expect(changelogLastmod()).toBe(newest);
  });

  /**
   * The regression itself. CHANGELOG.md gains a section on every release and
   * `/changelog` gains one every few weeks, so the release date runs ahead of
   * the page for most of any given month — on 2026-09-13 it was ten days
   * ahead. Asserting the two are merely unequal would pass for the wrong
   * reason on a day they happened to coincide, so this asserts the direction
   * that matters: whatever CHANGELOG.md says, the advertised date is a date
   * the page carries.
   */
  it('does not advertise a CHANGELOG.md release date the page does not show', () => {
    const release = newestReleaseDate();
    expect(release, 'CHANGELOG.md has no released section to compare against').toBeTruthy();
    const dates = pageDatesFromSource();
    if (!dates.includes(release as string)) {
      expect(changelogLastmod()).not.toBe(release);
    }
    // Unconditional, and the real claim: the advertised date came from the page.
    expect(dates).toContain(changelogLastmod());
  });

  /**
   * The count cross-check, and the assertion that has to name the GENERATOR's
   * parser rather than this file's.
   *
   * A regex that silently stops matching some entries still produces a
   * plausible max, and `sitemap:check` stays green over it. React is the other
   * reader of the same array: every entry renders one <li>. So the number of
   * dates `readChangelogEntryDates()` returns and the number of entries the
   * page renders must agree.
   *
   * The first draft of this test compared the rendered count against
   * `pageDatesFromSource()` — this file's own regex — and a control that
   * narrowed the generator's pattern to `'2026-09-\d{2}'` left it GREEN,
   * because neither side of that comparison was the code under test. It
   * checked the oracle, which is worth doing, and proved nothing about the
   * generator. Both pairings are asserted below for that reason.
   */
  it('the generator parses exactly as many entries as the page renders', () => {
    render(
      <MemoryRouter>
        <ChangelogPage />
      </MemoryRouter>
    );
    const rendered = screen.getAllByRole('listitem').length;
    expect(readChangelogEntryDates()).toHaveLength(rendered);
    // …and the oracle this file uses sees the same entries the generator does.
    expect(pageDatesFromSource()).toHaveLength(rendered);
  });
});
