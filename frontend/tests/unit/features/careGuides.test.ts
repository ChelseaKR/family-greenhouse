import { describe, expect, it } from 'vitest';
import { CARE_GUIDES, findCareGuide } from '@/features/care/careGuides';
import { careToxicity, careToxicityFrom } from '@/features/care/careToxicity';
import { PET_TOXICITY } from '../../../../backend/src/models/petToxicity';
import { petSafetyLevel } from '@/features/petsafe/petSafeSpecies';

/**
 * Shape + integrity test for the programmatic species care pages
 * (`/care/:slug`). These pages are pure content data rendered by one
 * template, so the registry is the thing worth guarding: a malformed entry
 * ships a broken SEO page, and a wrong `toxicity` line does real harm to a
 * pet owner who trusts it.
 */
describe('CARE_GUIDES registry', () => {
  it('has no duplicate slugs', () => {
    const slugs = CARE_GUIDES.map((g) => g.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('uses kebab-case slugs', () => {
    for (const g of CARE_GUIDES) {
      expect(g.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it('findCareGuide resolves every slug and rejects unknown ones', () => {
    for (const g of CARE_GUIDES) {
      expect(findCareGuide(g.slug)).toBe(g);
    }
    expect(findCareGuide('not-a-real-plant')).toBeUndefined();
  });

  it('every guide has the full content shape filled in', () => {
    for (const g of CARE_GUIDES) {
      expect(g.commonName.length).toBeGreaterThan(0);
      expect(g.scientificName.length).toBeGreaterThan(0);
      expect(g.metaTitle.length).toBeGreaterThan(0);
      expect(g.metaDescription.length).toBeGreaterThan(0);
      // ISO date the facts were last checked — drives `datePublished`.
      expect(g.reviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // ISO date the content last changed — drives `dateModified`,
      // `article:modified_time` and the sitemap's `<lastmod>`.
      expect(g.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(g.summary.length).toBeGreaterThan(20);

      for (const fact of Object.values(g.quickFacts)) {
        expect(fact.length).toBeGreaterThan(0);
      }

      for (const section of Object.values(g.sections)) {
        expect(Array.isArray(section)).toBe(true);
        expect(section.length).toBeGreaterThan(0);
        for (const para of section) {
          expect(para.length).toBeGreaterThan(20);
        }
      }

      expect(g.faqs.length).toBeGreaterThan(0);
      for (const faq of g.faqs) {
        expect(faq.q.length).toBeGreaterThan(0);
        expect(faq.a.length).toBeGreaterThan(0);
      }
    }
  });

  it('every guide’s pet line opens with the verdict its cited source gives', () => {
    // The toxicity quick-fact is the line a pet owner trusts, and the
    // /pet-safe directory badges it by its opening words. It must say what
    // the ASPCA listing says, or "Unknown" when there is no cited verdict:
    // never a verdict nobody can trace.
    for (const g of CARE_GUIDES) {
      const { claims } = careToxicity(g);
      const level = petSafetyLevel(g.quickFacts.toxicity);
      const states = new Set([claims.cats.state, claims.dogs.state]);
      if (states.has('not-assessed')) {
        expect(g.quickFacts.toxicity, g.slug).toMatch(/^Unknown\b/);
        expect(level, g.slug).toBe('unclear');
      } else if (states.size === 1 && states.has('toxic')) {
        expect(['toxic', 'caution'], g.slug).toContain(level);
      } else if (states.size === 1 && states.has('non-toxic')) {
        expect(level, g.slug).toBe('safe');
      } else {
        // Mixed verdicts have no single opening word; none exist today.
        expect(level, g.slug).toBe('unclear');
      }
    }
  });

  it('has no hand-written pet-toxicity FAQ (the page generates the cited one)', () => {
    for (const g of CARE_GUIDES) {
      for (const faq of g.faqs) {
        expect(faq.q, `${g.slug}: ${faq.q}`).not.toMatch(/toxic|poison|safe for|pet-safe/i);
      }
    }
  });

  it('makes no pet verdict in the prose of a guide with no cited verdict', () => {
    // ZZ plant has no ASPCA listing. Its prose used to call it toxic from
    // general knowledge; the page now says "Unknown" and the prose must not
    // contradict that in either direction. Link anchors are stripped first,
    // so "[free pet-safe checker](/pet-safe)" is not read as a verdict.
    const unknown = CARE_GUIDES.filter((g) => !careToxicity(g).sourced);
    expect(unknown.map((g) => g.slug)).toEqual(['zz-plant']);
    for (const g of unknown) {
      const prose = [
        g.summary,
        g.metaTitle,
        g.metaDescription,
        ...Object.values(g.sections).flat(),
        ...g.faqs.flatMap((f) => [f.q, f.a]),
      ].map((t) => t.replace(/\[[^\]]*\]\([^)]*\)/g, ''));
      for (const text of prose) {
        expect(text, g.slug).not.toMatch(
          /\b(non-toxic|toxic|poisonous|pet-safe|calcium oxalate|safe for (cats|dogs|pets))\b/i
        );
      }
    }
  });

  it('lists three related guides that exist, excluding itself', () => {
    for (const g of CARE_GUIDES) {
      expect(g.related, g.slug).toHaveLength(3);
      expect(new Set(g.related).size, g.slug).toBe(3);
      expect(g.related, g.slug).not.toContain(g.slug);
      for (const slug of g.related) {
        expect(findCareGuide(slug), `${g.slug} -> ${slug}`).toBeDefined();
      }
    }
  });

  it('every related guide is linked from at least one other guide', () => {
    // The rotation this replaced guaranteed every guide an inbound sibling
    // link; curation must not quietly orphan one.
    const linked = new Set(CARE_GUIDES.flatMap((g) => g.related));
    for (const g of CARE_GUIDES) {
      expect(linked.has(g.slug), `${g.slug} has no inbound related link`).toBe(true);
    }
  });

  it('keeps titles and descriptions within what search results display', () => {
    for (const g of CARE_GUIDES) {
      expect(g.metaTitle.length, g.slug).toBeLessThanOrEqual(60);
      expect(g.metaDescription.length, g.slug).toBeGreaterThanOrEqual(70);
      expect(g.metaDescription.length, g.slug).toBeLessThanOrEqual(160);
    }
  });

  it('is written in American English', () => {
    const text = JSON.stringify(CARE_GUIDES);
    expect(text).not.toMatch(
      /\b(colour\w*|ageing|draughts?|draughty|diarrhoea|humour|fertiliser|behaviour|centre|metre|realise)\b/i
    );
  });
});

/**
 * Guide prose supports one inline construct, `[text](/path)`, rendered by
 * `withLinks` in CareGuidePage. Before it existed, twelve entries wrote "the
 * free pet-safe checker at /pet-safe" and the reader saw those characters
 * verbatim: the copy promised a link and the DOM had no anchor, so the
 * highest-intent page on the site got nothing from the 24 pages likeliest to
 * feed it.
 */
describe('inline links in guide prose', () => {
  const proseOf = (g: (typeof CARE_GUIDES)[number]) => [
    ...g.sections.watering,
    ...g.sections.light,
    ...g.sections.problems,
    ...g.sections.sharedCare,
    ...g.sections.honestBit,
    ...g.faqs.map((f) => f.a),
  ];

  it('never leaves a bare internal path in prose, which renders as literal text', () => {
    for (const guide of CARE_GUIDES) {
      for (const text of proseOf(guide)) {
        // A path not preceded by "](" is one no anchor will wrap.
        const bare = text.match(/(?<!]\()\/(?:pet-safe|care|blog|help|pricing)\b/g);
        expect(bare, `${guide.slug} has an unlinked path: ${bare?.join(', ')}`).toBeNull();
      }
    }
  });

  it('links /pet-safe from every guide that discusses pet toxicity', () => {
    const linked = CARE_GUIDES.filter((g) => proseOf(g).some((t) => t.includes('](/pet-safe)')));
    expect(linked.length).toBeGreaterThan(0);
    for (const guide of linked) {
      const withLink = proseOf(guide).find((t) => t.includes('](/pet-safe)'))!;
      // Descriptive anchor text, not "here" or a bare path.
      expect(withLink).toMatch(/\[free pet-safe (?:checker|tool)\]\(\/pet-safe\)/);
    }
  });
});

/**
 * `reviewed` and `updated` answer different questions and must not collapse
 * back into one. Six guides shipped a `<lastmod>` and a `dateModified` 80
 * days behind their own content because a single field was serving both.
 */
describe('CARE_GUIDES content dates', () => {
  it('never dates a change before the review it followed', () => {
    // A guide is reviewed, then edited — so `updated` is the review date or
    // later, never earlier. An earlier one means somebody mistyped a date or
    // reused the wrong field.
    for (const g of CARE_GUIDES) {
      expect(
        g.updated >= g.reviewed,
        `${g.slug}: updated ${g.updated} predates reviewed ${g.reviewed}`
      ).toBe(true);
    }
  });

  it('dates no guide in the future', () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const g of CARE_GUIDES) {
      expect(g.updated <= today, `${g.slug}: updated ${g.updated} is in the future`).toBe(true);
      expect(g.reviewed <= today, `${g.slug}: reviewed ${g.reviewed} is in the future`).toBe(true);
    }
  });

  it('still records the drift the split was introduced to fix', () => {
    // If this ever drops to zero, either every guide was genuinely re-reviewed
    // after its last edit — or somebody "tidied" `updated` back onto
    // `reviewed` and re-created the bug. Six guides are known to have been
    // edited (#649, #651) long after their last review.
    const drifted = CARE_GUIDES.filter((g) => g.updated !== g.reviewed);
    expect(drifted.length).toBeGreaterThanOrEqual(6);
  });
});

/**
 * The three guides expanded for the queries that reach them (aloe vera,
 * anthurium, bird of paradise). Pins the pieces a later edit could quietly
 * drop: the questions people type, the links to each guide's own pet-safety
 * page, the hotline wording, and an inbound link from a sibling guide.
 */
describe('near-page-one guides', () => {
  const NEAR = {
    'aloe-vera': [
      'How do I know when my aloe vera needs water?',
      'Does an aloe vera need direct sun?',
    ],
    anthurium: [
      'Why is my anthurium not flowering, or why has it stopped?',
      'When do anthuriums bloom, and how long do the flowers last?',
      'Why are my anthurium flowers fading or dying?',
    ],
    'bird-of-paradise': [
      'How much light does a bird of paradise need indoors?',
      'Which plant does this guide cover when people say “bird of paradise”?',
    ],
  } as const;

  for (const [slug, questions] of Object.entries(NEAR)) {
    it(`${slug}: answers the expanded questions and links its pet-safety page`, () => {
      const g = findCareGuide(slug)!;
      const asked = g.faqs.map((f) => f.q);
      for (const q of questions) expect(asked, `${slug}: ${q}`).toContain(q);
      const pet = g.sections.honestBit.join(' ');
      expect(pet).toContain(`](/pet-safe/${slug})`);
      expect(pet).toMatch(/call your vet or a poison hotline/);
    });

    it(`${slug}: is linked in prose from another guide`, () => {
      const inbound = CARE_GUIDES.filter(
        (o) =>
          o.slug !== slug &&
          [...Object.values(o.sections).flat(), ...o.faqs.map((f) => f.a)].some((t) =>
            t.includes(`](/care/${slug})`)
          )
      );
      expect(inbound.length, `${slug} has no inline link from a sibling guide`).toBeGreaterThan(0);
    });
  }

  it('never says the aloe gel is fine for pets', () => {
    const g = findCareGuide('aloe-vera')!;
    const all = JSON.stringify(g);
    expect(all).not.toMatch(/gel is fine|not the inner gel/i);
  });
});

/**
 * The four guides added for the pet-safety search test (2026-10-21). Each is
 * a plant the curated table already cites with its own ASPCA listing; no
 * plant without one was added (ZZ plant stays "Unknown"). Pins the pieces the
 * test is judged on: unique titles and descriptions inside the display
 * limits, the one-sentence household angle, a cited verdict, and inbound
 * links from guides that already exist.
 */
describe('pet-safety test guides', () => {
  const TEST_SLUGS = ['african-violet', 'poinsettia', 'sago-palm', 'asparagus-fern'] as const;
  const guides = TEST_SLUGS.map((slug) => findCareGuide(slug)!);

  it('publishes all four', () => {
    for (const [i, slug] of TEST_SLUGS.entries()) {
      expect(guides[i], slug).toBeDefined();
    }
  });

  it('has titles under 60 and descriptions under 155 characters, unique across all guides', () => {
    for (const g of guides) {
      expect(g.metaTitle.length, g.slug).toBeLessThanOrEqual(60);
      expect(g.metaDescription.length, g.slug).toBeGreaterThanOrEqual(70);
      expect(g.metaDescription.length, g.slug).toBeLessThanOrEqual(155);
    }
    const titles = CARE_GUIDES.map((g) => g.metaTitle);
    const descriptions = CARE_GUIDES.map((g) => g.metaDescription);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it('opens the shared-care section with a single household sentence', () => {
    for (const g of guides) {
      const first = g.sections.sharedCare[0]!;
      expect(first, g.slug).toMatch(/^[^.!?]+[.!?]$/);
      expect(first, g.slug).toMatch(/\b(shared home|household|house|housemate)/i);
    }
  });

  it('is fully cited: both animals have a verdict from the plant’s own ASPCA listing', () => {
    for (const g of guides) {
      const view = careToxicity(g);
      expect(view.sourced, g.slug).toBe(true);
      expect(view.claims.cats.state, g.slug).not.toBe('not-assessed');
      expect(view.claims.dogs.state, g.slug).not.toBe('not-assessed');
      expect(view.petSafePath, g.slug).toBe(`/pet-safe/${g.slug}`);
      // The pet line opens with the cited verdict word.
      const expected = view.claims.cats.state === 'non-toxic' ? 'safe' : 'toxic';
      expect(petSafetyLevel(g.quickFacts.toxicity), g.slug).toBe(expected);
    }
  });

  it('is linked in prose and in a related list from a guide that existed before', () => {
    for (const g of guides) {
      const others = CARE_GUIDES.filter(
        (o) => o.slug !== g.slug && !TEST_SLUGS.includes(o.slug as never)
      );
      const prose = others.filter((o) =>
        [...Object.values(o.sections).flat(), ...o.faqs.map((f) => f.a)].some((t) =>
          t.includes(`](/care/${g.slug})`)
        )
      );
      expect(prose.length, `${g.slug}: no inline link from an older guide`).toBeGreaterThan(0);
      const related = others.filter((o) => o.related.includes(g.slug));
      expect(related.length, `${g.slug}: not in an older guide’s related list`).toBeGreaterThan(0);
    }
  });

  it('negative control: dropping a plant’s listing makes the same check fail', () => {
    const real = PET_TOXICITY.find((e) => e.slug === 'sago-palm')!;
    const broken = { ...real, aspcaListing: undefined };
    // The sabotage landed: the copy of the row has no listing, the real one does.
    expect(broken.aspcaListing).toBeUndefined();
    expect(real.aspcaListing).toBeDefined();
    const sabotaged = PET_TOXICITY.map((e) => (e.slug === 'sago-palm' ? broken : e));
    const view = careToxicityFrom(findCareGuide('sago-palm')!, sabotaged as never);
    expect(view.sourced).toBe(false);
    expect(view.claims.cats.state).toBe('not-assessed');
  });

  it('negative control: the unsourced guide is still the only one, so nothing was added without a source', () => {
    const unsourced = CARE_GUIDES.filter((g) => !careToxicity(g).sourced).map((g) => g.slug);
    expect(unsourced).toEqual(['zz-plant']);
  });
});

/**
 * The five guides added in the third batch (2026-10-22), one for each row the
 * curated table cites with its own ASPCA listing that had no guide, except jasmine,
 * left out because its sources are not extension pages. Only the
 * pet verdicts are cited from the table; the care prose is written from the
 * university extension and botanic garden sources named in the pull request.
 * Lily is the first guide whose cats and dogs verdicts differ, so its pet line
 * has no single opening word and the checks below handle it on its own.
 */
describe('third-batch pet-safety guides', () => {
  const BATCH3 = ['haworthia', 'burros-tail', 'blue-echeveria', 'begonia', 'lily'] as const;
  const guides = BATCH3.map((slug) => findCareGuide(slug)!);
  const rowOf = (slug: string) => PET_TOXICITY.find((e) => e.slug === slug)!;
  const mixed = (slug: string) => rowOf(slug).cats !== rowOf(slug).dogs;

  /** What the table’s note names for the two toxic rows, repeated as the table words it. */
  const SIGNS: Record<string, readonly string[]> = {
    begonia: [
      'soluble calcium oxalates',
      'vomiting and drooling',
      'the most toxic part is underground',
    ],
    lily: ['kidney failure'],
  };

  /** True when the guide’s pet paragraph repeats every sign the table’s note names. */
  const repeatsTableSigns = (honestBit: string[], slug: string) =>
    SIGNS[slug]!.every((sign) => honestBit.join(' ').includes(sign));

  it('publishes all five', () => {
    for (const [i, slug] of BATCH3.entries()) {
      expect(guides[i], slug).toBeDefined();
    }
  });

  it('has titles under 60 and descriptions under 155 characters, unique across all guides', () => {
    for (const g of guides) {
      expect(g.metaTitle.length, g.slug).toBeLessThanOrEqual(60);
      expect(g.metaDescription.length, g.slug).toBeGreaterThanOrEqual(70);
      expect(g.metaDescription.length, g.slug).toBeLessThan(155);
      expect(g.reviewed, g.slug).toBe('2026-10-22');
      expect(g.updated, g.slug).toBe('2026-10-22');
    }
    const titles = CARE_GUIDES.map((g) => g.metaTitle);
    const descriptions = CARE_GUIDES.map((g) => g.metaDescription);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it('opens the shared-care section with a single household sentence', () => {
    for (const g of guides) {
      const first = g.sections.sharedCare[0]!;
      expect(first, g.slug).toMatch(/^[^.!?]+[.!?]$/);
      expect(first, g.slug).toMatch(/\b(shared home|household|house|housemate)/i);
    }
  });

  it('is fully cited: both animals have the table’s verdict from the plant’s own ASPCA listing', () => {
    for (const g of guides) {
      const view = careToxicity(g);
      const row = rowOf(g.slug);
      expect(row.aspcaListing, g.slug).toBeDefined();
      expect(view.sourced, g.slug).toBe(true);
      expect(view.petSafePath, g.slug).toBe(`/pet-safe/${g.slug}`);
      expect(view.claims.cats.state, g.slug).toBe(row.cats);
      expect(view.claims.dogs.state, g.slug).toBe(row.dogs);
      // The summary says the table’s verdict for each animal, not another one.
      const said = mixed(g.slug)
        ? `${row.cats} to cats and ${row.dogs} to dogs`
        : `${row.cats} to cats and dogs`;
      expect(g.summary, g.slug).toMatch(
        new RegExp(`ASPCA lists (it|this species|lilies) as ${said}`)
      );
    }
  });

  it('opens each pet line with the cited verdict, and gives the mixed row no single verdict word', () => {
    for (const g of guides) {
      const row = rowOf(g.slug);
      const level = petSafetyLevel(g.quickFacts.toxicity);
      if (mixed(g.slug)) {
        expect(level, g.slug).toBe('unclear');
        expect(g.quickFacts.toxicity, g.slug).toMatch(/^Cats: toxic\b/);
        expect(g.quickFacts.toxicity, g.slug).toMatch(/Dogs: non-toxic/);
      } else {
        expect(level, g.slug).toBe(row.cats === 'toxic' ? 'toxic' : 'safe');
      }
    }
  });

  it('repeats the signs the table’s own note names for the two toxic rows', () => {
    for (const slug of Object.keys(SIGNS)) {
      const g = findCareGuide(slug)!;
      // Anchor the test to the table, so editing the row cannot silently pass.
      for (const sign of SIGNS[slug]!) {
        expect(rowOf(slug).note, `${slug}: ${sign}`).toContain(sign);
      }
      expect(repeatsTableSigns(g.sections.honestBit, slug), slug).toBe(true);
      expect(g.sections.honestBit.join(' '), slug).toMatch(/call your vet or a poison hotline/);
    }
  });

  it('keeps the non-toxic caveat on the three non-toxic rows', () => {
    for (const g of guides.filter((x) => rowOf(x.slug).cats === 'non-toxic')) {
      expect(g.sections.honestBit.join(' '), g.slug).toContain(
        'Non-toxic is not the same as safe to eat in quantity'
      );
    }
  });

  it('links each guide’s own pet-safety page and the free checker', () => {
    for (const g of guides) {
      const pet = g.sections.honestBit.join(' ');
      expect(pet, g.slug).toContain(`](/pet-safe/${g.slug})`);
      expect(pet, g.slug).toContain('[free pet-safe checker](/pet-safe)');
    }
  });

  it('makes no superlatives and no "safe for pets" or "mildly toxic" claim', () => {
    for (const g of guides) {
      const prose = JSON.stringify(g);
      expect(prose, g.slug).not.toMatch(/\b(only|best|unique)\b/i);
      expect(prose, g.slug).not.toMatch(/\b(mildly toxic|safe for (cats|dogs|pets))\b/i);
    }
  });

  it('is linked in prose and in a related list from a guide that existed before', () => {
    for (const g of guides) {
      const others = CARE_GUIDES.filter((o) => !BATCH3.includes(o.slug as never));
      const prose = others.filter((o) =>
        [...Object.values(o.sections).flat(), ...o.faqs.map((f) => f.a)].some((t) =>
          t.includes(`](/care/${g.slug})`)
        )
      );
      expect(prose.length, `${g.slug}: no inline link from an older guide`).toBeGreaterThan(0);
      const related = others.filter((o) => o.related.includes(g.slug));
      expect(related.length, `${g.slug}: not in an older guide’s related list`).toBeGreaterThan(0);
      // A guide that gained a link must carry the ship date, or a later edit,
      // in its sitemap lastmod. Pinning the exact date failed the next edit
      // to the guide, which has to move `updated` forward.
      for (const o of [...prose, ...related]) {
        expect(o.updated >= '2026-10-22', `${o.slug} gained a link to ${g.slug}`).toBe(true);
      }
    }
  });

  it('negative control: dropping a plant’s listing makes the same check fail', () => {
    const real = rowOf('begonia');
    const broken = { ...real, aspcaListing: undefined };
    // The sabotage landed: the copy of the row has no listing, the real one does.
    expect(broken.aspcaListing).toBeUndefined();
    expect(real.aspcaListing).toBeDefined();
    const sabotaged = PET_TOXICITY.map((e) => (e.slug === 'begonia' ? broken : e));
    const view = careToxicityFrom(findCareGuide('begonia')!, sabotaged as never);
    expect(view.sourced).toBe(false);
    expect(view.claims.cats.state).toBe('not-assessed');
  });

  it('negative control: a listing that disagrees for dogs leaves cats cited and dogs not assessed', () => {
    const real = rowOf('lily');
    const listing = real.aspcaListing!;
    const broken = {
      ...real,
      aspcaListing: { ...listing, listed: { cats: 'toxic', dogs: 'toxic' } },
    };
    // The sabotage landed: the copy's listing now disagrees for dogs, the real one does not.
    expect(broken.aspcaListing.listed.dogs).toBe('toxic');
    expect(listing.listed.dogs).toBe('non-toxic');
    const sabotaged = PET_TOXICITY.map((e) => (e.slug === 'lily' ? broken : e));
    const view = careToxicityFrom(findCareGuide('lily')!, sabotaged as never);
    expect(view.claims.cats.state).toBe('toxic');
    expect(view.claims.dogs.state).toBe('not-assessed');
    expect(view.sourced).toBe(false);
  });

  it('negative control: a guide that drops a sign the table names fails the sign check', () => {
    const real = findCareGuide('lily')!;
    expect(repeatsTableSigns(real.sections.honestBit, 'lily')).toBe(true);
    const doctored = real.sections.honestBit.map((p) => p.replaceAll('kidney failure', 'illness'));
    // The sabotage landed: the sign is gone from the copy and still in the real guide.
    expect(doctored.join(' ')).not.toContain('kidney failure');
    expect(real.sections.honestBit.join(' ')).toContain('kidney failure');
    expect(repeatsTableSigns(doctored, 'lily')).toBe(false);
  });

  it('negative control: the unsourced guide is still the only one, so nothing was added without a source', () => {
    const unsourced = CARE_GUIDES.filter((g) => !careToxicity(g).sourced).map((g) => g.slug);
    expect(unsourced).toEqual(['zz-plant']);
  });
});
