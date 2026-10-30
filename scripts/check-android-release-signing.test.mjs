import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SIGNING_KEYS,
  fingerprints,
  preflight,
  verifyBundle,
} from './check-android-release-signing.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-android-release-signing.mjs');
const SECRET = 'do-not-print-this-password';
const FP_A = Array.from({ length: 32 }, () => 'AA').join(':');
const FP_B = Array.from({ length: 32 }, () => 'BB').join(':');

const signingEnv = {
  ANDROID_UPLOAD_KEYSTORE: '/keys/upload.jks',
  ANDROID_UPLOAD_KEYSTORE_PASSWORD: SECRET,
  ANDROID_UPLOAD_KEY_ALIAS: 'fg-upload',
  ANDROID_UPLOAD_KEY_PASSWORD: SECRET,
};
const exists = () => true;

function assertNoSecret(result) {
  assert.ok(!result.lines.join('\n').includes(SECRET), 'a secret value was printed');
}

// --- preflight -------------------------------------------------------------

test('preflight passes with all four signing variables and names the alias', () => {
  const result = preflight(signingEnv, { fileExists: exists });
  assert.equal(result.ok, true);
  assert.equal(result.signed, true);
  assert.match(result.lines.join('\n'), /key alias fg-upload/);
  assertNoSecret(result);
});

for (const key of SIGNING_KEYS) {
  test(`preflight fails when ${key} is missing`, () => {
    const env = { ...signingEnv, [key]: '' };
    const result = preflight(env, { fileExists: exists });
    assert.equal(result.ok, false);
    assert.match(result.lines.join('\n'), new RegExp(`missing ${key}`));
    assertNoSecret(result);
  });
}

test('preflight fails with no signing variables at all', () => {
  const result = preflight({}, { fileExists: exists });
  assert.equal(result.ok, false);
  assert.match(result.lines.join('\n'), /ALLOW_UNSIGNED_RELEASE=1/);
});

test('ALLOW_UNSIGNED_RELEASE=1 permits an unsigned smoke build with a warning', () => {
  const result = preflight({ ALLOW_UNSIGNED_RELEASE: '1' }, { fileExists: exists });
  assert.equal(result.ok, true);
  assert.equal(result.signed, false);
  assert.match(result.lines.join('\n'), /UNSIGNED/);
});

test('only the exact value 1 opts in', () => {
  for (const value of ['true', 'yes', '0', '']) {
    assert.equal(
      preflight({ ALLOW_UNSIGNED_RELEASE: value }, { fileExists: exists }).ok,
      false,
      value
    );
  }
});

test('preflight fails when the keystore file does not exist', () => {
  const result = preflight(signingEnv, { fileExists: () => false });
  assert.equal(result.ok, false);
  assertNoSecret(result);
});

// --- verify with stand-in tools ---------------------------------------------

function fakeRun({ jarsigner, signerFp = FP_A, keyFp = FP_A }) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command.endsWith('jarsigner')) return { status: 0, output: jarsigner };
    if (args[0] === '-printcert')
      return { status: 0, output: `Signer #1:\n\tSHA256: ${signerFp}\n` };
    return {
      status: 0,
      output: `fg-upload, PrivateKeyEntry,\nCertificate fingerprint (SHA-256): ${keyFp}\n`,
    };
  };
  return { run, calls };
}

test('a signed bundle whose signer matches the alias passes and says so', () => {
  const { run, calls } = fakeRun({ jarsigner: 'jar verified.\n' });
  const result = verifyBundle('app-release.aab', signingEnv, { run, fileExists: exists });
  assert.equal(result.ok, true);
  assert.equal(result.signed, true);
  const text = result.lines.join('\n');
  assert.match(text, /^Signed Android release bundle built/);
  assert.match(text, /key alias fg-upload/);
  assert.match(text, /jar verified/);
  assertNoSecret(result);
  // The password reaches keytool through the environment, never argv.
  assert.ok(!calls.flat().includes(SECRET));
  assert.ok(calls.some((call) => call.includes('-storepass:env')));
});

test('an unsigned bundle fails when signing was expected', () => {
  const { run } = fakeRun({ jarsigner: 'jar is unsigned.\n' });
  const result = verifyBundle('app-release.aab', signingEnv, { run, fileExists: exists });
  assert.equal(result.ok, false);
  assert.match(result.lines.join('\n'), /UNSIGNED/);
});

test('an unsigned bundle fails without the opt-in', () => {
  const { run } = fakeRun({ jarsigner: 'jar is unsigned.\n' });
  assert.equal(verifyBundle('app-release.aab', {}, { run, fileExists: exists }).ok, false);
});

test('an unsigned bundle passes with the opt-in and is labeled UNSIGNED', () => {
  const { run } = fakeRun({ jarsigner: 'jar is unsigned.\n' });
  const result = verifyBundle(
    'app-release.aab',
    { ALLOW_UNSIGNED_RELEASE: '1' },
    { run, fileExists: exists }
  );
  assert.equal(result.ok, true);
  assert.equal(result.signed, false);
  assert.match(result.lines[0], /^UNSIGNED Android release bundle built/);
});

