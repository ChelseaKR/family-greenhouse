#!/usr/bin/env node
/**
 * The Terms of Service effective date is the date of the release that ships
 * the text (#593).
 *
 * ## The defect this exists to prevent
 *
 * The Terms page carried a hand-typed effective date. The #593 change to the
 * failed-payment terms was written on 2026-09-17 and set the date to that day,
 * but it could not ship until a later release, so the page would have gone out
 * claiming terms had been in force for weeks before any customer could read
 * them. Nobody knows the release date while the change is being written, and
 * a guessed future date is no better.
 *
 * ## The mechanism
 *
 * `frontend/src/features/legal/termsEffective.json` holds three fields:
 *
 *   - `effectiveDate` and `release`: either both `UNRELEASED` (the text has
 *     changed since the last release and no release has shipped it yet), or
 *     a release version and the date `CHANGELOG.md` gives that release.
 *   - `contentSha256`: a fingerprint of the Terms text in every locale
 *     (`legal.terms` in each `legal.json`).
 *
 * Merge gate (`npm run terms-date:check`, every commit):
 *   - a Terms text change with a stale fingerprint fails, and the fix is
 *     `--pending`, which sets both fields to `UNRELEASED` and records the new
 *     fingerprint. So no text change can keep an older release's date.
 *   - a recorded release must have a `## [<release>] - <date>` heading in
 *     CHANGELOG.md with exactly the recorded date, and must not be newer than
 *     package.json. So the date is always a real release's date, never typed.
 *
 * Release (`--release`, run by cd-production.yml at the tag, and by the
 * release PR): everything above, `UNRELEASED` fails, and a date carried over
 * from an earlier release must belong to the text that release's tag shipped. A release that ships
 * changed Terms must first run `--fill`, which copies package.json's version
 * and that version's CHANGELOG date in.
 *
 * Usage:
 *   node scripts/check-terms-effective-date.mjs             # merge gate
 *   node scripts/check-terms-effective-date.mjs --release   # release gate
 *   node scripts/check-terms-effective-date.mjs --pending   # after editing the Terms
 *   node scripts/check-terms-effective-date.mjs --fill      # in the release PR
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseIsoDate } from './check-citation-version.mjs';

export const PENDING = 'UNRELEASED';
export const TERMS_FILE = 'frontend/src/features/legal/termsEffective.json';
export const LOCALE_FILES = [
  'frontend/src/i18n/locales/en/legal.json',
  'frontend/src/i18n/locales/es/legal.json',
];
const PACKAGE = 'package.json';
const CHANGELOG = 'CHANGELOG.md';

/** sha256 over the `legal.terms` subtree of each locale, in a fixed order. */
export function termsFingerprint(catalogs) {
  const terms = catalogs.map((catalog) => catalog?.legal?.terms ?? null);
  return createHash('sha256').update(JSON.stringify(terms)).digest('hex');
}

/** The date CHANGELOG.md gives a release, or null when it has no heading for it. */
export function changelogDate(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^## \\[${escaped}\\] - (\\d{4}-\\d{2}-\\d{2})[ \\t]*$`, 'm').exec(
    changelog
  );
  return match ? match[1] : null;
}

