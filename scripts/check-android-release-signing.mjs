#!/usr/bin/env node
/**
 * Guards the Android release bundle's signature for `npm run mobile:release`.
 *
 * ## Why
 *
 * `frontend/android/app/build.gradle` applies the upload signing config only
 * when the `ANDROID_UPLOAD_*` variables are set. When any is missing, Gradle
 * builds the release AAB unsigned and exits 0, and build-mobile-release.sh then
 * printed "Unsigned Android release bundle built" whether or not the bundle
 * was signed. The message was wrong in the signed case and gave no warning in
 * the unsigned one. Play rejects an unsigned bundle at upload, after the build
 * has already reported success.
 *
 * ## Two steps
 *
 * `preflight` runs before the build. It fails when any of the four signing
 * variables is missing or the keystore file does not exist, unless
 * `ALLOW_UNSIGNED_RELEASE=1` opts into an unsigned local smoke build.
 *
 * `verify <aab>` runs after `bundleRelease`. It checks the built bundle with
 * `jarsigner -verify`. When signing was configured, it also checks that the
 * signer's SHA-256 certificate fingerprint matches the configured key alias
 * in the keystore, using `keytool -printcert -jarfile` and `keytool -list`.
 * The success line states whether the bundle is signed and with which alias.
 *
 * Secret values are never printed or passed as command-line arguments. The
 * keystore password reaches keytool through `-storepass:env`, so it does not
 * appear in the process list. Only the key alias and the public certificate
 * fingerprint are printed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIGNING_KEYS = [
  'ANDROID_UPLOAD_KEYSTORE',
  'ANDROID_UPLOAD_KEYSTORE_PASSWORD',
  'ANDROID_UPLOAD_KEY_ALIAS',
  'ANDROID_UPLOAD_KEY_PASSWORD',
];

const OPT_IN = 'ALLOW_UNSIGNED_RELEASE';

export function allowsUnsigned(env) {
  return env[OPT_IN] === '1';
}

/**
 * Decides whether a release build may start. Returns
 * `{ ok, signed, alias, lines }`; `lines` never contains a secret value.
 */
export function preflight(env, { fileExists = existsSync } = {}) {
  const missing = SIGNING_KEYS.filter((key) => !env[key]);
  if (missing.length === 0) {
    if (!fileExists(env.ANDROID_UPLOAD_KEYSTORE)) {
      return {
        ok: false,
        signed: false,
        lines: [
          'Android release signing: ANDROID_UPLOAD_KEYSTORE does not point to an existing file.',
          'Fix the path before building; the bundle would not be signed with the upload key.',
        ],
      };
    }
    return {
      ok: true,
      signed: true,
      alias: env.ANDROID_UPLOAD_KEY_ALIAS,
      lines: [`Android release signing configured (key alias ${env.ANDROID_UPLOAD_KEY_ALIAS}).`],
    };
  }
  if (allowsUnsigned(env)) {
    return {
      ok: true,
      signed: false,
      lines: [
        `WARNING: ${OPT_IN}=1 and ${missing.join(', ')} not set.`,
        'This build produces an UNSIGNED Android bundle for a local smoke test. Play will reject it.',
      ],
    };
  }
  return {
    ok: false,
    signed: false,
    lines: [
      `Android release signing is not configured: missing ${missing.join(', ')}.`,
      'Without all four variables Gradle builds an unsigned bundle that Play rejects.',
      `Export them (docs/mobile-release-checklist.md), or set ${OPT_IN}=1 for a local unsigned smoke build.`,
    ],
  };
}

