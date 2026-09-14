#!/usr/bin/env node
/**
 * Re-derive the free plan's caps wherever public copy states them.
 *
 * The Seedling caps — one home, 3 members, 20 plants — are the most-repeated
 * numbers in the product. They appear in the page metadata, the PWA manifest,
 * the SEO catalog, the landing page, the care index, the blog footer CTA and
 * inside two blog posts: fifteen statements across eight files, every one of
 * them typed by hand, none of them derived from `backend/src/models/plans.ts`
 * where the caps actually live.
 *
 * They have already moved once. `#422` raised the plant cap from 10 to 20 and
 * `frontend/scripts/check-brand-assets.mjs` still carries the note about it;
 * the re-cut in ADR 0014 moved members from 6 to 3 and plants on Garden from
 * 500 to 200 at the same time. Each of those moves was a hand-edit across
 * every surface below, with nothing to say whether one had been missed — and
 * the only reason this gate could be written is that they all happen to agree
 * today. `docs/billing.md` did NOT agree: five of its six cap figures were
 * stale while real cards were being charged, which is why
 * `scripts/check-doc-figures.mjs` re-derives that table. This is the same
 * remedy pointed at the copy a prospective customer reads first.
 *
 * Every check fails in BOTH directions, exactly as check-doc-figures does: a
 * cap that moves in `plans.ts` fails here, and so does a sentence that is
 * reworded until it no longer states the cap. A check you can satisfy by
 * deleting the claim is a check that quietly stops checking.
 *
 * DELIBERATELY NOT COVERED, and why:
 *   - `frontend/src/features/pricing/**` and the `pricing.*` / `pricingStatus.*`
 *     catalog keys. The pricing surface states the same caps and should be
 *     added here — but it is being actively rewritten in another change, and a
 *     gate that pins sentences someone else is mid-edit on buys conflicts
 *     rather than truth. Add it when that settles.
 *   - `legal.terms.fromUs.plans`. Editing the Terms means moving their
 *     effective date, which is a deliberate act and not something a gate
 *     should provoke as a side effect of a cap change.
 *   - `frontend/src/features/help/**`, which has its own re-derivation in
 *     `backend/tests/unit/config/helpFigures.test.ts`.
 *
 * This script reads. It never rewrites copy to match: a gate that repairs its
 * own subject makes drift invisible instead of loud.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const read = (relative) => readFileSync(join(ROOT, relative), 'utf8');

/**
 * One `limits` field of one tier, read out of the catalog source.
 *
 * Parsed rather than imported because `plans.ts` is TypeScript in the backend
 * workspace and this gate runs from the repo root with no build step — the
 * same trade `check-doc-figures.mjs` makes for the same reason.
 */
const plansSource = read('backend/src/models/plans.ts');
function planLimit(tier, field) {
  const block = plansSource.match(
    new RegExp(`id: '${tier}'[\\s\\S]*?limits:\\s*\\{([\\s\\S]*?)\\}`)
  );
  if (block === null) {
    problems.push(`backend/src/models/plans.ts: no limits block for tier "${tier}".`);
    return null;
  }
  const value = block[1].match(new RegExp(`\\b${field}:\\s*([A-Za-z0-9_]+)`));
  if (value === null) {
    problems.push(`backend/src/models/plans.ts: tier "${tier}" has no \`${field}\` limit.`);
    return null;
  }
  return value[1];
}

const plants = planLimit('seedling', 'plants');
const members = planLimit('seedling', 'members');
const homes = planLimit('seedling', 'homes');

/**
 * The public statements of those caps.
 *
 * `{plants}` / `{members}` are substituted from the catalog above, so the
 * expected text is derived and only the SENTENCE is written down here.
 * Whitespace is normalized on both sides before comparing, because Prettier
 * line-wraps the JSX and the same sentence therefore carries different
 * whitespace in different files.
 */
const SURFACES = [
  ['frontend/index.html', 'one home, up to {members} people and {plants} plants', 1],
  ['frontend/index.html', 'Free for up to {plants} plants', 2],
  ['frontend/src/config/seo.ts', 'one home, up to {members} people and {plants} plants', 1],
  ['frontend/src/config/seo.ts', 'Free for up to {plants} plants', 2],
  ['frontend/vite.config.ts', 'free accounts for up to {plants} plants', 1],
  ['frontend/src/features/landing/LandingPage.tsx', 'Up to {plants} plants', 1],
  ['frontend/src/features/landing/LandingPage.tsx', "value: '{members} people'", 1],
  [
    'frontend/src/features/landing/LandingPage.tsx',
    'one home, up to {members} people and {plants} plants',
    1,
  ],
  [
    'frontend/src/features/landing/LandingPage.tsx',
    'Free for one home, up to {members} household members and {plants} plants',
    1,
  ],
  [
    'frontend/src/features/landing/planBand.ts',
    'one home, up to {members} people and {plants} plants',
    1,
  ],
  [
    'frontend/src/features/landing/planBand.ts',
    'one home, up to {members} household members and {plants} plants',
    1,
  ],
  ['frontend/src/features/care/CareIndex.tsx', 'Free for up to {plants} plants', 1],
  [
    'frontend/src/features/blog/BlogPost.tsx',
    'Free for one home, up to {members} household members and {plants} plants',
    1,
  ],
  [
    'frontend/src/features/blog/posts/remembering-to-water.tsx',
    'free for one home with up to {members} people and {plants} plants',
    1,
  ],
  [
    'frontend/src/features/blog/posts/sharing-plant-care.tsx',
    'free for one home with up to {members} people and {plants} plants',
    1,
  ],
];

const flatten = (text) => text.replace(/\s+/g, ' ');

if (plants !== null && members !== null) {
  for (const [file, template, expected] of SURFACES) {
    const sentence = flatten(template.replace('{plants}', plants).replace('{members}', members));
    const found = flatten(read(file)).split(sentence).length - 1;
    if (found !== expected) {
      problems.push(
        `${file}: expected ${expected} statement(s) of "${sentence}", found ${found}. ` +
          `Either the free-plan caps moved in backend/src/models/plans.ts and this copy still ` +
          `states the old ones, or the sentence was reworded away from the cap it promises. ` +
          `Fix the copy, or update this gate deliberately, in the same change.`
      );
    }
  }
}

// The free tier is "one home" in prose everywhere above. If that ever stops
// being 1, every one of those sentences is wrong in a way no cap number can
// express, so it is checked separately rather than substituted.
if (homes !== null && homes !== '1') {
  problems.push(
    `backend/src/models/plans.ts: the free tier now allows ${homes} homes, but the public copy ` +
      `says "one home" in ${SURFACES.length} places. Rewrite those sentences in this change.`
  );
}

if (problems.length > 0) {
  console.error('\n❌ Public copy no longer matches the free plan it describes:\n');
  for (const p of problems) console.error(`   ${p}`);
  console.error('\nFix the copy, not this gate.');
  process.exit(1);
}

console.log(
  `Plan copy OK — ${SURFACES.length} public statements of the free plan (${homes} home, ` +
    `${members} members, ${plants} plants) re-derived from backend/src/models/plans.ts.`
);
