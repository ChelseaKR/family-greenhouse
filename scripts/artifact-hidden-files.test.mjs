import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  INCLUDE_HIDDEN,
  artifactHiddenFileProblems,
  distArtifactUploads,
} from './artifact-hidden-files.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The shape the production workflow had when v0.33.0 deployed a 404. */
const WITHOUT_FLAG = [
  '      - name: Upload frontend artifact',
  '        uses: actions/upload-artifact@043fb46 # v7.0.1',
  '        with:',
  '          name: frontend-dist-${{ needs.validate.outputs.version }}',
  '          path: frontend/dist',
  '',
  '      - name: Upload backend artifact',
  '        uses: actions/upload-artifact@043fb46 # v7.0.1',
  '        with:',
  '          name: backend-dist',
  '          path: backend/dist',
].join('\n');

const WITH_FLAG = WITHOUT_FLAG.replace(
  '          path: frontend/dist\n',
  `          path: frontend/dist\n          ${INCLUDE_HIDDEN}\n`
);

test('the exact v0.33.0 shape is reported', () => {
  const problems = artifactHiddenFileProblems('cd-production.yml', WITHOUT_FLAG, 'dist');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not set `include-hidden-files: true`/u);
  // The message has to name the consequence, not just the missing key: the
  // whole failure mode is that everything stays green.
  assert.match(problems[0], /404/u);
});

test('setting the flag clears it', () => {
  assert.deepEqual(artifactHiddenFileProblems('cd-production.yml', WITH_FLAG, 'dist'), []);
});

test('the backend artifact is not confused for the frontend one', () => {
  // Only one step names `path: frontend/dist`; the backend step must not be
  // read as a second violation, or the flag would appear to be needed twice.
  assert.equal(distArtifactUploads(WITHOUT_FLAG).length, 1);
});

test('a non-artifact step naming frontend/dist is ignored', () => {
  const cacheStep = [
    '      - name: Cache the build',
    '        uses: actions/cache@v4',
    '        with:',
    '          path: frontend/dist',
    '          key: dist-${{ github.sha }}',
  ].join('\n');
  assert.deepEqual(distArtifactUploads(cacheStep), []);
});

test('a missing upload step is a problem, not a silent pass', () => {
  // The dangerous failure is a gate that finds nothing and says OK.
  const problems = artifactHiddenFileProblems('cd-production.yml', 'jobs:\n  build:\n', 'dist');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no `actions\/upload-artifact` step/u);
});

test('both real deploy workflows carry the flag', () => {
  for (const file of ['.github/workflows/cd-production.yml', '.github/workflows/cd-staging.yml']) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    assert.deepEqual(
      artifactHiddenFileProblems(file, text, 'dist'),
      [],
      `${file} must upload frontend/dist with ${INCLUDE_HIDDEN}`
    );
  }
});
