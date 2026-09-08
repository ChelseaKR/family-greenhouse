import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  END,
  PROHIBITED_WHILE_OPEN,
  START,
  assertPatternsStillMatch,
  findProhibited,
  formatEffectiveDate,
  normalizeProse,
  proseOutsideBanner,
  renderBanner,
} from './check-commercial-status.mjs';

const OPEN = {
  commercialHoldActive: false,
  publicRegistrationAvailable: true,
  effectiveDate: '2026-09-01',
  publicMessage: 'Free account registration is open. Paid plans are available on the web.',
};

const HELD = { ...OPEN, commercialHoldActive: true, effectiveDate: '2026-07-14' };

/** The README as it stood on origin/main when #688 was filed, banner only. */
const README_BEFORE_688 = [
  '# Family Greenhouse',
  '',
  '> **Paid activity hold — July 14, 2026; free registration reopened July 19, 2026.**',
  '> Family Greenhouse accepts free accounts for one home with up to 3 people and 20 plants.',
  '> It is not currently accepting payments, offering paid plans, or generating',
  '> revenue. Pricing and billing material is retained as historical product-design',
  '> documentation.',
  '',
  '- **Plan architecture**: caps are enforced server-side; the historical Stripe',
  '  implementation remains in source, but payment creation is fail-closed during',
  '  the commercial hold',
  '',
].join('\n');

test('the date is formatted without Date or a locale, so a zone cannot move it', () => {
  assert.equal(formatEffectiveDate('2026-09-01'), 'September 1, 2026');
  assert.equal(formatEffectiveDate('2026-12-31'), 'December 31, 2026');
  // `new Date('2026-09-01').toLocaleDateString()` renders August 31 anywhere
  // west of Greenwich. This is the assertion that would catch a rewrite to it.
  assert.equal(formatEffectiveDate('2026-01-01'), 'January 1, 2026');
});

test('a malformed effectiveDate is refused rather than rendered', () => {
  for (const bad of ['', null, undefined, '2026-9-1', 'September 1, 2026', '2026-13-01']) {
    assert.throws(() => formatEffectiveDate(bad), /effectiveDate/);
  }
});

test('the banner carries the owner’s own publicMessage verbatim', () => {
  const banner = renderBanner(OPEN);
  assert.ok(banner.includes(OPEN.publicMessage));
  assert.ok(banner.startsWith(START));
  assert.ok(banner.endsWith(END));
});

test('the heading says a hold is on only when the JSON says so', () => {
  assert.match(renderBanner(HELD), /paid activity is on hold, effective July 14, 2026/i);
  assert.doesNotMatch(renderBanner(OPEN), /on hold/i);
});

test('a non-boolean hold flag is refused, so a typo cannot read as "open"', () => {
  assert.throws(() => renderBanner({ ...OPEN, commercialHoldActive: 'false' }), /boolean/);
  assert.throws(() => renderBanner({ ...OPEN, publicMessage: '  ' }), /publicMessage/);
});

test('every prohibited pattern still matches its own sample', () => {
  assert.doesNotThrow(() => assertPatternsStillMatch());
  // ...and the floor itself can fail, which is what makes the line above mean
  // anything.
  assert.throws(() => assertPatternsStillMatch([]), /empty/);
  assert.throws(
    () => assertPatternsStillMatch([{ pattern: /never/, sample: 'nothing here', why: 'x' }]),
    /no longer match/
  );
});

test('a phrase split across a blockquote line break is still found', () => {
  // The live sentence wrapped as "or generating\n> revenue", so `\s+` alone
  // matched nothing: the newline is whitespace and the `>` is not. Missing
  // this is what the first version of the check did.
  const wrapped = '> It is not currently accepting payments, or generating\n> revenue.';
  assert.doesNotMatch(wrapped, /or\s+generating\s+revenue/i);
  assert.match(normalizeProse(wrapped), /or\s+generating\s+revenue/i);
});

test('the README as it stood when #688 was filed fails every rule it should', () => {
  const found = findProhibited(README_BEFORE_688, OPEN);
  const reasons = found.map((entry) => entry.why).sort();
  assert.deepEqual(reasons, [
    'describes a hold that is not in force',
    'headlines a hold that has been lifted',
    'says the product does not take payments',
    'says the product earns nothing',
  ]);
});

test('the same prose is allowed while the hold is genuinely on', () => {
  assert.deepEqual(findProhibited(README_BEFORE_688, HELD), []);
});

test('prose inside the generated block is not searched, prose outside it is', () => {
  const inside = [START, '> not currently accepting payments', END, '', 'Ordinary prose.'].join(
    '\n'
  );
  assert.deepEqual(findProhibited(inside, OPEN), []);

  const outside = [START, '> anything', END, '', '> not currently accepting payments'].join('\n');
  assert.equal(findProhibited(outside, OPEN).length, 1);
});

test('a README with no markers is searched whole rather than throwing', () => {
  // Returning the whole file matters: if this threw, the missing markers would
  // hide the sentences, and a `--write` would insert a correct banner above
  // prose still asserting the opposite.
  assert.equal(proseOutsideBanner(README_BEFORE_688), README_BEFORE_688);
  assert.ok(findProhibited(README_BEFORE_688, OPEN).length > 0);
});

test('the committed README matches the committed JSON', () => {
  // The end-to-end assertion. `npm run commercial:check` is the gate; this
  // keeps the same fact inside `npm run test:checks`, so a broken banner is
  // caught by either.
  const status = JSON.parse(readFileSync('commercial-status.json', 'utf8'));
  const readme = readFileSync('README.md', 'utf8');
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  assert.ok(start !== -1 && end > start, 'README.md has no commercial-status block');
  assert.equal(readme.slice(start, end + END.length), renderBanner(status));
  assert.deepEqual(findProhibited(readme, status), []);
});

test('the prohibited list is a denylist and says so', () => {
  // Not an assertion about behaviour: a reminder in executable form that this
  // list only finds phrasings someone already wrote down, and that the derived
  // banner is the structural guard.
  assert.ok(PROHIBITED_WHILE_OPEN.length > 0);
  for (const entry of PROHIBITED_WHILE_OPEN) {
    assert.equal(typeof entry.why, 'string');
    assert.ok(entry.why.length > 0, 'every entry states what it means for a reader');
  }
});
