import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  LOCALE_FILES,
  PENDING,
  TERMS_FILE,
  changelogDate,
  compareVersions,
  evaluate,
  evaluateShippedText,
  termsFingerprint,
} from './check-terms-effective-date.mjs';

const CATALOGS = [
  { legal: { terms: { title: 'Terms of Service', renewal: { failedPayment: 'kept' } } } },
  {
    legal: { terms: { title: 'Términos del servicio', renewal: { failedPayment: 'se conserva' } } },
  },
];
const SHA = termsFingerprint(CATALOGS);
const CHANGELOG = [
  '## [Unreleased]',
  '',
  '## [0.38.0] - 2026-10-05',
  '',
  '## [0.37.0] - 2026-09-18',
  '',
].join('\n');

const base = { fingerprint: SHA, packageVersion: '0.38.0', changelog: CHANGELOG };
const pending = { effectiveDate: PENDING, release: PENDING, contentSha256: SHA };
const filled = { effectiveDate: '2026-10-05', release: '0.38.0', contentSha256: SHA };

test('pending Terms pass the merge gate', () => {
  assert.deepEqual(evaluate({ ...base, record: pending }), []);
});

test('a release whose Terms date is unset fails', () => {
  const failures = evaluate({ ...base, record: pending, release: true });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /unset \(UNRELEASED\) in a release/);
});

test('a release whose Terms date is the release date passes', () => {
  assert.deepEqual(evaluate({ ...base, record: filled, release: true }), []);
});

test('a hand-typed date that is not the release date fails, earlier or later', () => {
  for (const effectiveDate of ['2026-09-17', '2026-10-09']) {
    const failures = evaluate({ ...base, record: { ...filled, effectiveDate }, release: true });
    assert.equal(failures.length, 1, effectiveDate);
    assert.match(failures[0], /CHANGELOG\.md dates release 0\.38\.0 2026-10-05/);
  }
});

test('changed Terms text cannot keep an earlier release date', () => {
  // The #593 case: the text changed after 0.37.0 shipped. Keeping 0.37.0's
  // date would claim the new terms were in force since 2026-09-18.
  const stale = { effectiveDate: '2026-09-18', release: '0.37.0', contentSha256: 'old' };
  const failures = evaluate({ ...base, record: stale, release: true });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Terms text changed/);
});

test('an unchanged earlier release date still passes a later release', () => {
  const earlier = { effectiveDate: '2026-09-18', release: '0.37.0', contentSha256: SHA };
  assert.deepEqual(evaluate({ ...base, record: earlier, release: true }), []);
});

test('a release that is not in the CHANGELOG, or newer than package.json, fails', () => {
  const missing = evaluate({
    ...base,
    record: { ...filled, release: '0.36.0', effectiveDate: '2026-09-17' },
  });
  assert.match(missing.join('\n'), /no "## \[0\.36\.0\] - YYYY-MM-DD" heading/);
  const ahead = evaluate({ ...base, packageVersion: '0.37.0', record: filled });
  assert.match(ahead.join('\n'), /newer than package\.json/);
});

test('half-pending and malformed records fail', () => {
  assert.equal(evaluate({ ...base, record: { ...filled, release: PENDING } }).length, 1);
  assert.equal(evaluate({ ...base, record: { ...filled, effectiveDate: 'soon' } }).length, 1);
  assert.equal(evaluate({ ...base, record: { ...filled, release: 'next' } }).length, 1);
});

test('changelogDate and compareVersions', () => {
  assert.equal(changelogDate(CHANGELOG, '0.37.0'), '2026-09-18');
  assert.equal(changelogDate(CHANGELOG, '0.3.0'), null);
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('0.10.0', '0.10.0'), 0);
  assert.equal(compareVersions('next', '0.10.0'), null);
});

test('the fingerprint covers every locale', () => {
  const changedEs = structuredClone(CATALOGS);
  changedEs[1].legal.terms.title = 'Condiciones';
  assert.notEqual(termsFingerprint(changedEs), SHA);
});

test('the committed record agrees with the committed Terms', () => {
  const record = JSON.parse(readFileSync(TERMS_FILE, 'utf8'));
  const fingerprint = termsFingerprint(
    LOCALE_FILES.map((file) => JSON.parse(readFileSync(file, 'utf8')))
  );
  const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  assert.deepEqual(evaluate({ record, fingerprint, packageVersion, changelog }), []);
});

test('a release refuses an earlier release date the earlier tag did not ship with this text', () => {
  const earlier = { effectiveDate: '2026-09-18', release: '0.37.0', contentSha256: SHA };
  const args = { record: earlier, fingerprint: SHA, packageVersion: '0.38.0' };
  assert.deepEqual(evaluateShippedText({ ...args, fingerprintAtTag: () => SHA }), []);
  assert.match(
    evaluateShippedText({ ...args, fingerprintAtTag: () => 'other' }).join('\n'),
    /differ from what v0\.37\.0 shipped/
  );
  assert.match(
    evaluateShippedText({ ...args, fingerprintAtTag: () => null }).join('\n'),
    /Could not read the Terms as tag v0\.37\.0/
  );
  // This release's own date needs no tag: the tag is being made.
  assert.deepEqual(
    evaluateShippedText({ ...args, record: filled, fingerprintAtTag: () => null }),
    []
  );
});
