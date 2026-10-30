import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CONTROLS,
  IntegrityError,
  PIN,
  SKIP_EXIT,
  assertPinnedModule,
  binPath,
  digestTree,
  inCI,
  main,
} from './check-greenlight.mjs';

const GOOD = {
  Version: PIN.version,
  Sum: PIN.sum,
  Origin: { Hash: PIN.commit },
};

test('the pin is a full commit, a tagged version and an h1 hash, never a floating ref', () => {
  assert.match(PIN.commit, /^[0-9a-f]{40}$/);
  assert.match(PIN.version, /^v\d+\.\d+\.\d+$/);
  assert.match(PIN.sum, /^h1:[A-Za-z0-9+/]{43}=$/);
  assert.notEqual(PIN.version, 'latest');
});

test('the pinned module is accepted', () => {
  assert.doesNotThrow(() => assertPinnedModule(GOOD));
});

test('a moved tag (different commit) is refused', () => {
  assert.throws(
    () => assertPinnedModule({ ...GOOD, Origin: { Hash: '0'.repeat(40) } }),
    IntegrityError
  );
});

test('different module bytes (different h1) are refused', () => {
  assert.throws(
    () => assertPinnedModule({ ...GOOD, Sum: `h1:${'A'.repeat(43)}=` }),
    IntegrityError
  );
});

test('a different version, or no answer at all, is refused', () => {
  assert.throws(() => assertPinnedModule({ ...GOOD, Version: 'v0.3.0' }), IntegrityError);
  assert.throws(() => assertPinnedModule({}), IntegrityError);
  assert.throws(() => assertPinnedModule(undefined), IntegrityError);
});

test('inCI reads CI the way GitHub Actions sets it', () => {
  assert.equal(inCI({ CI: 'true' }), true);
  assert.equal(inCI({ CI: '1' }), true);
  assert.equal(inCI({}), false);
  assert.equal(inCI({ CI: 'false' }), false);
});

test('the binary lives under the git-ignored .tools directory, keyed by the pin', () => {
  const p = binPath('/repo');
  assert.equal(p, `/repo/.tools/greenlight/${PIN.version}-${PIN.commit.slice(0, 12)}/greenlight`);
});

test('digestTree changes when a file is added, removed or edited', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fg-gl-digest-'));
  try {
    // Same helper the controls use to prove a seeding changed the copy.
    mkdirSync(join(dir, 'a'), { recursive: true });
    writeFileSync(join(dir, 'a', 'f.txt'), 'one');
    const base = digestTree(dir);
    writeFileSync(join(dir, 'a', 'f.txt'), 'two');
    const edited = digestTree(dir);
    assert.notEqual(edited, base);
    rmSync(join(dir, 'a', 'f.txt'));
    assert.notEqual(digestTree(dir), edited);
    assert.notEqual(digestTree(dir), base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every control is fully specified (seed, project, expected finding)', () => {
  // main() runs them against the scanner and asserts each seeding changed its
  // copy; this proves the shape without needing the binary.
  assert.ok(CONTROLS.length >= 3);
  for (const ctl of CONTROLS) {
    assert.ok(
      ctl.name && ctl.project && typeof ctl.seed === 'function' && ctl.expect instanceof RegExp
    );
  }
});

test('with no scanner and no go: SKIPPED locally (exit 78), a failure in CI', () => {
  const root = mkdtempSync(join(tmpdir(), 'fg-gl-noroot-'));
  const saved = { PATH: process.env.PATH, CI: process.env.CI };
  const logs = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  try {
    assert.equal(existsSync(binPath(root)), false);
    process.env.PATH = join(root, 'empty');
    delete process.env.CI;
    assert.equal(main(root), SKIP_EXIT);
    assert.ok(
      logs.some((l) => l.startsWith('SKIPPED: greenlight not installed')),
      'the skip must be loud'
    );

    process.env.CI = 'true';
    assert.equal(main(root), 1);
  } finally {
    console.log = log;
    console.error = err;
    process.env.PATH = saved.PATH;
    if (saved.CI === undefined) delete process.env.CI;
    else process.env.CI = saved.CI;
    rmSync(root, { recursive: true, force: true });
  }
});
