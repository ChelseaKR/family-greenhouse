import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { POSTS } from '@/features/blog/posts';
import { PET_TOXICITY, citedVerdict } from '../../../../backend/src/models/petToxicity';

/**
 * ADR 0011: a pet-safety claim needs a cited listing. The blog is prose, so
 * nothing stopped a post from stating a verdict the pet-safety table cannot
 * cite. 'pet-safe-hard-to-kill' called the ZZ plant "toxic to cats and dogs"
 * while its care page and the checker said "Unknown" (the ASPCA list has no
 * ZZ entry).
 *
 * The rule here: any sentence in a blog post that names a plant whose table
 * row has NO cited verdict for cats or dogs must not state a verdict (toxic,
 * non-toxic, poisonous, safe for, pet-safe, pet-friendly, harmless) unless the
 * same sentence says plainly that there is no verdict.
 */

const VERDICT_WORDS =
  /\b(non-?toxic|toxic|poisonous|harmless|pet-safe|pet-friendly|(?:un)?safe (?:for|around))\b/i;
const NO_VERDICT_PHRASES =
  /\b(no entry|no verdict|no cited|not assessed|unknown|don['’]t (?:publish|give)|can['’]t tell|cannot tell|can['’]t give)\b/i;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Plain text, with entities decoded and tags removed, split into sentences. */
function sentencesOf(html: string): string[] {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&rsquo;|&#x27;|&#39;/g, '’')
    .replace(/&ldquo;|&rdquo;|&quot;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
  return text.split(/(?<=[.!?])\s+(?=[A-Z("“])/).map((s) => s.trim());
}

type Names = { slug: string; patterns: RegExp[] }[];

/** Every name and alias of each row with no cited cat or dog verdict. */
function uncitedNames(): Names {
  return PET_TOXICITY.filter(
    (entry) =>
      citedVerdict(entry, 'cats') === 'unknown' || citedVerdict(entry, 'dogs') === 'unknown'
  ).map((entry) => ({
    slug: entry.slug,
    patterns: [entry.commonName, entry.scientificName, ...entry.aliases].map(
      (name) => new RegExp(`(^|[^a-z])${esc(name)}([^a-z]|$)`, 'i')
    ),
  }));
}

/** Sentences that name an uncited plant and state a verdict anyway. */
function unsupportedVerdicts(html: string, names: Names): string[] {
  const found: string[] = [];
  for (const sentence of sentencesOf(html)) {
    if (!VERDICT_WORDS.test(sentence) || NO_VERDICT_PHRASES.test(sentence)) continue;
    for (const { slug, patterns } of names) {
      if (patterns.some((p) => p.test(sentence))) found.push(`${slug}: ${sentence}`);
    }
  }
  return found;
}

// The listing copy (title, preview, SERP description) is read by people and
// crawlers before the post is, so it is held to the same rule as the body.
const rendered = POSTS.map((post) => {
  const Component = post.Component;
  const copy = [post.title, post.description, post.metaDescription ?? ''].join('. ');
  return {
    slug: post.slug,
    html: `<p>${copy}</p>${renderToStaticMarkup(<Component />)}`,
  };
});

describe('blog posts state no pet-safety verdict the table cannot cite', () => {
  const names = uncitedNames();

  it('the table still has an uncited row to protect (so the scan is not vacuous)', () => {
    expect(names.map((n) => n.slug)).toContain('zz-plant');
  });

  it('no blog post states a verdict for an uncited plant', () => {
    const offences = rendered.flatMap((post) =>
      unsupportedVerdicts(post.html, names).map((o) => `${post.slug} -> ${o}`)
    );
    expect(offences, offences.join('\n')).toEqual([]);
  });

  it('negative control: undoing the fix in the real post is caught', () => {
    const post = rendered.find((r) => r.slug === 'pet-safe-houseplants-that-are-hard-to-kill')!;
    const html = post.html.replace(/<!-- -->/g, '');
    expect(unsupportedVerdicts(html, names)).toEqual([]);
    const fixed =
      'but the ASPCA plant list has no entry for it, so we give it no verdict either way';
    // The sabotage must apply, or the pass below would prove nothing.
    expect(html).toContain(fixed);
    const sabotaged = html.replace(fixed, 'and it is toxic to cats and dogs');
    expect(sabotaged).not.toBe(html);
    expect(unsupportedVerdicts(sabotaged, names).length).toBeGreaterThanOrEqual(1);
  });

  it('negative control: the ZZ jade sentence from the old post is caught', () => {
    const old =
      '<p>Jade, ZZ, and the peace lilies that turn up in supermarket bouquets are all toxic.</p>';
    expect(unsupportedVerdicts(old, names).length).toBe(1);
  });

  it('positive controls: a cited plant, and a ZZ sentence that says there is no verdict, pass', () => {
    expect(unsupportedVerdicts('<p>Pothos is toxic to cats and dogs.</p>', names)).toEqual([]);
    expect(
      unsupportedVerdicts(
        '<p>The ASPCA plant list has no entry for the ZZ plant, so it is not toxic or safe on our say-so.</p>',
        names
      )
    ).toEqual([]);
  });
});