/** -1, 0 or 1 for two `x.y.z` versions; null when either is not one. */
export function compareVersions(a, b) {
  const parse = (v) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

export function evaluate({ record, fingerprint, packageVersion, changelog, release = false }) {
  const failures = [];
  const { effectiveDate, release: recordedRelease, contentSha256 } = record ?? {};

  if (contentSha256 !== fingerprint) {
    failures.push(
      `The Terms text changed since ${TERMS_FILE} was last updated, so its effective date ` +
        'belongs to text that is no longer on the page. Run ' +
        '`node scripts/check-terms-effective-date.mjs --pending`: the date is set by the ' +
        'release that ships the change.'
    );
  }

  const datePending = effectiveDate === PENDING;
  const releasePending = recordedRelease === PENDING;
  if (datePending !== releasePending) {
    failures.push(
      `${TERMS_FILE}: effectiveDate and release must both be ${PENDING} or both be set; ` +
        `got ${JSON.stringify(effectiveDate)} and ${JSON.stringify(recordedRelease)}.`
    );
    return failures;
  }

  if (datePending) {
    if (release) {
      failures.push(
        `The Terms effective date is unset (${PENDING}) in a release. Run ` +
          '`node scripts/check-terms-effective-date.mjs --fill` in the release PR, after the ' +
          `${CHANGELOG} heading for ${packageVersion} has its date.`
      );
    }
    return failures;
  }

  if (typeof effectiveDate !== 'string' || parseIsoDate(effectiveDate) === null) {
    failures.push(
      `${TERMS_FILE}: effectiveDate ${JSON.stringify(effectiveDate)} is not a calendar date.`
    );
    return failures;
  }
  const order = compareVersions(String(recordedRelease), packageVersion);
  if (order === null) {
    failures.push(
      `${TERMS_FILE}: release ${JSON.stringify(recordedRelease)} is not an x.y.z version.`
    );
    return failures;
  }
  if (order > 0) {
    failures.push(
      `${TERMS_FILE}: release ${recordedRelease} is newer than ${PACKAGE} (${packageVersion}).`
    );
  }
  const dated = changelogDate(changelog, recordedRelease);
  if (dated === null) {
    failures.push(
      `${CHANGELOG} has no "## [${recordedRelease}] - YYYY-MM-DD" heading, so the Terms ` +
        `effective date ${effectiveDate} is not the date of a release.`
    );
  } else if (dated !== effectiveDate) {
    failures.push(
      `The Terms say they took effect on ${effectiveDate}, but ${CHANGELOG} dates release ` +
        `${recordedRelease} ${dated}. The effective date is the release date; run --fill ` +
        'in the release PR rather than typing it.'
    );
  }
  return failures;
}

/**
 * Release mode only: a date carried over from an EARLIER release must belong
 * to text that release actually shipped.
 *
 * The fingerprint catches a text change made after the record was written,
 * but not a record hand-pointed at an older release after the text changed.
 * At a tag the history is there to answer that (cd-production.yml checks out
 * with `fetch-depth: 0`), so the Terms in `v<release>` are fingerprinted and
 * must match today's. A tag that cannot be read fails: an empty answer is
 * not a match.
 */
export function evaluateShippedText({ record, fingerprint, packageVersion, fingerprintAtTag }) {
  if (record?.release === PENDING || record?.release === packageVersion) return [];
  const shipped = fingerprintAtTag(record.release);
  if (shipped === null) {
    return [
      `Could not read the Terms as tag v${record.release} shipped them, so the effective ` +
        `date ${record.effectiveDate} cannot be shown to belong to this text.`,
    ];
  }
  if (shipped !== fingerprint) {
    return [
      `The Terms differ from what v${record.release} shipped, so ${record.effectiveDate} is ` +
        'not when this text took effect. This release changes the Terms: run --pending, ' +
        'then --fill.',
    ];
  }
  return [];
}

function fingerprintAtTag(version) {
  try {
    return termsFingerprint(
      LOCALE_FILES.map((file) =>
        JSON.parse(
          execFileSync('git', ['show', `v${version}:${file}`], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          })
        )
      )
    );
  } catch {
    return null;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function write(record) {
  writeFileSync(TERMS_FILE, `${JSON.stringify(record, null, 2)}\n`);
}

function main(argv) {
  const record = readJson(TERMS_FILE);
  const fingerprint = termsFingerprint(LOCALE_FILES.map(readJson));
  const packageVersion = readJson(PACKAGE).version;
  const changelog = readFileSync(CHANGELOG, 'utf8');

  if (argv.includes('--pending')) {
    write({ effectiveDate: PENDING, release: PENDING, contentSha256: fingerprint });
    console.log(`${TERMS_FILE}: effective date set to ${PENDING} for the changed Terms.`);
    return 0;
  }

  if (argv.includes('--fill')) {
    if (record.effectiveDate !== PENDING) {
      console.log(
        `${TERMS_FILE} already names release ${record.release}; the Terms did not change.`
      );
      return 0;
    }
    const dated = changelogDate(changelog, packageVersion);
    if (dated === null) {
      console.error(
        `${CHANGELOG} has no "## [${packageVersion}] - YYYY-MM-DD" heading yet. Write the ` +
          'release heading first; its date becomes the Terms effective date.'
      );
      return 1;
    }
    write({ effectiveDate: dated, release: packageVersion, contentSha256: record.contentSha256 });
    console.log(`${TERMS_FILE}: the Terms take effect with ${packageVersion} on ${dated}.`);
    return 0;
  }

  const release = argv.includes('--release');
  const failures = evaluate({ record, fingerprint, packageVersion, changelog, release });
  if (release && failures.length === 0) {
    failures.push(
      ...evaluateShippedText({ record, fingerprint, packageVersion, fingerprintAtTag })
    );
  }
  if (failures.length > 0) {
    console.error('Terms effective-date check FAILED:\n');
    for (const failure of failures) console.error(`  - ${failure}\n`);
    return 1;
  }
  console.log(
    record.effectiveDate === PENDING
      ? `The Terms changed since the last release; the effective date is ${PENDING} until a release fills it.`
      : `The Terms took effect with release ${record.release} on ${record.effectiveDate}.`
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
