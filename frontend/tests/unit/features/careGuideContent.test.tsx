import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Suspense } from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CARE_GUIDES, type CareGuide } from '@/features/care/careGuides';
import * as source from '@/features/care/careGuideSource';
import {
  CARE_GUIDE_DATA_ID,
  CARE_GUIDE_INDEX,
  careGuideDataElement,
  careGuideResource,
  findCareGuideEntry,
  parseCareGuideData,
  isHttpsUrl,
  resetCareGuideResources,
  toCareGuide,
} from '@/features/care/careGuideContent';
import { CareGuidePage } from '@/features/care/CareGuidePage';
import {
  CARE_GUIDE_SOURCE,
  careGuideClientModule,
  careGuideContent,
} from '../../../vite.careGuideContent';

/**
 * The care guides left the browser's JavaScript bundle (careGuideContent.ts).
 * These tests hold the three things that keep that invisible to a reader: the
 * browser build's stand-in module matches the one it replaces, the JSON a
 * prerendered page carries round-trips to the same guide, and a guide page
 * renders from that JSON or from a fetch when the bundle has no guides.
 */

vi.mock('@/features/care/careGuideSource', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/care/careGuideSource')>();
  return { ...actual, bundledCareGuide: vi.fn(actual.bundledCareGuide) };
});

const FRONTEND = resolve(__dirname, '../../..');
const bundledCareGuide = vi.mocked(source.bundledCareGuide);
const realBundledCareGuide = bundledCareGuide.getMockImplementation()!;

/** As in the browser build: the bundle carries no guides. */
function withoutBundledGuides() {
  bundledCareGuide.mockReturnValue(undefined);
}

afterEach(() => {
  resetCareGuideResources();
  vi.restoreAllMocks();
  bundledCareGuide.mockReset();
  bundledCareGuide.mockImplementation(realBundledCareGuide);
  document.getElementById(CARE_GUIDE_DATA_ID)?.remove();
});

describe('the browser build stand-in for careGuideSource.ts', () => {
  async function importGenerated(code: string) {
    // Inside the project: the test runner will not load a module from the OS
    // temp directory.
    const dir = mkdtempSync(join(FRONTEND, '..', 'node_modules', '.care-guide-client-'));
    try {
      const file = join(dir, 'careGuideSource.mjs');
      writeFileSync(file, code);
      return (await import(/* @vite-ignore */ file)) as typeof source;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('has the same exports, the same index, and no guides', async () => {
    const generated = await importGenerated(careGuideClientModule(source.CARE_GUIDE_INDEX));
    expect(Object.keys(generated).sort()).toEqual(Object.keys(source).sort());
    expect(generated.CARE_GUIDE_INDEX).toEqual(source.CARE_GUIDE_INDEX);
    expect(generated.bundledCareGuide(CARE_GUIDES[0]!.slug)).toBeUndefined();
  });

  it('carries the index fields and none of the prose', () => {
    const code = careGuideClientModule(source.CARE_GUIDE_INDEX);
    const pothos = CARE_GUIDES.find((g) => g.slug === 'pothos')!;
    expect(code).toContain(pothos.commonName);
    expect(code).not.toContain(pothos.summary);
    expect(code).not.toContain(pothos.sections.watering[0]);
  });

  it('is what the plugin serves for careGuideSource.ts in the browser build only', async () => {
    const plugin = careGuideContent();
    const configResolved = plugin.configResolved as (config: unknown) => void;
    const load = plugin.load as (id: string) => Promise<string | null>;

    configResolved({ build: { ssr: 'src/entry-server.tsx' } });
    expect(await load(CARE_GUIDE_SOURCE)).toBeNull();

    configResolved({ build: { ssr: false } });
    expect(await load(resolve(FRONTEND, 'src/features/care/careGuides.ts'))).toBeNull();
    expect(await load(CARE_GUIDE_SOURCE)).toBe(careGuideClientModule(source.CARE_GUIDE_INDEX));
  }, 60_000);

  it('is the only way the pages reach the guides', () => {
    // A value import of careGuides.ts from a page would put every guide back
    // in the bundle. Type imports and careGuideHeading (no data) are fine.
    for (const file of [
      'src/features/care/CareIndex.tsx',
      'src/features/care/CareGuidePage.tsx',
      'src/features/care/careGuideContent.ts',
      'src/features/petsafe/petSafeSpecies.ts',
    ]) {
      const text = readFileSync(resolve(FRONTEND, file), 'utf8');
      expect(text, file).not.toMatch(/\b(CARE_GUIDES|findCareGuide)\b.*from '.*careGuides'/);
      expect(text, file).not.toMatch(/import \{[^}]*\b(CARE_GUIDES|findCareGuide)\b[^}]*\}/);
    }
  });
});

