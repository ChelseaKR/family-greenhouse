#!/usr/bin/env node
/**
 * App Store / Play Store preflight on the native app projects, run the same way
 * locally (`npm run verify`, the pre-push hook) and in CI.
 *
 * ## What it runs
 *
 * Greenlight (github.com/RevylAI/greenlight, MIT) reads the iOS and Android
 * projects and reports the things App Review and Play review reject for:
 *
 *   greenlight preflight frontend/ios      --exit-code
 *   greenlight playscan  frontend/android  --exit-code
 *
 * `--exit-code` fails on any CRITICAL or HIGH finding and on a scanner crash.
 * Both commands are static: no account, no network, no upload. This script
 * never runs `scan` (App Store Connect API), `verify` or `--verify` (flows on a
 * third-party cloud device); nothing here can reach them.
 *
 * Only the two app projects are scanned, never the repo root. Measured against
 * the root on 2026-10-23, greenlight's privacy scanner greps test files and
 * `.claude/worktrees/*` checkouts and reported two CRITICAL and one HIGH that
 * were all false positives (a backend test whose title says "Google Analytics
 * 4", and a dashboard source file in a worktree). The web bundle is not a
 * target: it is not in the tree at gate time, and the native projects carry no
 * copy of it until `cap sync`.
 *
 * ## The pin
 *
 *   version  v0.2.0
 *   commit   db0ec50f0f8bdefc8d3d4e525cb935f2ef9014c5  (the v0.2.0 tag)
 *   module   h1:IqoEUPzz+JV4C0jd4Lfbg/VoHZRT+CBxNlOIDkXban4=
 *
 * The binary is built with `go install github.com/RevylAI/greenlight/cmd/
 * greenlight@v0.2.0` into `.tools/greenlight/<version>-<commit12>/` (git-
 * ignored, one build per checkout, none at gate time after that). Before it
 * builds, `go mod download -json` is asked what v0.2.0 resolves to, and the
 * install is REFUSED unless the module's h1 hash AND the git commit both equal
 * the constants below, so a moved tag or a tampered proxy fails loudly instead
 * of changing what the gate runs. Never `@latest`: a scanner whose rules change
 * under the gate turns an unrelated PR red. To upgrade, change the three
 * constants together, run the controls, and record why in the PR.
 *
 * Why this tool at all: App Review rejections (a missing privacy manifest, an
 * undeclared Required Reason API, a restricted Android permission) cost a
 * review cycle of days each, and nothing in this repo's gate read the native
 * projects. validate-store-release.mjs checks versions and listing metadata
 * only.
 *
 * ## Findings the baseline accepts (frontend/ios/.greenlight.yml)
 *
 * None since 2026-10-24: the one path it held (NativeReviewPlugin.swift, for
 * the StoreKit import with no restore) went when the app gained Restore
 * purchases (ADR 0041). The `ignore:` list applies to the code scan only; the
 * privacy scanner has no baseline, and its one INFO on this project (a
 * substring match, see the config file) does not fail the gate.
 *
 * ## Missing tool
 *
 * If the pinned binary cannot be built (no `go`, or offline on a first run),
 * locally the step prints `SKIPPED: greenlight not installed` and exits 78,
 * which scripts/run-gate.mjs reports as SKIP and does NOT count as passed.
 * In CI (`CI` set) it exits 1: a skipped preflight there is a gate that
 * cannot fail. A hash or commit mismatch is always a failure, never a skip.
 *
 * ## Controls
 *
 * Every run also proves the scanner can fail, on temp COPIES of the projects
 * (the real tree is never touched). For each, the seeding is asserted to have
 * changed the copy before the scan is expected to fail, so a sabotage that
 * silently applied nothing cannot read as a pass:
 *
 *   - iOS: PrivacyInfo.xcprivacy deleted               -> CRITICAL
 *   - iOS: NativePurchasesPlugin.swift removed          -> HIGH (Restore
 *          purchases lives there; without it StoreKit has no restore)
 *   - Android: READ_SMS added to the manifest          -> HIGH
 *
 * The scans take ~100ms each, so this costs the gate well under a second.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PIN = Object.freeze({
  module: 'github.com/RevylAI/greenlight',
  pkg: 'github.com/RevylAI/greenlight/cmd/greenlight',
  version: 'v0.2.0',
  commit: 'db0ec50f0f8bdefc8d3d4e525cb935f2ef9014c5',
  sum: 'h1:IqoEUPzz+JV4C0jd4Lfbg/VoHZRT+CBxNlOIDkXban4=',
});

/** Exit status run-gate.mjs reads as "skipped, not passed" (sysexits EX_CONFIG). */
export const SKIP_EXIT = 78;

