/**
 * `/pet-safe/<slug>` as rendered, run through the same gate the build runs
 * over `dist/` (scripts/check-plant-safety-pages.mjs), plus the negative
 * controls that prove that gate can fail.
 *
 * A gate that only ever sees correct pages is indistinguishable from one that
 * checks nothing. Each control below renders the REAL template, breaks exactly
 * one thing a future edit could break — a verdict for a blank field, a
 * sentence typed into the template, a paraphrased note, a swapped citation —
 * and asserts the gate names it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { I18nextProvider } from 'react-i18next';
import i18next from 'i18next';
import type { ReactNode } from 'react';

vi.mock('@/config/commercialStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/commercialStatus')>()),
  PUBLIC_REGISTRATION_AVAILABLE: true,
}));

vi.mock('@/services/petToxicityService', () => ({
  petToxicityService: { lookup: vi.fn() },
}));

import { PublicShell } from '@/components/PublicShell';
import { headToTags, resolveHead } from '@/config/seo';
import { PetSafePage } from '@/features/petsafe/PetSafePage';
import { PetSafePlantPage } from '@/features/petsafe/PetSafePlantPage';
import { PlantSafetyArticle } from '@/features/petsafe/PlantSafetyArticle';
import {
  PLANT_SAFETY_PAGES,
  findPlantSafetyPage,
  plantSafetyMeta,
  toPlantSafetyPage,
  type PlantSafetyPage,
} from '@/features/petsafe/plantSafetyPages';
import esCatalog from '@/i18n/locales/es/translation.json';
import {
  ASPCA_ANIMAL_POISON_CONTROL_URL,
  PET_TOXICITY,
  type PetToxicityEntry,
} from '../../../../backend/src/models/petToxicity';
// @ts-expect-error - vanilla ESM build script, deliberately untyped
import { checkPlantSafetyPageHtml } from '../../../scripts/check-plant-safety-pages.mjs';

afterEach(cleanup);

const entryFor = (slug: string): PetToxicityEntry => {
  const entry = PET_TOXICITY.find((e) => e.slug === slug);
  if (!entry) throw new Error(`no table entry ${slug}`);
  return entry;
};

/** A full document, as prerender.mjs would write it: the route's head plus the rendered body. */
function documentFor(page: PlantSafetyPage, body: ReactNode = <PlantSafetyArticle page={page} />) {
  const { container } = render(
    <MemoryRouter initialEntries={[`/pet-safe/${page.slug}`]}>
      <PublicShell width="article">{body}</PublicShell>
    </MemoryRouter>
  );
  const meta = plantSafetyMeta(page, i18next.t.bind(i18next) as never);
  const head = headToTags(resolveHead(meta, `/pet-safe/${page.slug}`));
  const html = `<!doctype html><html><head>${head}</head><body>${container.innerHTML}</body></html>`;
  cleanup();
  return html;
}

function gate(html: string, entry: unknown): string[] {
  return checkPlantSafetyPageHtml({ html, entry, aspcaOrigin: ASPCA_ANIMAL_POISON_CONTROL_URL });
}

