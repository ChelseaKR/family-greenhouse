import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLANS } from '../../../src/models/plans.js';
import { IDENTIFY_ALLOWANCES } from '../../../src/services/identifyBudget.js';

/**
 * The help pages state plan figures, and every one of them is typed by hand.
 *
 * `frontend/src/features/help/helpContent.tsx` imports nothing from the
 * backend — it is 1,200 lines of prose with the numbers written into the
 * sentences — so a cap that moves in `plans.ts` leaves the help page saying the
 * old one, in public, with a URL that ships in support replies. That is not
 * hypothetical: this file's leaf-health answer said "200 checks per household
 * per calendar month" while production had capped the free tier at 20 for
 * months, and #618 had already fixed the same class of drift here once.
 *
 * So the numbers are re-derived from the things that set them:
 *
 *   - `PLANS` in models/plans.ts — the structural caps.
 *   - `IDENTIFY_ALLOWANCES` in services/identifyBudget.ts — the monthly
 *     identification budget.
 *   - `infrastructure/environments/production/terraform.tfvars` and
 *     `leafHealthBudget.DEFAULT_MONTHLY_CAP` — the leaf-health caps, which are
 *     environment variables rather than code constants, so the deployed value
 *     is the only one a reader of the help page experiences.
 *
 * Both directions, like `scripts/check-doc-figures.mjs`: a changed cap fails,
 * and so does a sentence that stops stating the figure at all. A help page
 * that quietly drops the number is not a help page that got safer.
 */

const ROOT = new URL('../../../../', import.meta.url);
const help = readFileSync(new URL('frontend/src/features/help/helpContent.tsx', ROOT), 'utf8');
const prodTfvars = readFileSync(
  new URL('infrastructure/environments/production/terraform.tfvars', ROOT),
  'utf8'
);
const leafHealthSource = readFileSync(
  new URL('backend/src/services/leafHealthBudget.ts', ROOT),
  'utf8'
);

/**
 * Occurrences of `needle` in the help copy, whitespace-normalized first.
 *
 * Every figure appears twice — in the rendered `a` and in its plain-text twin —
 * but the JSX version is line-wrapped by Prettier, so the same sentence carries
 * different whitespace in the two places. Comparing against the flattened
 * source is what lets one expectation cover both, which is also what makes
 * "exactly 2" meaningful: it is the file's own rule that `a` and `text` say the
 * same thing.
 */
const helpFlat = help.replace(/\s+/g, ' ');
const occurrences = (needle: string) => helpFlat.split(needle.replace(/\s+/g, ' ')).length - 1;

/**
 * A tfvars override, or undefined when it is blank. Terraform passes "" to mean
 * "inherit", which `leafHealthBudget.parseCap` treats as unset.
 */
function tfvar(name: string): string | undefined {
  const match = prodTfvars.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm'));
  const raw = match?.[1];
  return raw === undefined || raw === '' ? undefined : raw;
}

describe('help pages: the plan caps they state', () => {
  it('states the free tier as one home, 3 members and 20 plants', () => {
    const seedling = PLANS.seedling.limits;
    expect(seedling.homes).toBe(1);
    expect(
      occurrences(`one home, up to ${seedling.members} members and ${seedling.plants} plants`),
      'the whats-free answer must state the free caps, re-derived from plans.ts'
    ).toBe(2);
  });

  it('states all three plant caps', () => {
    const caps = `The caps are ${PLANS.seedling.limits.plants} plants on the free Seedling plan, ${PLANS.garden.limits.plants} on Garden and ${PLANS.greenhouse.limits.plants.toLocaleString('en-US')} on Greenhouse.`;
    expect(occurrences(caps), 'the plant-limit answer must state all three caps').toBe(2);
  });

  it('states the free sitter window and the paid one', () => {
    // Free is one link of up to 7 days; both paid tiers reach 90.
    expect(PLANS.garden.limits.sitterLinkMaxDays).toBe(PLANS.greenhouse.limits.sitterLinkMaxDays);
    const free = PLANS.seedling.limits.sitterLinkMaxDays;
    const paid = PLANS.garden.limits.sitterLinkMaxDays;
    expect(
      occurrences(`up to ${free} days on the free`),
      'the sitter answers must state the free window'
    ).toBeGreaterThan(0);
    expect(
      occurrences(`up to ${paid} on`) + occurrences(`at most ${paid} on`),
      'the sitter answers must state the paid window'
    ).toBeGreaterThan(0);
  });
});

describe('help pages: the metered allowances they state', () => {
  it('states the monthly identification allowance for every tier', () => {
    const { seedling, garden, greenhouse } = IDENTIFY_ALLOWANCES;
    expect(
      occurrences(
        `${seedling} identification on Seedling, ${garden} on Garden, ${greenhouse} on Greenhouse`
      ),
      'the identify-photo answer must state all three allowances'
    ).toBe(2);
  });

  it('states the leaf-health caps that production actually enforces', () => {
    // The flat default lives in code; the free tier's override lives in the
    // production tfvars. A reader on Seedling gets the override, so that is
    // the number the page has to carry.
    const codeDefault = leafHealthSource.match(/DEFAULT_MONTHLY_CAP = (\d+)/)?.[1];
    expect(codeDefault, 'DEFAULT_MONTHLY_CAP was renamed or removed').toBeDefined();

    const flat = tfvar('leaf_health_monthly_cap') ?? codeDefault;
    const paid = tfvar('leaf_health_monthly_cap_garden') ?? flat;
    const free = tfvar('leaf_health_monthly_cap_seedling') ?? flat;

    // The sentence only makes sense while the two differ. If production ever
    // levels them, this fails and the sentence should become one number.
    expect(free, 'production no longer gives Seedling its own leaf-health cap').not.toBe(paid);
    expect(
      occurrences(`${paid} checks on Garden and Greenhouse, ${free} on the free Seedling plan`),
      'the leaf-health answer must state both caps, re-derived from the production tfvars'
    ).toBe(2); // once in the rendered answer, once in its `text` twin
  });
});
