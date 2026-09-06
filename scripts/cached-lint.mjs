#!/usr/bin/env node
/**
 * Runs ESLint or Prettier with a cache whose key includes the tool's OWN
 * CONFIGURATION, and forwards the tool's exit code unchanged.
 *
 * Why this exists rather than just adding `--cache` to the npm scripts:
 * ESLint's cache does not key on the config at all. Measured on this repo
 * (backend, 2026-09-05):
 *
 *   cold                                    43.0s
 *   warm, nothing changed                    3.7s
 *   warm, eslint.config.mjs REWRITTEN to add
 *   `max-lines: ['error', 5]` + `no-undef`   3.7s, exit 0
 *
 * That last line is the problem. A rule that every file in `backend/src`
 * violates was added, and the cached run reported success — because ESLint
 * replayed per-file results keyed on mtime+size of the SOURCE files, and the
 * config is not part of that key. `npm run verify` is a pre-push gate, and
 * scripts/check-no-silenced-gates.mjs exists precisely because this repo keeps
 * finding checks that cannot fail. A lint cache that survives a config change
 * is one of those, so a bare `--cache` is not an option here.
 *
 * The fix is to put the config in the cache PATH instead of trusting the tool
 * to notice: hash the config inputs, and store the cache at a location derived
 * from that hash. Change a rule and the hash changes, the old cache is no
 * longer addressed, and the run is a cold one that re-lints every file. There
 * is no state in which a stale result can be replayed against a config that
 * did not produce it.
 *
 * Prettier 3 does document that its cache key covers version and options, so
 * for Prettier this is belt-and-braces — but it costs nothing and means both
 * tools have the same, checkable invalidation story rather than one relying on
 * documented behaviour and the other on a workaround.
 *
 * The cache path also includes a hash of the working directory and the
 * arguments, because the gate runs `lint:frontend` and `lint:backend`
 * concurrently (scripts/gate-steps.mjs) and two ESLint processes writing one
 * cache file corrupt it. Per-invocation files keep them independent.
 *
 * Caches live under node_modules/.cache/, already ignored by virtue of
 * node_modules/. Superseded caches for the same invocation are pruned on each
 * run so a month of config edits doesn't accumulate.
 *
 * Usage:
 *   node scripts/cached-lint.mjs eslint  -- src --max-warnings 0
 *   node scripts/cached-lint.mjs prettier -- --check .
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Files whose contents change what a run SHOULD report. Anything listed here
 * busts the cache; anything missing from here can silently go unnoticed, so
 * err towards listing too much.
 */
const CONFIG_INPUTS = {
  eslint: [
    'eslint.config.mjs',
    'frontend/eslint.config.mjs',
    'backend/eslint.config.mjs',
    'tsconfig.json',
    'frontend/tsconfig.json',
    'backend/tsconfig.json',
  ],
  prettier: ['.prettierrc', '.prettierignore'],
};

/** The installed version of the tool itself — a bump changes its output. */
function toolVersion(tool) {
  const pkg = join(ROOT, 'node_modules', tool, 'package.json');
  if (!existsSync(pkg)) return `${tool}:missing`;
  return `${tool}:${JSON.parse(readFileSync(pkg, 'utf8')).version}`;
}

function hash(parts) {
  const h = createHash('sha256');
  for (const part of parts) h.update(part).update('\0');
  return h.digest('hex').slice(0, 16);
}

/** Hash of everything that decides what a correct run reports. */
function configHash(tool) {
  const parts = [toolVersion(tool)];
  for (const rel of CONFIG_INPUTS[tool]) {
    const abs = join(ROOT, rel);
    parts.push(rel, existsSync(abs) ? readFileSync(abs, 'utf8') : '\0absent');
  }
  return hash(parts);
}

/** Hash of WHICH run this is, so concurrent gate steps don't share a file. */
function scopeHash(args) {
  return hash([relative(ROOT, process.cwd()) || '.', ...args]);
}

function main() {
  const argv = process.argv.slice(2);
  const tool = argv[0];
  if (!Object.hasOwn(CONFIG_INPUTS, tool)) {
    console.error(`cached-lint: expected 'eslint' or 'prettier', got '${tool ?? ''}'`);
    process.exit(2);
  }

  const sep = argv.indexOf('--');
  if (sep === -1) {
    console.error("cached-lint: pass the tool's own arguments after a '--' separator");
    process.exit(2);
  }
  const forwarded = argv.slice(sep + 1);

  const scope = scopeHash(forwarded);
  const config = configHash(tool);
  const dir = join(ROOT, 'node_modules', '.cache', tool);
  mkdirSync(dir, { recursive: true });

  // Drop caches for this same invocation under a previous config. Keeping them
  // is harmless but unbounded; removing them keeps the directory readable.
  const prefix = `${scope}-`;
  const current = `${prefix}${config}`;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(prefix) && entry !== current) {
      rmSync(join(dir, entry), { force: true });
    }
  }

  const bin = join(ROOT, 'node_modules', '.bin', tool);
  const child = spawn(bin, [...forwarded, '--cache', '--cache-location', join(dir, current)], {
    stdio: 'inherit',
    // eslint and prettier are shell scripts on POSIX and .cmd on Windows; npm
    // puts both in .bin, and shell:false with an explicit path is what npm
    // itself does.
    shell: process.platform === 'win32',
  });

  child.on('error', (err) => {
    console.error(`cached-lint: could not run ${tool}: ${err.message}`);
    process.exit(2);
  });
  // A tool killed by a signal must not read as success — the gate treats a
  // non-zero exit as failure, so map a signal death onto one.
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`cached-lint: ${tool} was killed by ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

main();