describe('every published plant page passes the build gate as rendered', () => {
  it.each(PLANT_SAFETY_PAGES.map((page) => [page.slug, page] as const))('%s', (slug, page) => {
    expect(gate(documentFor(page), entryFor(slug))).toEqual([]);
  });

  it('renders each verdict beside its ASPCA listing, and the note', () => {
    const page = findPlantSafetyPage('hoya')!;
    render(
      <MemoryRouter>
        <PlantSafetyArticle page={page} />
      </MemoryRouter>
    );
    const verdicts = document.querySelectorAll('[data-claim="verdict"]');
    expect([...verdicts].map((v) => v.getAttribute('data-state'))).toEqual([
      'non-toxic',
      'non-toxic',
    ]);
    const citations = document.querySelectorAll('a[data-claim="citation"]');
    expect(citations.length).toBe(3); // cats, dogs, note
    for (const a of citations) {
      expect(a.getAttribute('href')).toBe(
        `${ASPCA_ANIMAL_POISON_CONTROL_URL}/toxic-and-non-toxic-plants/wax-plant`
      );
    }
    expect(screen.getByText(entryFor('hoya').note)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Get started' })).toHaveAttribute('href', '/register');
  });
});

describe('negative controls: the gate fails on what it exists to catch', () => {
  it('a page calling a BLANK table field safe fails the safety check', () => {
    // The page as a renderer that treated "not toxic" as "non-toxic" would
    // produce it, for an entry whose dogs field is blank.
    const blank = { ...entryFor('hoya'), dogs: '' };
    const sabotaged = findPlantSafetyPage('hoya')!; // still claims dogs: non-toxic
    const failures = gate(documentFor(sabotaged), blank);
    expect(failures.join('\n')).toContain('ASSERTS SAFETY for dogs ("Non-toxic")');
    expect(failures.join('\n')).toContain('hoya.dogs as non-toxic with a source');
  });

  it('the same blank field rendered honestly reads "Not assessed" and passes', () => {
    const blank = { ...entryFor('hoya'), dogs: '' };
    const honest = toPlantSafetyPage(blank)!;
    expect(honest.claims.dogs.state).toBe('not-assessed');
    const html = documentFor(honest);
    expect(html).toContain('data-state="not-assessed"');
    expect(html).not.toContain(entryFor('hoya').note);
    expect(gate(html, blank)).toEqual([]);
  });

  it('a sentence typed into the template fails the provenance check', () => {
    const page = findPlantSafetyPage('english-ivy')!;
    const html = documentFor(page).replace(
      '</article>',
      '<p>English ivy is also fine for rabbits.</p></article>'
    );
    expect(gate(html, entryFor('english-ivy')).join('\n')).toContain(
      'text that no table field or catalog string accounts for: "English ivy is also fine for rabbits."'
    );
  });

  it('a hand-typed safety claim inside template copy fails, even when marked as chrome', () => {
    const page = findPlantSafetyPage('english-ivy')!;
    const html = documentFor(page).replace(
      '</article>',
      '<p data-chrome="plantSafetyPage.aboutBody">Safe around cats once dried.</p></article>'
    );
    expect(gate(html, entryFor('english-ivy')).join('\n')).toContain(
      'plantSafetyPage.aboutBody renders "Safe around cats once dried."'
    );
  });

  it('a paraphrased note fails', () => {
    const page = { ...findPlantSafetyPage('money-tree')!, note: 'Totally harmless.' };
    expect(gate(documentFor(page), entryFor('money-tree')).join('\n')).toContain(
      'the note differs from the table'
    );
  });

  it('a citation pointing at a different listing fails', () => {
    const page = findPlantSafetyPage('parlor-palm')!;
    const html = documentFor(page).replaceAll(
      '/toxic-and-non-toxic-plants/parlor-palm',
      '/toxic-and-non-toxic-plants/sago-palm'
    );
    expect(gate(html, entryFor('parlor-palm')).join('\n')).toContain('has no citation beside it');
  });
});

describe('a slug with no published page', () => {
  function renderRoute(slug: string) {
    return render(
      <MemoryRouter initialEntries={[`/pet-safe/${slug}`]}>
        <Routes>
          <Route path="/pet-safe/:slug" element={<PetSafePlantPage />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it.each(['no-such-plant', 'spider-plant', 'pothos'])(
    '%s says nothing about the plant and is noindex',
    (slug) => {
      const { container } = renderRoute(slug);
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
        'No cited verdict for this plant'
      );
      expect(container.querySelector('[data-claim]')).toBeNull();
      expect(container.textContent).not.toMatch(/non-toxic|toxic to/i);
      const table = PET_TOXICITY.find((e) => e.slug === slug);
      if (table) expect(container.textContent).not.toContain(table.note);
      expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
        'noindex, follow'
      );
    }
  );
});

describe('the Spanish catalog', () => {
  it('a not-assessed page carries no Spanish safety wording', async () => {
    const es = i18next.createInstance();
    await es.init({
      lng: 'es',
      resources: { es: { translation: esCatalog } },
      interpolation: { escapeValue: false },
    });
    const page = toPlantSafetyPage({ ...entryFor('hoya'), cats: '', dogs: 'non-toxic' })!;
    const onlyDogs = {
      ...page,
      claims: { ...page.claims, dogs: { state: 'not-assessed' as const } },
    };
    const { container } = render(
      <I18nextProvider i18n={es}>
        <MemoryRouter>
          <PlantSafetyArticle page={onlyDogs} />
        </MemoryRouter>
      </I18nextProvider>
    );
    expect(container.textContent).toContain('Sin evaluar');
    expect(container.textContent).not.toMatch(/segur[ao]s?\b|no tóxic|inofensiv|sin peligro/i);
  });
});

describe('/pet-safe links every published plant page', () => {
  it('by name, with no verdict beside the link', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/pet-safe']}>
        <PetSafePage />
      </MemoryRouter>
    );
    const hrefs = [...container.querySelectorAll('a[href^="/pet-safe/"]')].map((a) =>
      a.getAttribute('href')
    );
    expect(hrefs).toEqual(PLANT_SAFETY_PAGES.map((page) => `/pet-safe/${page.slug}`));
  });
});
