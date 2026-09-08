import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  citationDate,
  citationVersion,
  evaluate,
  isFutureDate,
  parseIsoDate,
} from './check-citation-version.mjs';

/** CITATION.cff as it stood on origin/main when #685 was filed. */
const CITATION_BEFORE_685 = [
  'cff-version: 1.2.0',
  "title: 'Family Greenhouse'",
  'authors:',
  "  - family-names: 'Kelly-Reif'",
  "    given-names: 'Chelsea'",
  "license: 'Elastic-2.0'",
  'version: 0.23.0',
  "date-released: '2026-07-25'",
  '',
].join('\n');

const TODAY = { year: 2026, month: 9, day: 8 };

test('the file as it stood when #685 was filed fails, naming both versions', () => {
  const failures = evaluate({
    packageVersion: '0.29.0',
    citation: CITATION_BEFORE_685,
    today: TODAY,
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /says version 0\.23\.0; package\.json says 0\.29\.0/);
});

test('agreement passes', () => {
  const agreed = CITATION_BEFORE_685.replace('version: 0.23.0', 'version: 0.29.0');
  assert.deepEqual(evaluate({ packageVersion: '0.29.0', citation: agreed, today: TODAY }), []);
});

test('a missing version line is a failure, not a pass over nothing', () => {
  // The shape that turns a comparison into a no-op: nothing to compare, so
  // nothing disagrees. It has to fail, or deleting the line buys a green run.
  const stripped = CITATION_BEFORE_685.replace('version: 0.23.0\n', '');
  const failures = evaluate({ packageVersion: '0.29.0', citation: stripped, today: TODAY });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no top-level `version:` line/);
});

test('a missing or malformed release date is a failure', () => {
  const noDate = CITATION_BEFORE_685.replace("date-released: '2026-07-25'\n", '');
  assert.match(
    evaluate({ packageVersion: '0.23.0', citation: noDate, today: TODAY }).join(),
    /no `date-released:` line/
  );

  const bad = CITATION_BEFORE_685.replace("'2026-07-25'", "'25 July 2026'");
  assert.match(
    evaluate({ packageVersion: '0.23.0', citation: bad, today: TODAY }).join(),
    /not a calendar date/
  );
});

test('a future release date is refused', () => {
  // A release that has not happened has no date, and a future one satisfies
  // every "is this recent enough" comparison permanently.
  const future = CITATION_BEFORE_685.replace("'2026-07-25'", "'2027-01-01'");
  assert.match(
    evaluate({ packageVersion: '0.23.0', citation: future, today: TODAY }).join(),
    /in the future/
  );
  // Today itself is not the future.
  const todayString = CITATION_BEFORE_685.replace("'2026-07-25'", "'2026-09-08'");
  assert.deepEqual(evaluate({ packageVersion: '0.23.0', citation: todayString, today: TODAY }), []);
});

test('dates are parsed without Date, so a runner west of Greenwich reads the same day', () => {
  assert.deepEqual(parseIsoDate('2026-09-05'), { year: 2026, month: 9, day: 5 });
  assert.equal(parseIsoDate('2026-02-30'), null, 'February 30 is not a day');
  assert.deepEqual(parseIsoDate('2024-02-29'), { year: 2024, month: 2, day: 29 }, 'leap day');
  assert.equal(parseIsoDate('2026-02-29'), null, '2026 is not a leap year');
  assert.equal(parseIsoDate('2026-9-5'), null, 'unpadded is not the CFF form');
  assert.equal(parseIsoDate(''), null);
  assert.equal(parseIsoDate(undefined), null);
});

test('the future comparison walks year, then month, then day', () => {
  assert.equal(isFutureDate({ year: 2026, month: 1, day: 1 }, TODAY), false);
  assert.equal(isFutureDate({ year: 2027, month: 1, day: 1 }, TODAY), true);
  assert.equal(isFutureDate({ year: 2026, month: 10, day: 1 }, TODAY), true);
  assert.equal(isFutureDate({ year: 2026, month: 9, day: 9 }, TODAY), true);
  assert.equal(isFutureDate({ year: 2026, month: 9, day: 8 }, TODAY), false);
});

test('quoted and bare values both read', () => {
  assert.equal(citationVersion("version: '1.2.3'\n"), '1.2.3');
  assert.equal(citationVersion('version: 1.2.3\n'), '1.2.3');
  assert.equal(citationDate("date-released: '2026-09-05'\n"), '2026-09-05');
  assert.equal(citationDate('date-released: 2026-09-05\n'), '2026-09-05');
});

test('the committed CITATION.cff agrees with the committed package.json', () => {
  // The end-to-end assertion, so the fact is held by `npm run test:checks` as
  // well as by the gate.
  const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const citation = readFileSync('CITATION.cff', 'utf8');
  assert.deepEqual(evaluate({ packageVersion, citation }), []);
});
