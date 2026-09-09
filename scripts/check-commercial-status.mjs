#!/usr/bin/env node
/**
 * The README's commercial-status banner is derived from `commercial-status.json`,
 * not written beside it (#688).
 *
 * ## The failure this exists to prevent
 *
 * Everything else in this repository treats the commercial state as
 * machine-readable and single-sourced: `commercial-status.json` is imported by
 * `backend/src/config/commercialStatus.ts` and
 * `frontend/src/config/commercialStatus.ts`, `infrastructure/main.tf` refuses an
 * apply that opens one gate without the other, and `docs/COMMERCIAL-STATUS.md`
 * carries the dated transitions. The README was the one copy of that claim that
 * nothing derived and nothing checked — and it is the copy a reader sees first.
 *
 * So on 2026-09-07, with `commercialHoldActive: false` since September 1 and
 * `payments_enabled = "1"` in the production tfvars since September 2, the front
 * page of a public repository for a product taking real card payments said, in
 * bold, that it was "not currently accepting payments, offering paid plans, or
 * generating revenue" — and linked the reader to the document that contradicted
 * it. Nothing was broken; nothing could have noticed.
 *
 * ## What it checks, and why it is two rules rather than one
 *
 * **Rule 1 — the banner is generated.** The block between the markers in
 * README.md must be byte-identical to what `renderBanner()` produces from the
 * JSON. `publicMessage` and `effectiveDate` are the owner's words and the
 * owner's date; this script only decides where they go. `--write` regenerates
 * the block, so the fix for a failure is a command rather than a retyping.
 *
 * **Rule 2 — no second claim outside the block.** Rule 1 can hold while the rest
 * of the README still asserts a hold somewhere else, and on the day this was
 * written that was exactly the state: line 76 said "payment creation is
 * fail-closed during the commercial hold" three paragraphs below a banner that
 * would have been correct. So while `commercialHoldActive` is false, README
 * prose outside the generated block may not assert that payments are held.
 *
 * Rule 2 is a denylist of phrasings, and a denylist can only find what someone
 * already thought of — it would not catch a sentence worded a new way. It is
 * kept anyway because it costs nothing and it catches the copies that exist
 * today, but Rule 1 is the structural guard and Rule 2 is not a substitute for
 * it. `PROHIBITED_WHILE_OPEN` carries a `sample` per entry and
 * `assertPatternsStillMatch()` runs every pattern against its own sample on
 * every invocation, so a pattern that has quietly stopped matching anything
 * fails here rather than passing silently.
 *
 * Usage:
 *   node scripts/check-commercial-status.mjs            # check (exit 1 on drift)
 *   node scripts/check-commercial-status.mjs --write     # regenerate the block
 */
import { readFileSync, writeFileSync } from 'node:fs';

const STATUS_FILE = 'commercial-status.json';
const README = 'README.md';
const START = '<!-- commercial-status:start -->';
const END = '<!-- commercial-status:end -->';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * `2026-09-01` -> `September 1, 2026`, without `Date` or a locale.
 *
 * `new Date('2026-09-01')` parses as UTC midnight and `toLocaleDateString`
 * renders it in the runner's zone, so a machine west of Greenwich prints
 * August 31 — a date this repository has spent several pull requests removing
 * from other files. Parsing the three fields is shorter and cannot do that.
 */
export function formatEffectiveDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!match) {
    throw new Error(
      `${STATUS_FILE}: effectiveDate must be an ISO calendar date (YYYY-MM-DD); got ${JSON.stringify(iso)}`
    );
  }
  const [, year, month, day] = match;
  const name = MONTHS[Number(month) - 1];
  if (!name) throw new Error(`${STATUS_FILE}: effectiveDate has no such month: ${iso}`);
  return `${name} ${Number(day)}, ${year}`;
}

/** The README block, derived entirely from the JSON. */
export function renderBanner(status) {
  if (typeof status.publicMessage !== 'string' || status.publicMessage.trim() === '') {
    throw new Error(`${STATUS_FILE}: publicMessage must be a non-empty string`);
  }
  if (typeof status.commercialHoldActive !== 'boolean') {
    throw new Error(`${STATUS_FILE}: commercialHoldActive must be a boolean`);
  }
  const heading = status.commercialHoldActive
    ? `**Commercial status — paid activity is on hold, effective ${formatEffectiveDate(status.effectiveDate)}.**`
    : `**Commercial status — effective ${formatEffectiveDate(status.effectiveDate)}.**`;
  return [
    START,
    '<!-- Generated from commercial-status.json by scripts/check-commercial-status.mjs.',
    '     Edit the JSON and run `npm run commercial:check -- --write`; do not edit this block. -->',
    '',
    `> ${heading}`,
    `> ${status.publicMessage}`,
    '> The dated transitions, and the two gates that control payment activity, are in',
    '> [`docs/COMMERCIAL-STATUS.md`](docs/COMMERCIAL-STATUS.md).',
    '',
    END,
  ].join('\n');
}