describe('the JSON a prerendered guide page carries', () => {
  it('round-trips every guide exactly', () => {
    for (const guide of CARE_GUIDES) {
      expect(parseCareGuideData(careGuideDataElement(guide), guide.slug)).toEqual(guide);
    }
  });

  it('cannot be closed early by the prose', () => {
    const hostile: CareGuide = {
      ...CARE_GUIDES[0]!,
      summary: 'Ends here? </script><script>alert(1)</script> <!-- and $& too',
    };
    const element = careGuideDataElement(hostile);
    expect(element.match(/<\/script>/g)).toHaveLength(1);
    expect(element).not.toContain('<!--');
    expect(parseCareGuideData(`<p>page</p>${element}`, hostile.slug)).toEqual(hostile);
  });

  it('answers only for the slug it was written for', () => {
    const guide = CARE_GUIDES[0]!;
    expect(parseCareGuideData(careGuideDataElement(guide), 'not-this-one')).toBeUndefined();
    expect(parseCareGuideData('<html></html>', guide.slug)).toBeUndefined();
  });
});

describe('careGuideResource', () => {
  const guide = CARE_GUIDES.find((g) => g.slug === 'zz-plant')!;

  function embed(g: CareGuide) {
    document.body.insertAdjacentHTML('beforeend', careGuideDataElement(g));
  }

  it('reads a bundled guide without suspending', () => {
    const resource = careGuideResource(guide.slug) as Promise<CareGuide> & { status?: string };
    expect(resource.status).toBe('fulfilled');
    expect(careGuideResource(guide.slug)).toBe(resource);
  });

  it('reads the page’s embedded guide when the bundle has none', () => {
    withoutBundledGuides();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    embed(guide);
    const resource = careGuideResource(guide.slug) as Promise<CareGuide> & {
      status?: string;
      value?: CareGuide;
    };
    expect(resource.status).toBe('fulfilled');
    expect(resource.value).toEqual(guide);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches the prerendered page for any other guide, and retries after a failure', async () => {
    withoutBundledGuides();
    embed(CARE_GUIDES.find((g) => g.slug === 'pothos')!);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(`<!doctype html><body>${careGuideDataElement(guide)}</body>`)
      );

    await expect(careGuideResource(guide.slug)).rejects.toThrow('HTTP 503');
    await expect(careGuideResource(guide.slug)).resolves.toEqual(guide);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenLastCalledWith(`/care/${guide.slug}/index.html`);
  });
});

describe('CareGuidePage without bundled guides', () => {
  const guide = CARE_GUIDES.find((g) => g.slug === 'snake-plant')!;

  it('renders the fetched guide and its related links from the index', async () => {
    withoutBundledGuides();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(`<body>${careGuideDataElement(guide)}</body>`)
    );
    // Awaited so the suspension on the fetch settles inside act.
    await act(async () => {
      render(
        <MemoryRouter initialEntries={[`/care/${guide.slug}`]}>
          <Suspense fallback={<p>loading</p>}>
            <Routes>
              <Route path="/care/:slug" element={<CareGuidePage />} />
            </Routes>
          </Suspense>
        </MemoryRouter>
      );
    });

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      guide.heading ?? `${guide.commonName} care`
    );
    expect(screen.getByText(guide.summary)).toBeInTheDocument();
    for (const slug of guide.related) {
      const entry = findCareGuideEntry(slug)!;
      expect(screen.getByRole('link', { name: new RegExp(entry.commonName) })).toHaveAttribute(
        'href',
        `/care/${slug}`
      );
    }
  });

  it('lists every published guide in the index', () => {
    expect(CARE_GUIDE_INDEX.map((e) => e.slug)).toEqual(CARE_GUIDES.map((g) => g.slug));
  });
});