export const IOS = 'frontend/ios';
export const ANDROID = 'frontend/android';

const VERDICT_OK = /GREENLIT|LOOKS GOOD/;

export const binDir = (root = ROOT) =>
  join(root, '.tools', 'greenlight', `${PIN.version}-${PIN.commit.slice(0, 12)}`);
export const binPath = (root = ROOT) => join(binDir(root), 'greenlight');

export const inCI = (env = process.env) => Boolean(env.CI) && env.CI !== 'false';

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
    ...opts,
  });
}

/** Does the module resolve to exactly the pinned bytes and commit? Throws if not. */
export function assertPinnedModule(info) {
  const problems = [];
  if (info?.Version !== PIN.version) problems.push(`version ${info?.Version} != ${PIN.version}`);
  if (info?.Sum !== PIN.sum) problems.push(`module hash ${info?.Sum} != ${PIN.sum}`);
  if (info?.Origin?.Hash !== PIN.commit) {
    problems.push(`commit ${info?.Origin?.Hash} != ${PIN.commit}`);
  }
  if (problems.length > 0) {
    throw new IntegrityError(
      `${PIN.module}@${PIN.version} is not what this repo pinned: ${problems.join('; ')}. ` +
        'Refusing to build it. If the upgrade is intended, change PIN in scripts/check-greenlight.mjs.'
    );
  }
}

export class IntegrityError extends Error {}

/**
 * Finds (building if needed) the pinned binary. Returns `{ bin }` or
 * `{ unavailable: reason }`. Throws IntegrityError on a pin mismatch.
 */
