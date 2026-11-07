import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('@/config/commercialStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/commercialStatus')>()),
  PUBLIC_REGISTRATION_AVAILABLE: true,
}));

vi.mock('@/services/googleAnalytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/googleAnalytics')>();
  return { ...actual, trackGoogleConversion: vi.fn() };
});

vi.mock('@/services/petToxicityService', () => ({
  petToxicityService: { lookup: vi.fn() },
}));

import { trackGoogleConversion } from '@/services/googleAnalytics';
import { CareGuidePage } from '@/features/care/CareGuidePage';
import { BlogPost } from '@/features/blog/BlogPost';
import { POSTS } from '@/features/blog/posts';
import { PetSafePlantPage } from '@/features/petsafe/PetSafePlantPage';

/**
 * Every sign-up link on the content pages search sends people to is counted
 * as `landing_cta_click` (2026-10-30 audit: only the home page's two buttons
 * were, so "0 clicks from guides" meant "not measured"). Content clicks name
 * the page type, the spot on the page and the plant, and never the home
 * page's `cta`, so the two can't be confused in GA4. Consent, GPC and DNT are
 * handled inside `trackGoogleConversion` itself (googleAnalytics.test.ts),
 * exactly as for the home page.
 */
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/care/:slug" element={<CareGuidePage />} />
        <Route path="/blog/:slug" element={<BlogPost />} />
        <Route path="/pet-safe/:slug" element={<PetSafePlantPage />} />
        <Route path="/register" element={<p>register</p>} />
      </Routes>
    </MemoryRouter>
  );
}

const calls = () => vi.mocked(trackGoogleConversion).mock.calls.map(([c]) => c);

afterEach(() => {
  cleanup();
  vi.mocked(trackGoogleConversion).mockClear();
});

/**
 * Render `path`, click the one link `pick` finds, and return what was sent.
 * One click per render: following a link navigates away from the page.
 */
async function clickOn(path: string, pick: () => HTMLElement) {
  const user = userEvent.setup();
  renderAt(path);
  const link = pick();
  const href = link.getAttribute('href');
  await user.click(link);
  const sent = calls();
  cleanup();
  vi.mocked(trackGoogleConversion).mockClear();
  return { href, sent };
}

describe('content-page sign-up links are counted', () => {
  it('counts the care guide answer link and the care guide box, with the plant', async () => {
    const glance = await clickOn('/care/zz-plant', () => screen.getByTestId('care-glance-cta'));
    expect(glance.href).toBe('/register?plant=zz-plant');
    expect(glance.sent).toEqual([
      { name: 'landing_cta_click', source: 'care_guide', placement: 'glance', plant: 'zz-plant' },
    ]);
    const box = await clickOn('/care/zz-plant', () =>
      within(screen.getByTestId('care-cta')).getByRole('link')
    );
    expect(box.href).toBe('/register?plant=zz-plant');
    expect(box.sent).toEqual([
      { name: 'landing_cta_click', source: 'care_guide', placement: 'body', plant: 'zz-plant' },
    ]);
  });

  it('counts the header "Try the app" link with the page it was on', async () => {
    const { href, sent } = await clickOn('/care/monstera', () =>
      screen.getByRole('link', { name: /try the app/i })
    );
    // The header link itself is unchanged.
    expect(href).toBe('/register');
    expect(sent).toEqual([
      { name: 'landing_cta_click', source: 'care_guide', plant: 'monstera', placement: 'header' },
    ]);
  });

  it('counts the pet-safety page sign-up link, carrying the plant', async () => {
    const { href, sent } = await clickOn('/pet-safe/peace-lily', () =>
      screen.getByRole('link', { name: 'Set up reminders' })
    );
    expect(href).toBe('/register?plant=peace-lily');
    expect(sent).toEqual([
      { name: 'landing_cta_click', source: 'pet_safe', placement: 'body', plant: 'peace-lily' },
    ]);
  });

  it('counts the blog post sign-up link and the header link on a post', async () => {
    const path = `/blog/${POSTS[0]!.slug}`;
    const body = await clickOn(path, () => screen.getByRole('link', { name: 'Get started' }));
    expect(body.sent).toEqual([{ name: 'landing_cta_click', source: 'blog', placement: 'body' }]);
    const header = await clickOn(path, () => screen.getByRole('link', { name: /try the app/i }));
    expect(header.sent).toEqual([
      { name: 'landing_cta_click', source: 'blog', placement: 'header' },
    ]);
  });

  it('never sends the home page `cta` field from a content page', async () => {
    const pickers: Array<() => HTMLElement> = [
      () => screen.getByTestId('care-glance-cta'),
      () => within(screen.getByTestId('care-cta')).getByRole('link'),
      () => screen.getByRole('link', { name: /try the app/i }),
    ];
    for (const pick of pickers) {
      const { sent } = await clickOn('/care/aloe-vera', pick);
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toHaveProperty('cta');
    }
  });
});