describe('untrusted guide JSON from the page', () => {
  // The embedded JSON is read out of the DOM, so it is checked before any of
  // it reaches an attribute: careSources[].url is rendered as an href.
  const guide = CARE_GUIDES.find((g) => g.slug === 'pothos')!;

  function withSourceUrl(url: unknown): CareGuide {
    return {
      ...guide,
      careSources: [
        { ...guide.careSources[0]!, url: url as string },
        ...guide.careSources.slice(1),
      ],
    };
  }

  function roundTrip(g: CareGuide): CareGuide | undefined {
    return parseCareGuideData(careGuideDataElement(g), g.slug);
  }

  it('rejects a guide with a javascript: source URL', () => {
    expect(roundTrip(withSourceUrl('javascript:alert(document.domain)'))).toBeUndefined();
    expect(roundTrip(withSourceUrl(' JavaScript:alert(1)'))).toBeUndefined();
  });

  it('rejects a guide with a malformed or non-https source URL', () => {
    for (const url of ['https://', 'not a url', '//evil.example/x', 'http://extension.example/']) {
      expect(roundTrip(withSourceUrl(url)), url).toBeUndefined();
    }
    expect(roundTrip(withSourceUrl(42))).toBeUndefined();
  });

  it('rejects JSON that is not a guide, or not this guide', () => {
    expect(
      parseCareGuideData(
        `<script type="application/json" id="${CARE_GUIDE_DATA_ID}" data-slug="pothos">{nope</script>`,
        'pothos'
      )
    ).toBeUndefined();
    expect(toCareGuide(null, guide.slug)).toBeUndefined();
    expect(toCareGuide({ ...guide, slug: 'zz-plant' }, guide.slug)).toBeUndefined();
    expect(toCareGuide({ ...guide, faqs: [{ q: 'Why?', a: 1 }] }, guide.slug)).toBeUndefined();
    expect(
      toCareGuide({ ...guide, sections: { ...guide.sections, light: 'x' } }, guide.slug)
    ).toBeUndefined();
  });

  it('accepts https URLs, and every published guide passes', () => {
    expect(isHttpsUrl('https://extension.psu.edu/pothos')).toBe(true);
    for (const g of CARE_GUIDES)
      expect(toCareGuide(JSON.parse(JSON.stringify(g)), g.slug), g.slug).toEqual(g);
  });

  it('does not use an embedded guide that fails the check', () => {
    withoutBundledGuides();
    document.body.insertAdjacentHTML(
      'beforeend',
      careGuideDataElement(withSourceUrl('javascript:alert(1)'))
    );
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 404 }));
    const resource = careGuideResource(guide.slug) as Promise<CareGuide> & { status?: string };
    expect(resource.status).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith(`/care/${guide.slug}/index.html`);
    return expect(resource).rejects.toThrow('HTTP 404');
  });

  it('renders an embedded guide’s https sources as links, and no //host link', async () => {
    withoutBundledGuides();
    const withHostLink: CareGuide = {
      ...guide,
      faqs: [...guide.faqs, { q: 'Elsewhere?', a: 'See [this page](//evil.example/x).' }],
    };
    document.body.insertAdjacentHTML('beforeend', careGuideDataElement(withHostLink));
    await act(async () => {
      render(
        <MemoryRouter initialEntries={[`/care/${guide.slug}`]}>
          <Suspense fallback={<p>loading</p>}>
            <Routes>
              <Route path="/care/:slug" element={<CareGuidePage />} />
            </Routes>
          </Suspense>
        </MemoryRouter>
      );
    });
    const first = guide.careSources[0]!;
    expect(first.url.startsWith('https://')).toBe(true);
    const link = screen.getAllByRole('link').find((a) => a.getAttribute('href') === first.url);
    expect(link).toBeDefined();
    expect(screen.queryByRole('link', { name: 'this page' })).toBeNull();
  });
});
