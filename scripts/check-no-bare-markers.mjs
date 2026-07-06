#!/usr/bin/env node
/**
 * Enforces docs/standards/CODE-QUALITY-STANDARD.md §6: every TODO/FIXME/HACK
 * must carry an issue reference (a `(#NNN)` or a full issue URL) on the same
 * line. Bare markers fail the build. Scoped to source only.
 *
 * Extracted from the CI "No bare TODO/FIXME/HACK markers" step so `npm run
 * verify` (local + pre-push) runs the exact same check CI does, instead of an
 * approximation — see P1-4 / CICD-27 (make-verify parity).
 */
import { execSync } from 'node:child_process';

const PATTERN = '(TODO|FIXME|HACK)';
const ALLOWED = /\(#[0-9]+\)|https?:\/\/[^ ]+\/issues\/[0-9]+/;

function grep() {
  try {
    const out = execSync(
      `grep -rEn '${PATTERN}' --include='*.ts' --include='*.tsx' backend/src frontend/src`,
      { encoding: 'utf8' }
    );
    return out.split('\n').filter(Boolean);
  } catch (err) {
    // grep exits 1 when it finds nothing to match — that's the success case.
    if (err.status === 1) return [];
    throw err;
  }
}

const offenders = grep().filter((line) => !ALLOWED.test(line));

if (offenders.length > 0) {
  console.error('Bare TODO/FIXME/HACK found. Add an issue reference, e.g. TODO(#142): ...\n');
  for (const line of offenders) console.error(line);
  process.exit(1);
}

console.log('No bare TODO/FIXME/HACK markers.');
