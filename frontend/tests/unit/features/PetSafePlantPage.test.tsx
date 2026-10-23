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
  POISON_HOTLINES,
  findPlantSafetyPage,
  plantSafetyMeta,
  toPlantSafetyPage,
  type PlantSafetyPage,
} from '@/features/petsafe/plantSafetyPages';
import esCatalog from '@/i18n/locales/es/translation.json';
import enCatalog from '@/i18n/locales/en/translation.json';
import { CARE_GUIDE_SLUGS } from '@/features/care/careGuideSlugs';
import {
  ASPCA_ANIMAL_POISON_CONTROL_URL,
  PET_TOXICITY,
  type PetToxicityEntry,
} from '../../../../backend/src/models/petToxicity';
// @ts-expect-error - vanilla ESM build script, deliberately untyped
import {
  POISON_HOTLINES as GATE_HOTLINES,
  checkPlantSafetyPageHtml,
  readCatalog,
} from '../../../scripts/check-plant-safety-pages.mjs';

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

  it('a head description that STATES safety fails, while the one question is allowed', () => {
    const page = findPlantSafetyPage('hoya')!;
    const html = documentFor(page);
    const catalog = readCatalog();
    const template = catalog['plantSafetyPage.metaDescription']!;
    expect(template).toContain('poisonous or safe for pets?');
    const asked = (c: Record<string, string>) =>
      checkPlantSafetyPageHtml({
        html,
        entry: entryFor('hoya'),
        aspcaOrigin: ASPCA_ANIMAL_POISON_CONTROL_URL,
        catalog: c,
      }).filter((f: string) => f.includes('asserts safety'));
    expect(asked(catalog)).toEqual([]);
    const sabotaged = template.replace('poisonous or safe for pets?', 'safe for pets.');
    expect(sabotaged).not.toBe(template);
    expect(
      asked({ ...catalog, 'plantSafetyPage.metaDescription': sabotaged }).join('\n')
    ).toContain('plantSafetyPage.metaDescription asserts safety ("safe")');
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

  // ZZ plant is the one table row with no per-plant listing (ASPCA has none).
  it.each(['no-such-plant', 'zz-plant'])(
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

describe('a plant page links its own care guide when one exists', () => {
  const careLinks = (page: PlantSafetyPage) => {
    const { container } = render(
      <MemoryRouter>
        <PlantSafetyArticle page={page} />
      </MemoryRouter>
    );
    const hrefs = [...container.querySelectorAll('a[href^="/care/"]')].map((a) =>
      a.getAttribute('href')
    );
    cleanup();
    return hrefs;
  };

  it.each(PLANT_SAFETY_PAGES.map((page) => [page.slug, page] as const))('%s', (slug, page) => {
    expect(careLinks(page)).toEqual(CARE_GUIDE_SLUGS.has(slug) ? [`/care/${slug}`] : []);
  });

  it('links most pages, and never invents a guide for a plant without one', () => {
    const linked = PLANT_SAFETY_PAGES.filter((page) => careLinks(page).length > 0);
    // 22 of the 28 published pages had a guide with the same slug when this landed.
    expect(linked.length).toBeGreaterThanOrEqual(20);
    expect(careLinks(findPlantSafetyPage('philodendron')!)).toEqual([]);
  });

  it('names the plant in the link text, from the catalog', () => {
    render(
      <MemoryRouter>
        <PlantSafetyArticle page={findPlantSafetyPage('pothos')!} />
      </MemoryRouter>
    );
    expect(
      screen.getByRole('link', { name: 'Pothos care guide: watering, light and common problems' })
    ).toHaveAttribute('href', '/care/pothos');
  });

  it('fails the build gate when the link points at a guide that does not exist', () => {
    const page = findPlantSafetyPage('pothos')!;
    const html = documentFor(page).replace('href="/care/pothos"', 'href="/care/not-a-guide"');
    expect(html).toContain('href="/care/not-a-guide"');
    expect(gate(html, entryFor('pothos')).join('\n')).toMatch(/not a published page/);
  });
});

/**
 * The emergency aside: both hotlines, their numbers and their fee sentences,
 * first on every page. Each negative control asserts its sabotage changed the
 * HTML before asserting the gate names it, so a replace() that silently
 * matches nothing cannot pass as a caught failure.
 */
describe('the emergency aside', () => {
  const ASPCA_DIGITS = '8884264435';
  const PPH_DIGITS = '8557647661';
  const sabotage = (html: string, from: string | RegExp, to: string) => {
    const out = html.replace(from, to);
    expect(out).not.toBe(html);
    return out;
  };

  async function renderIn(lng: 'en' | 'es', page: PlantSafetyPage) {
    const i18n = i18next.createInstance();
    await i18n.init({
      lng,
      resources: { [lng]: { translation: lng === 'es' ? esCatalog : enCatalog } },
      interpolation: { escapeValue: false },
    });
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <PlantSafetyArticle page={page} />
        </MemoryRouter>
      </I18nextProvider>
    );
    return container;
  }

  it('the gate and the app agree on the hotlines', () => {
    expect(GATE_HOTLINES).toEqual(POISON_HOTLINES);
    expect(POISON_HOTLINES.map((h) => h.tel)).toEqual([
      `tel:+1${ASPCA_DIGITS}`,
      `tel:+1${PPH_DIGITS}`,
    ]);
  });

  it.each(PLANT_SAFETY_PAGES.map((page) => [page.slug, page] as const))(
    '%s opens with the aside, before the verdicts',
    (_slug, page) => {
      const { container } = render(
        <MemoryRouter>
          <PlantSafetyArticle page={page} />
        </MemoryRouter>
      );
      const article = container.querySelector('article')!;
      const aside = article.querySelector('aside[data-plant-emergency]');
      expect(article.firstElementChild).toBe(aside);
      for (const verdict of article.querySelectorAll('[data-claim="verdict"]')) {
        expect(
          aside!.compareDocumentPosition(verdict) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy();
      }
    }
  );

  it('appears on "Not assessed" pages too, not only on toxic ones', () => {
    // Today's table publishes only toxic and non-toxic verdicts; a blank field
    // turns into "Not assessed" the day one appears, so render that page.
    const blank = { ...entryFor('hoya'), cats: '' };
    const page = toPlantSafetyPage(blank)!;
    expect(page.claims.cats.state).toBe('not-assessed');
    const html = documentFor(page);
    expect(html).toContain('data-state="not-assessed"');
    expect(html.indexOf('data-plant-emergency')).toBeLessThan(html.indexOf('data-claim="verdict"'));
    expect(gate(html, blank)).toEqual([]);
    const toxic = PLANT_SAFETY_PAGES.find((p) => p.claims.cats.state === 'toxic')!;
    const nonToxic = PLANT_SAFETY_PAGES.find((p) => p.claims.cats.state === 'non-toxic')!;
    for (const p of [toxic, nonToxic]) expect(documentFor(p)).toContain('data-plant-emergency');
  });

  it.each(['en', 'es'] as const)(
    '%s: both numbers, both fee sentences, tel: matching the digits',
    async (lng) => {
      const catalog = (lng === 'es' ? esCatalog : enCatalog).plantSafetyPage;
      const container = await renderIn(lng, findPlantSafetyPage('english-ivy')!);
      const aside = container.querySelector('aside[data-plant-emergency]')!;
      const text = aside.textContent ?? '';
      expect(text).toContain('(888) 426-4435');
      expect(text).toContain('(855) 764-7661');
      expect(text).toContain(catalog.hotlineFee.aspca);
      expect(text).toContain(catalog.hotlineFee.petPoisonHelpline);
      expect(text).toContain('A consultation fee may apply');
      expect(text).toContain('$99 incident fee applies');
      expect(text).toContain(catalog.emergencyBody);
      expect(text).toContain(catalog.emergencyListingNote);
      expect(text).toContain(catalog.hotlinesChecked);
      const links = [...aside.querySelectorAll('a')];
      expect(links.map((a) => a.getAttribute('href'))).toEqual([
        `tel:+1${ASPCA_DIGITS}`,
        `tel:+1${PPH_DIGITS}`,
      ]);
      for (const a of links) {
        const dialed = a.getAttribute('href')!.replace(/\D/g, '').replace(/^1/, '');
        expect((a.textContent ?? '').replace(/\D/g, '')).toBe(dialed);
      }
    }
  );

  it('names each link by its hotline and number', () => {
    render(
      <MemoryRouter>
        <PlantSafetyArticle page={findPlantSafetyPage('pothos')!} />
      </MemoryRouter>
    );
    expect(
      screen.getByRole('link', { name: 'ASPCA Animal Poison Control Center: (888) 426-4435' })
    ).toHaveAttribute('href', `tel:+1${ASPCA_DIGITS}`);
    expect(
      screen.getByRole('link', { name: 'Pet Poison Helpline: (855) 764-7661' })
    ).toHaveAttribute('href', `tel:+1${PPH_DIGITS}`);
  });

  it('carries no affiliate, sponsored or paid marker, even on a page with a shop link', async () => {
    for (const page of PLANT_SAFETY_PAGES) {
      for (const lng of ['en', 'es'] as const) {
        const container = await renderIn(lng, page);
        const aside = container.querySelector('aside[data-plant-emergency]')!;
        expect(aside.outerHTML).not.toMatch(
          /affiliat|sponsor|paid link|enlace de pago|comisi[oó]n|data-plant-shop|utm_|\?tag=/i
        );
        expect(
          [...aside.querySelectorAll('a')].every((a) => a.getAttribute('href')!.startsWith('tel:'))
        ).toBe(true);
        cleanup();
      }
    }
  });

  it('its strings come from the catalogs, so the provenance gate passes', () => {
    const html = documentFor(findPlantSafetyPage('aloe-vera') ?? PLANT_SAFETY_PAGES[0]!);
    const aside = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
    for (const key of [
      'emergencyHeading',
      'emergencyBody',
      'hotline.aspca',
      'hotline.petPoisonHelpline',
      'hotlineFee.aspca',
      'hotlineFee.petPoisonHelpline',
      'hotlinesChecked',
      'emergencyListingNote',
    ]) {
      expect(aside).toContain(`data-chrome="plantSafetyPage.${key}"`);
    }
  });

  describe('negative controls', () => {
    const slug = 'english-ivy';
    const page = () => findPlantSafetyPage(slug)!;
    const failuresFor = (html: string) => gate(html, entryFor(slug)).join('\n');

    it('a page with the aside removed fails', () => {
      const html = documentFor(page());
      const out = sabotage(html, /<aside[\s\S]*?<\/aside>/, '');
      expect(failuresFor(out)).toContain('expected one <aside data-plant-emergency>, found 0');
    });

    it('an aside moved below the verdicts fails', () => {
      const html = documentFor(page());
      const aside = html.match(/<aside[\s\S]*?<\/aside>/)![0];
      const out = sabotage(html.replace(aside, ''), '</article>', `${aside}</article>`);
      const failures = failuresFor(out);
      expect(failures).toContain('the emergency aside is not first');
      expect(failures).toContain('a verdict comes before the emergency aside');
    });

    it('a tel: href that no longer matches the visible number fails', () => {
      const html = documentFor(page());
      const out = sabotage(html, `tel:+1${PPH_DIGITS}`, 'tel:+18005550199');
      const failures = failuresFor(out);
      expect(failures).toContain('the emergency aside dials');
    });

    it('a visible number that no longer matches the tel: href fails', () => {
      const html = documentFor(page());
      const out = sabotage(html, '(888) 426-4435', '(888) 426-4436');
      const failures = failuresFor(out);
      expect(failures).toContain('the aspca link dials tel:+18884264435 but shows');
    });

    it('a dropped fee sentence fails', () => {
      const html = documentFor(page());
      const out = sabotage(
        html,
        /<span data-chrome="plantSafetyPage\.hotlineFee\.petPoisonHelpline"[^>]*>[^<]*<\/span>/,
        ''
      );
      expect(failuresFor(out)).toContain('the petPoisonHelpline hotline has no fee sentence');
    });

    it('a fee sentence edited away from the catalog fails provenance', () => {
      const html = documentFor(page());
      const out = sabotage(html, '$99 incident fee applies', 'Free, no fee');
      expect(failuresFor(out)).toContain('plantSafetyPage.hotlineFee.petPoisonHelpline renders');
    });

    it('an affiliate link inside the aside fails', () => {
      const html = documentFor(page());
      const out = sabotage(
        html,
        '</aside>',
        '<p><a href="https://example.com/vet?tag=fg-20" rel="sponsored noopener" data-chrome="plantSafetyPage.emergencyBody">x</a></p></aside>'
      );
      const failures = failuresFor(out);
      expect(failures).toContain('the emergency aside links https://example.com/vet?tag=fg-20');
      expect(failures).toContain('the emergency aside carries a monetized element');
    });

    it('a tel: link outside the aside fails', () => {
      const html = documentFor(page());
      const out = sabotage(
        html,
        '</article>',
        `<p><a href="tel:+1${ASPCA_DIGITS}" data-chrome="plantSafetyPage.hotline.aspca">ASPCA Animal Poison Control Center: (888) 426-4435</a></p></article>`
      );
      expect(failuresFor(out)).toContain(`dials tel:+1${ASPCA_DIGITS} outside the emergency aside`);
    });

    it('the unsabotaged page passes, so each failure above is the sabotage', () => {
      expect(failuresFor(documentFor(page()))).toBe('');
    });
  });
});

describe('a slug with no published page still leads with the emergency aside', () => {
  it('shows both hotlines', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/pet-safe/no-such-plant']}>
        <Routes>
          <Route path="/pet-safe/:slug" element={<PetSafePlantPage />} />
        </Routes>
      </MemoryRouter>
    );
    const article = container.querySelector('article')!;
    expect(article.firstElementChild?.matches('aside[data-plant-emergency]')).toBe(true);
    expect(
      [...article.querySelectorAll('a[href^="tel:"]')].map((a) => a.getAttribute('href'))
    ).toEqual(POISON_HOTLINES.map((h) => h.tel));
  });
});