export function ensureBinary(root = ROOT) {
  const bin = binPath(root);
  if (existsSync(bin)) return { bin };

  const goVersion = run('go', ['version']);
  if (goVersion.error || goVersion.status !== 0) {
    return { unavailable: '`go` is not on PATH (needed once, to build the pinned scanner)' };
  }

  const spec = `${PIN.module}@${PIN.version}`;
  const dl = run('go', ['mod', 'download', '-json', spec]);
  let info;
  try {
    info = JSON.parse(dl.stdout || '{}');
  } catch {
    info = {};
  }
  if (dl.status !== 0 && !info.Sum) {
    return {
      unavailable: `could not download ${spec}: ${(dl.stderr || '').trim().split('\n').pop()}`,
    };
  }
  assertPinnedModule(info);

  // Build into a private directory and rename it into place, so two gates
  // starting together in one checkout never run a half-written binary.
  mkdirSync(dirname(binDir(root)), { recursive: true });
  const staging = mkdtempSync(join(dirname(binDir(root)), '.staging-'));
  try {
    const inst = run('go', ['install', `${PIN.pkg}@${PIN.version}`], {
      env: { ...process.env, GOBIN: staging, GOTOOLCHAIN: 'local' },
    });
    if (inst.status !== 0 || !existsSync(join(staging, 'greenlight'))) {
      return {
        unavailable: `go install ${PIN.pkg}@${PIN.version} failed: ${(inst.stderr || '').trim().split('\n').pop()}`,
      };
    }
    try {
      renameSync(staging, binDir(root));
    } catch (err) {
      // Lost the race to another process that finished first: use theirs.
      if (!existsSync(bin)) throw err;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { bin };
}

/** Runs the scanner; returns { status, out }. A spawn failure is status null. */
export function scan(bin, kind, target) {
  const args =
    kind === 'ios' ? ['preflight', target, '--exit-code'] : ['playscan', target, '--exit-code'];
  const r = run(bin, args);
  return {
    status: r.error ? null : r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ?? ''}`,
  };
}

/** A digest of every file path and content under `dir`, to prove a copy changed. */
export function digestTree(dir) {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(p.slice(dir.length)).update('\0').update(readFileSync(p)).update('\0');
    }
  };
  walk(dir);
  return h.digest('hex');
}

/**
 * The controls: [name, kind, project dir, mutate(copyRoot), expected output].
 * `mutate` edits a temp copy of the project and returns nothing.
 */
export const CONTROLS = [
  {
    name: 'ios: PrivacyInfo.xcprivacy deleted',
    kind: 'ios',
    project: IOS,
    seed: (copy) => rmSync(join(copy, 'App/App/PrivacyInfo.xcprivacy')),
    expect: /\[CRITICAL\].*No PrivacyInfo\.xcprivacy found/,
  },
  {
    // The app sells through StoreKit (ADR 0041) and its Restore purchases
    // lives in NativePurchasesPlugin.swift. Without that file the remaining
    // `import StoreKit` (NativeReviewPlugin.swift, the rating sheet) has no
    // restore beside it, so the 3.1.1 rule must fire: proof the rule is live
    // and that the plugin is what satisfies it.
    name: 'ios: Restore purchases removed (iap-no-restore returns)',
    kind: 'ios',
    project: IOS,
    seed: (copy) => rmSync(join(copy, 'App/App/NativePurchasesPlugin.swift')),
    expect: /\[HIGH\].*In-app purchases without restore functionality/,
  },
  {
    name: 'android: READ_SMS added to the manifest',
    kind: 'android',
    project: ANDROID,
    seed: (copy) => {
      const manifest = join(copy, 'app/src/main/AndroidManifest.xml');
      const xml = readFileSync(manifest, 'utf8');
      const marker = '<uses-permission android:name="android.permission.INTERNET" />';
      if (!xml.includes(marker))
        throw new Error(`control cannot seed: ${marker} not in the manifest`);
      writeFileSync(
        manifest,
        xml.replace(
          marker,
          `${marker}\n    <uses-permission android:name="android.permission.READ_SMS" />`
        )
      );
    },
    expect: /\[HIGH\].*SMS and Call Log permissions/,
  },
];

function runControl(bin, ctl, root) {
  const tmp = mkdtempSync(join(tmpdir(), 'fg-greenlight-'));
  try {
    const copy = join(tmp, ctl.kind);
    cpSync(join(root, ctl.project), copy, { recursive: true });
    const before = digestTree(copy);
    ctl.seed(copy);
    if (digestTree(copy) === before) {
      return `control "${ctl.name}": seeding did not change the copy, so a failing scan proves nothing`;
    }
    const r = scan(bin, ctl.kind, copy);
    if (r.status === 0 || r.status === null) {
      return `control "${ctl.name}": expected a non-zero exit from the seeded copy, got ${r.status}\n${r.out}`;
    }
    if (!ctl.expect.test(r.out)) {
      return `control "${ctl.name}": exited ${r.status} but not for the seeded reason (${ctl.expect})\n${r.out}`;
    }
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function main(root = ROOT) {
  let found;
  try {
    found = ensureBinary(root);
  } catch (err) {
    if (err instanceof IntegrityError) {
      console.error(`greenlight: ${err.message}`);
      return 1;
    }
    throw err;
  }

  if (found.unavailable) {
    if (inCI()) {
      console.error(
        `greenlight: FAILED in CI: ${found.unavailable}. A skipped preflight there proves nothing.`
      );
      return 1;
    }
    console.log(`SKIPPED: greenlight not installed (${found.unavailable}).`);
    console.log(
      'SKIPPED: the App Store / Play Store preflight did NOT run; the gate does not count it as passed.'
    );
    return SKIP_EXIT;
  }

  const bin = found.bin;
  const failures = [];

  for (const [kind, target] of [
    ['ios', IOS],
    ['android', ANDROID],
  ]) {
    const dir = join(root, target);
    if (!existsSync(dir)) {
      failures.push(`${target} does not exist: a preflight of nothing is not a pass`);
      continue;
    }
    const r = scan(bin, kind, dir);
    // Exit 0 alone is not trusted: a scan that produced no verdict ran nothing.
    if (r.status !== 0 || !VERDICT_OK.test(r.out)) {
      failures.push(
        `${kind === 'ios' ? 'preflight' : 'playscan'} ${target} (exit ${r.status})\n${r.out}`
      );
    } else {
      console.log(`ok  ${kind === 'ios' ? 'preflight' : 'playscan'} ${target}`);
    }
  }

  for (const ctl of CONTROLS) {
    let problem;
    try {
      problem = runControl(bin, ctl, root);
    } catch (err) {
      // A seed that cannot apply (the real tree is already missing the file it
      // deletes) is a problem to report next to the real finding, not a crash
      // that hides it.
      problem = `control "${ctl.name}" could not run: ${err.message}`;
    }
    if (problem) failures.push(problem);
    else console.log(`ok  control: ${ctl.name} fails as expected`);
  }

  if (failures.length > 0) {
    console.error(`\ngreenlight: ${failures.length} problem(s)\n`);
    for (const f of failures) console.error(`${f}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