function javaTool(env, name) {
  if (env.JAVA_HOME) {
    const candidate = join(env.JAVA_HOME, 'bin', name);
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

function defaultRun(command, args, env) {
  const result = spawnSync(command, args, { encoding: 'utf8', env });
  return {
    status: result.error ? null : result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    error: result.error,
  };
}

const FINGERPRINT = /SHA-?256\)?:\s*([0-9A-F]{2}(?::[0-9A-F]{2}){31})/gi;

export function fingerprints(output) {
  return [...output.matchAll(FINGERPRINT)].map((match) => match[1].toUpperCase());
}

/**
 * Checks a built AAB. Returns `{ ok, signed, lines }`. `run` is injectable
 * so tests can stand in for jarsigner and keytool.
 */
export function verifyBundle(aabPath, env, { run = defaultRun, fileExists = existsSync } = {}) {
  if (!fileExists(aabPath)) {
    return { ok: false, signed: false, lines: [`Android release bundle not found: ${aabPath}`] };
  }
  const configured = SIGNING_KEYS.every((key) => Boolean(env[key]));

  const jarsigner = run(javaTool(env, 'jarsigner'), ['-verify', aabPath], env);
  if (jarsigner.status === null) {
    return {
      ok: false,
      signed: false,
      lines: [
        'Could not run jarsigner to check the Android bundle signature. Install a JDK or set JAVA_HOME.',
      ],
    };
  }
  const unsigned = /jar is unsigned/i.test(jarsigner.output);
  const verified = /jar verified/i.test(jarsigner.output);

  if (unsigned) {
    if (allowsUnsigned(env) && !configured) {
      return {
        ok: true,
        signed: false,
        lines: [
          `UNSIGNED Android release bundle built (${OPT_IN}=1): ${aabPath}`,
          'jarsigner -verify reports the bundle is unsigned. Do not upload it to Play.',
        ],
      };
    }
    return {
      ok: false,
      signed: false,
      lines: [
        `Android release bundle is UNSIGNED: ${aabPath}`,
        'jarsigner -verify reports the bundle is unsigned, so Play will reject it.',
      ],
    };
  }
  if (jarsigner.status !== 0 || !verified) {
    return {
      ok: false,
      signed: false,
      lines: [
        `jarsigner -verify did not verify the Android bundle: ${aabPath}`,
        'The signature is missing, broken, or unreadable. Rebuild with the upload key configured.',
      ],
    };
  }

  if (!configured) {
    return {
      ok: false,
      signed: true,
      lines: [
        `Android bundle is signed, but not with a configured upload key: ${aabPath}`,
        `Set all of ${SIGNING_KEYS.join(', ')} so the signer can be checked against the upload key alias.`,
      ],
    };
  }

  const signer = fingerprints(
    run(javaTool(env, 'keytool'), ['-printcert', '-jarfile', aabPath], env).output
  );
  const expected = fingerprints(
    run(
      javaTool(env, 'keytool'),
      [
        '-list',
        '-keystore',
        env.ANDROID_UPLOAD_KEYSTORE,
        '-alias',
        env.ANDROID_UPLOAD_KEY_ALIAS,
        '-storepass:env',
        'ANDROID_UPLOAD_KEYSTORE_PASSWORD',
      ],
      env
    ).output
  );
  const alias = env.ANDROID_UPLOAD_KEY_ALIAS;
  if (expected.length === 0) {
    return {
      ok: false,
      signed: true,
      lines: [
        `Could not read the certificate for key alias ${alias} from the upload keystore.`,
        'Check ANDROID_UPLOAD_KEY_ALIAS and ANDROID_UPLOAD_KEYSTORE_PASSWORD.',
      ],
    };
  }
  if (!signer.includes(expected[0])) {
    return {
      ok: false,
      signed: true,
      lines: [
        `Android bundle is signed, but not by key alias ${alias}: ${aabPath}`,
        `Expected signer SHA-256 ${expected[0]}; found ${signer.join(', ') || 'none'}.`,
      ],
    };
  }
  return {
    ok: true,
    signed: true,
    lines: [
      `Signed Android release bundle built: ${aabPath}`,
      `jarsigner -verify: jar verified. Signed with key alias ${alias} (certificate SHA-256 ${expected[0]}).`,
    ],
  };
}

function main(argv, env) {
  const [command, aabPath] = argv;
  let result;
  if (command === 'preflight') result = preflight(env);
  else if (command === 'verify' && aabPath) result = verifyBundle(aabPath, env);
  else {
    console.error('usage: check-android-release-signing.mjs preflight | verify <path-to-aab>');
    return 2;
  }
  const print = result.ok ? console.log : console.error;
  for (const line of result.lines) print(line);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