test('a bundle signed by a different key fails', () => {
  const { run } = fakeRun({ jarsigner: 'jar verified.\n', signerFp: FP_B });
  const result = verifyBundle('app-release.aab', signingEnv, { run, fileExists: exists });
  assert.equal(result.ok, false);
  assert.match(result.lines.join('\n'), /not by key alias fg-upload/);
});

test('a broken signature fails', () => {
  const { run } = fakeRun({ jarsigner: 'jarsigner: java.lang.SecurityException: digest error\n' });
  assert.equal(verifyBundle('app-release.aab', signingEnv, { run, fileExists: exists }).ok, false);
});

test('a missing jarsigner fails instead of passing', () => {
  const run = () => ({ status: null, output: '' });
  assert.equal(verifyBundle('app-release.aab', signingEnv, { run, fileExists: exists }).ok, false);
});

test('a missing bundle fails', () => {
  assert.equal(verifyBundle('nope.aab', signingEnv, { fileExists: () => false }).ok, false);
});

test('fingerprints reads keytool -list and -printcert formats', () => {
  assert.deepEqual(fingerprints(`Certificate fingerprint (SHA-256): ${FP_A}`), [FP_A]);
  assert.deepEqual(fingerprints(`\t SHA256: ${FP_B.toLowerCase()}`), [FP_B]);
  assert.deepEqual(fingerprints('Not a signed jar file'), []);
});

// --- the CLI the build script calls ------------------------------------------

function cli(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
}

test('the CLI preflight exits non-zero when signing is missing', () => {
  const result = cli(['preflight'], {});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing ANDROID_UPLOAD_KEYSTORE/);
});

test('the CLI preflight exits zero with ALLOW_UNSIGNED_RELEASE=1', () => {
  assert.equal(cli(['preflight'], { ALLOW_UNSIGNED_RELEASE: '1' }).status, 0);
});

// --- real jarsigner and keytool, both paths -------------------------------

function jdkTool(name) {
  const home = process.env.JAVA_HOME;
  if (home && existsSync(join(home, 'bin', name))) return join(home, 'bin', name);
  const probe = spawnSync(name, ['-help'], { encoding: 'utf8' });
  return probe.error ? null : name;
}

const keytool = jdkTool('keytool');
const jarsigner = jdkTool('jarsigner');
const jar = jdkTool('jar');
const noJdk =
  !keytool || !jarsigner || !jar ? 'no JDK (keytool, jarsigner, jar) on this machine' : false;

test('real JDK: unsigned and signed bundles are told apart', { skip: noJdk }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'fg-signing-'));
  try {
    const keystore = join(dir, 'upload.jks');
    const env = {
      PATH: process.env.PATH,
      JAVA_HOME: process.env.JAVA_HOME ?? '',
      ANDROID_UPLOAD_KEYSTORE: keystore,
      ANDROID_UPLOAD_KEYSTORE_PASSWORD: SECRET,
      ANDROID_UPLOAD_KEY_ALIAS: 'fg-upload',
      ANDROID_UPLOAD_KEY_PASSWORD: SECRET,
    };
    const gen = spawnSync(
      keytool,
      [
        '-genkeypair',
        '-keystore',
        keystore,
        '-storepass:env',
        'ANDROID_UPLOAD_KEYSTORE_PASSWORD',
        '-keypass:env',
        'ANDROID_UPLOAD_KEY_PASSWORD',
        '-alias',
        'fg-upload',
        '-keyalg',
        'RSA',
        '-keysize',
        '2048',
        '-validity',
        '2',
        '-dname',
        'CN=fg-signing-test',
      ],
      { encoding: 'utf8', env }
    );
    assert.equal(gen.status, 0, gen.stderr);

    writeFileSync(join(dir, 'payload.txt'), 'bundle');
    const unsigned = join(dir, 'unsigned.aab');
    const made = spawnSync(jar, ['cf', unsigned, '-C', dir, 'payload.txt'], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);

    const unsignedRun = cli(['verify', unsigned], env);
    assert.equal(unsignedRun.status, 1, unsignedRun.stdout + unsignedRun.stderr);
    assert.match(unsignedRun.stderr, /UNSIGNED/);
    const allowed = cli(['verify', unsigned], {
      ...env,
      ...Object.fromEntries(SIGNING_KEYS.map((k) => [k, ''])),
      ALLOW_UNSIGNED_RELEASE: '1',
    });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /^UNSIGNED Android release bundle built/);

    const signed = join(dir, 'signed.aab');
    copyFileSync(unsigned, signed);
    const sign = spawnSync(
      jarsigner,
      [
        '-keystore',
        keystore,
        '-storepass:env',
        'ANDROID_UPLOAD_KEYSTORE_PASSWORD',
        '-keypass:env',
        'ANDROID_UPLOAD_KEY_PASSWORD',
        signed,
        'fg-upload',
      ],
      { encoding: 'utf8', env }
    );
    assert.equal(sign.status, 0, sign.stdout + sign.stderr);

    const signedRun = cli(['verify', signed], env);
    assert.equal(signedRun.status, 0, signedRun.stdout + signedRun.stderr);
    assert.match(signedRun.stdout, /^Signed Android release bundle built/);
    assert.match(signedRun.stdout, /key alias fg-upload/);
    assert.ok(!(signedRun.stdout + signedRun.stderr).includes(SECRET));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