/**
 * Markdown line-wrapping is not a hiding place.
 *
 * The sentence this check exists for was written as
 *
 *     > It is not currently accepting payments, offering paid plans, or generating
 *     > revenue. Pricing and billing material is retained ...
 *
 * so "or generating revenue" is split by a newline AND a blockquote marker.
 * `\s+` matches the newline and not the `>`, so a pattern written against the
 * sentence as a human reads it finds nothing in the file — measured: the first
 * version of this list matched three of the four live phrasings on
 * `origin/main` and silently missed that one. Blockquote and list markers come
 * off and runs of whitespace collapse before anything is matched, and the
 * samples below are the wrapped forms rather than the tidy ones.
 */
export function normalizeProse(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:>+\s?|[-*+]\s+)/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}

/**
 * Phrasings that cannot be true of the README while the hold is off. Each
 * carries a `sample` the pattern must match, so a regex that stops matching
 * anything cannot pass as "found nothing".
 */
const PROHIBITED_WHILE_OPEN = [
  {
    pattern: /not\s+(?:currently\s+)?accepting\s+payments/i,
    sample: 'It is not currently accepting payments, offering paid plans',
    why: 'says the product does not take payments',
  },
  {
    pattern: /(?:or|nor|not)\s+generating\s+revenue/i,
    sample: normalizeProse('> or generating\n> revenue. Pricing and billing material'),
    why: 'says the product earns nothing',
  },
  {
    pattern: /during\s+the\s+commercial\s+hold/i,
    sample: 'payment creation is fail-closed during the commercial hold',
    why: 'describes a hold that is not in force',
  },
  {
    pattern: /paid\s+activity\s+hold\s*[—-]/i,
    sample: '**Paid activity hold — July 14, 2026;',
    why: 'headlines a hold that has been lifted',
  },
  {
    pattern: /paid\s+plans\s+are\s+paused/i,
    sample: 'Start free; paid plans are paused',
    why: 'says paid plans cannot be bought',
  },
];

/** A pattern that matches nothing is not a check. Assert each still fires. */
export function assertPatternsStillMatch(entries = PROHIBITED_WHILE_OPEN) {
  if (entries.length === 0) throw new Error('the prohibited-phrase list is empty');
  const dead = entries.filter((entry) => !entry.pattern.test(entry.sample));
  if (dead.length > 0) {
    throw new Error(
      `these patterns no longer match their own sample, so they check nothing: ${dead
        .map((entry) => String(entry.pattern))
        .join(', ')}`
    );
  }
}

/**
 * README prose with the generated block removed.
 *
 * With no markers there is no block to remove, so the whole file is prose and
 * every phrase in it is in scope. Throwing here instead would let the missing
 * markers hide the sentences — the operator would get a stack trace naming one
 * problem where there are several, and a `--write` would then "fix" it by
 * inserting a correct banner above prose still asserting the opposite.
 * `main()` reports the missing markers as their own failure.
 */
export function proseOutsideBanner(readme) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) return readme;
  return readme.slice(0, start) + readme.slice(end + END.length);
}

export function findProhibited(readme, status, entries = PROHIBITED_WHILE_OPEN) {
  if (status.commercialHoldActive === true) return [];
  const prose = normalizeProse(proseOutsideBanner(readme));
  return entries.filter((entry) => entry.pattern.test(prose));
}

function replaceBanner(readme, banner) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${README} is missing the ${START} / ${END} markers`);
  }
  return readme.slice(0, start) + banner + readme.slice(end + END.length);
}

function main(argv) {
  const write = argv.includes('--write');
  const status = JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
  const readme = readFileSync(README, 'utf8');

  assertPatternsStillMatch();
  const banner = renderBanner(status);

  if (write) {
    const next = replaceBanner(readme, banner);
    if (next !== readme) {
      writeFileSync(README, next);
      console.log(`${README}: commercial-status banner regenerated from ${STATUS_FILE}`);
    } else {
      console.log(`${README}: commercial-status banner already matches ${STATUS_FILE}`);
    }
    return 0;
  }

  const failures = [];

  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    failures.push(
      `${README} has no ${START} / ${END} block. The banner is generated from ${STATUS_FILE}; ` +
        'restore the markers and run `npm run commercial:check -- --write`.'
    );
  } else {
    const current = readme.slice(start, end + END.length);
    if (current !== banner) {
      failures.push(
        `${README}'s commercial-status banner does not match ${STATUS_FILE}.\n` +
          `--- committed ---\n${current}\n--- derived ---\n${banner}\n` +
          'Fix the JSON if the status changed, then run `npm run commercial:check -- --write`.'
      );
    }
  }

  for (const entry of findProhibited(readme, status)) {
    failures.push(
      `${README} still ${entry.why} outside the generated block (${entry.pattern}), while ` +
        `${STATUS_FILE} says commercialHoldActive is false. Correct the sentence.`
    );
  }

  if (failures.length > 0) {
    console.error('Commercial-status check FAILED:\n');
    for (const failure of failures) console.error(`  - ${failure}\n`);
    return 1;
  }

  console.log(
    `${README}'s commercial-status banner is derived from ${STATUS_FILE} ` +
      `(commercialHoldActive: ${status.commercialHoldActive}), and no prose outside it contradicts the JSON.`
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}

export { PROHIBITED_WHILE_OPEN, START, END };
