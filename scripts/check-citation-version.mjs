#!/usr/bin/env node
/**
 * `CITATION.cff` states the same version as `package.json` (#685).
 *
 * ## The drift this exists to prevent
 *
 * Measured on 2026-09-06: `package.json` said `0.29.0` and `CITATION.cff` said
 * `0.23.0` — six minor versions apart, since 2026-07-26. `CITATION.cff` is the
 * file a citation of this work resolves to, so anyone citing the project cited
 * `0.23.0` for code that was `0.29.0`. Both files parsed, both values were
 * individually plausible, and nothing compared them: there was no run to fail.
 * A hand-copied version is the same defect class as a hand-maintained counter,
 * and it drifts the moment someone forgets.
 *
 * ## Why the release DATE is not compared against the tag
 *
 * The obvious companion check — "`date-released` equals the `v<version>` tag's
 * date" — cannot be a merge gate here, and reasoning it through is cheaper than
 * shipping it and finding out. A release pull request bumps `package.json`
 * *before* the tag exists, so that check would go red on precisely the commit
 * doing the right thing, and the way through would be to weaken it. It would
 * also read tags, which `actions/checkout` does not fetch at its default depth:
 * a shallow checkout answers "no tags", and a comparison against an empty tag
 * list passes vacuously, which is this repository's own named defect class
 * inside the check written to prevent it.
 *
 * So the date is checked for the properties that are true at every commit:
 * present, a real ISO calendar date, and **not in the future**. A future date
 * is not a release that has happened; it is a broken clock or a typo, and it
 * satisfies every "is this recent enough" comparison forever.
 *
 * Usage:
 *   node scripts/check-citation-version.mjs            # check (exit 1 on drift)
 *   node scripts/check-citation-version.mjs --write     # copy the version across
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PACKAGE = 'package.json';
const CITATION = 'CITATION.cff';

/** `version: 0.29.0`, quoted or bare, at the top level of the CFF document. */
const VERSION_LINE = /^version:[ \t]*['"]?([^'"\s#]+)['"]?[ \t]*$/m;
/**
 * `date-released: '2026-09-05'`, quoted or bare.
 *
 * Deliberately permissive about what follows the colon. A stricter pattern —
 * one that only matches a bare token — reports `date-released: '25 July 2026'`
 * as *no date-released line*, which sends the reader looking for a line that is
 * right there. Two causes in one message hides the fixable one, so the line is
 * captured whole and judged afterwards.
 */
const DATE_LINE = /^date-released:[ \t]*(.*?)[ \t]*$/m;

/** Strip one layer of matching quotes, leaving the value to be judged. */
function unquote(value) {
  const match = /^(['"])(.*)\1$/.exec(value);
  return match ? match[2] : value;
}

/**
 * A calendar date, parsed without `Date`.
 *
 * `new Date('2026-09-05')` is UTC midnight and `getFullYear()` reads it in the
 * runner's zone, so a machine west of Greenwich reports September 4 — a class
 * of bug this repository has removed from several other files. Returns null for
 * anything that is not a real day, February 30 included.
 */
export function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  if (m < 1 || m > 12 || d < 1) return null;
  const lengths = [
    31,
    (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (d > lengths[m - 1]) return null;
  return { year: y, month: m, day: d };
}

/** Today, in UTC, as the same shape — the comparison is date-only. */
function todayUtc(now = new Date()) {
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
}

export function isFutureDate(date, today = todayUtc()) {
  if (date.year !== today.year) return date.year > today.year;
  if (date.month !== today.month) return date.month > today.month;
  return date.day > today.day;
}

export function citationVersion(text) {
  return VERSION_LINE.exec(text)?.[1] ?? null;
}

export function citationDate(text) {
  const raw = DATE_LINE.exec(text)?.[1];
  if (raw === undefined) return null;
  const value = unquote(raw.trim());
  // A line with nothing after the colon is a declared-but-empty field, which
  // is a different fault from an absent one and reads as malformed, not
  // missing.
  return value === '' ? '' : value;
}

export function evaluate({ packageVersion, citation, today = todayUtc() }) {
  const failures = [];
  const version = citationVersion(citation);
  if (version === null) {
    failures.push(
      `${CITATION} has no top-level \`version:\` line. It is what a citation of this ` +
        'work resolves to; restore it rather than removing this check.'
    );
  } else if (version !== packageVersion) {
    failures.push(
      `${CITATION} says version ${version}; ${PACKAGE} says ${packageVersion}. A citation ` +
        'of this project would name the wrong release. Run `npm run citation:check -- --write`.'
    );
  }

  const raw = citationDate(citation);
  if (raw === null) {
    failures.push(`${CITATION} has no \`date-released:\` line.`);
  } else {
    const parsed = parseIsoDate(raw);
    if (parsed === null) {
      failures.push(
        `${CITATION}'s date-released is ${JSON.stringify(raw)}, which is not a calendar date ` +
          '(expected YYYY-MM-DD).'
      );
    } else if (isFutureDate(parsed, today)) {
      failures.push(
        `${CITATION}'s date-released is ${raw}, which is in the future. A release that has ` +
          'not happened has no date; this is a typo or a wrong clock, and it satisfies every ' +
          'freshness comparison forever.'
      );
    }
  }
  return failures;
}

function main(argv) {
  const packageVersion = JSON.parse(readFileSync(PACKAGE, 'utf8')).version;
  if (typeof packageVersion !== 'string' || packageVersion === '') {
    console.error(`${PACKAGE} has no \`version\`; there is nothing to compare against.`);
    return 1;
  }
  const citation = readFileSync(CITATION, 'utf8');

  if (argv.includes('--write')) {
    if (!VERSION_LINE.test(citation)) {
      console.error(`${CITATION} has no \`version:\` line to write to.`);
      return 1;
    }
    const next = citation.replace(VERSION_LINE, `version: ${packageVersion}`);
    if (next === citation) {
      console.log(`${CITATION} already states ${packageVersion}.`);
      return 0;
    }
    writeFileSync(CITATION, next);
    console.log(`${CITATION}: version set to ${packageVersion} from ${PACKAGE}.`);
    console.log(
      'date-released is NOT written: only a person knows which day the release went out, ' +
        'and the tag that would answer it does not exist yet at bump time.'
    );
    return 0;
  }

  const failures = evaluate({ packageVersion, citation });
  if (failures.length > 0) {
    console.error('CITATION.cff check FAILED:\n');
    for (const failure of failures) console.error(`  - ${failure}\n`);
    return 1;
  }
  console.log(
    `${CITATION} states version ${packageVersion}, matching ${PACKAGE}, with a released date ` +
      `of ${citationDate(citation)}.`
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
