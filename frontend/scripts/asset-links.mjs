/**
 * The Android App Links claim: the same familygreenhouse.net paths the iOS
 * universal-link claim opens in the app, stated the way Android reads them,
 * plus the Digital Asset Links file that lets Android verify the claim.
 *
 * ## One claim, two platforms
 *
 * The route decision already exists. `ROUTE_POLICY` in
 * `app-site-association.mjs` classifies every route App.tsx declares as
 * `app`, `app-subtree` or `web`, and `componentPatterns()` turns that into the
 * iOS components. This module does NOT keep a second copy of the decision. It
 * maps each iOS component to exactly one Android `<data>` element, in the
 * same order, so a route the app starts opening on iOS starts opening on
 * Android in the same regeneration, and a route that must stay in the browser
 * (`/account-deletion`, the email-link auth routes, every public page) stays
 * there on both.
 *
 * ## The one semantic difference, and why it is safe
 *
 * The iOS side reads `*` as one path segment (see the header of
 * app-site-association.mjs). Android's `pathPattern` has no character classes:
 * its `.*` crosses `/`. So the Android claim for `/plants/*` is
 * `pathPrefix="/plants/"`, which also accepts `/plants/a/b` — a URL the app
 * answers with its own not-found page, the same page the browser would show.
 * The widening only ever happens BELOW a claimed prefix, and no route
 * classified `web` sits below one; `build-asset-links.mjs --check` evaluates
 * every declared route against the committed manifest with Android's own
 * matching rules to prove that, rather than trusting this paragraph.
 *
 * `pathAdvancedPattern` (API 31+) could express one segment exactly, but
 * minSdk is 24 and older releases ignore the attribute, so it would buy
 * exactness on some devices and nothing on the rest.
 *
 * ## The signing certificates are config, and a placeholder never ships
 *
 * `assetlinks.json` names the SHA-256 fingerprint of every certificate an
 * installed copy of the app can be signed with. With Play App Signing that is
 * two different certificates:
 *
 *   - the **app signing** certificate — Google re-signs every install from
 *     Play with it, so it is the one that matters for real users;
 *   - the **upload** certificate — the key the maintainer signs the bundle
 *     with, which is also what a locally built or internally shared APK
 *     carries.
 *
 * Both are published on purpose; neither is a secret. They come from Play
 * Console → Test and release → App integrity → App signing, and they are
 * pasted into SIGNING_CERTIFICATES below. Until they are, the constants hold
 * sentinels that start with FINGERPRINT_PLACEHOLDER_PREFIX, and:
 *
 *   - `npm run aasa` writes the manifest's intent-filter but NOT the
 *     association file, and removes a stale one;
 *   - `npm run aasa:check` fails if an `assetlinks.json` is in the tree while
 *     the fingerprints are pending — a hand-written file is the only way one
 *     could get there, and a hand-written fingerprint is a guessed one;
 *   - `scripts/check-well-known.mjs` refuses any committed `assetlinks.json`
 *     whose fingerprints are not real SHA-256 digests;
 *   - all three deploy paths grep the built file for the sentinel and exit 1.
 *
 * A wrong fingerprint is this repository's "absence rendered as a value"
 * defect at its quietest: the file parses, deploys, is fetched by Google's
 * verifier with a 200, and every App Link silently keeps opening the browser.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { declaredRoutePaths } from './app-routes.mjs';
import { BUNDLE_ID, componentPatterns } from './app-site-association.mjs';
import { FRONTEND_ROOT } from './public-routes.mjs';

/** The Android package name. Same identifier as the iOS bundle; see docs/mobile.md. */
export const ANDROID_PACKAGE = BUNDLE_ID;

/**
 * The one host both platforms claim. Mirrors `applinks:familygreenhouse.net`
 * in ios/App/App/App.entitlements, and `aasa:check` asserts the two agree.
 * `www.` is not claimed on either platform: it redirects to the apex, and
 * Android's verifier does not follow redirects to fetch assetlinks.json.
 */
export const APP_LINKS_HOST = 'familygreenhouse.net';

/**
 * Every sentinel starts with this, and the deploy paths grep for it. Not a
 * plausible fingerprint — a real one is 32 colon-separated hex pairs — so it
 * cannot be mistaken for one by a person or by FINGERPRINT_PATTERN.
 */
export const FINGERPRINT_PLACEHOLDER_PREFIX = 'SHA256_PENDING';

/**
 * The two certificates, from Play Console → Test and release → App integrity
 * → App signing. Paste each "SHA-256 certificate fingerprint" exactly as Play
 * Console shows it (uppercase hex pairs separated by colons), then run
 * `npm run aasa --workspace frontend` and commit what it writes.
 *
 * Play creates the app signing key when the first bundle is uploaded, so the
 * app-signing value does not exist before that upload. See docs/mobile.md,
 * "Android App Links".
 */
export const SIGNING_CERTIFICATES = {
  playAppSigning: `${FINGERPRINT_PLACEHOLDER_PREFIX}_PLAY_APP_SIGNING`,
  upload: `${FINGERPRINT_PLACEHOLDER_PREFIX}_UPLOAD`,
};

/** What Play Console shows: 32 uppercase hex pairs separated by colons. */
export const FINGERPRINT_PATTERN = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** Play Console shows SHA-1 on the same card, one row up. */
const SHA1_PATTERN = /^(?:[0-9A-Fa-f]{2}:){19}[0-9A-Fa-f]{2}$/;

const LABELS = {
  playAppSigning: 'the Play app signing certificate',
  upload: 'the upload certificate',
};

/** Why `value` cannot be published as a fingerprint, or `null` if it can. */
export function fingerprintProblem(value) {
  if (typeof value !== 'string' || value.length === 0) return 'it is empty';
  if (value.startsWith(FINGERPRINT_PLACEHOLDER_PREFIX)) {
    return `it is the placeholder \`${value}\``;
  }
  if (SHA1_PATTERN.test(value)) {
    return 'it is a SHA-1 fingerprint (20 pairs); Android App Links need the SHA-256 row (32 pairs)';
  }
  if (FINGERPRINT_PATTERN.test(value.toUpperCase()) && value !== value.toUpperCase()) {
    return 'it is lowercase; paste it exactly as Play Console shows it, in uppercase';
  }
  if (!FINGERPRINT_PATTERN.test(value)) {
    return `\`${value}\` is not 32 uppercase hex pairs separated by colons`;
  }
  // A digest whose 32 bytes are all the same is a typed-in stand-in, not the
  // SHA-256 of any certificate anyone will ever sign with.
  if (new Set(value.split(':')).size === 1) {
    return `\`${value}\` repeats one byte 32 times, which is a stand-in, not a certificate digest`;
  }
  return null;
}

/**
 * Where the signing certificates stand.
 *
 *   `pending` — both are still sentinels. A legitimate state: no association
 *               file is written, and nothing can ship.
 *   `ready`   — both are real, distinct fingerprints.
 *   `invalid` — anything else, including exactly one pasted. Refused
 *               everywhere, because a file naming only one certificate
 *               verifies for some installs and not others.
 */
export function signingCertificateState(certificates = SIGNING_CERTIFICATES) {
  const keys = Object.keys(LABELS);
  const pending = keys.filter((key) =>
    String(certificates[key] ?? '').startsWith(FINGERPRINT_PLACEHOLDER_PREFIX)
  );
  if (pending.length === keys.length) return { state: 'pending', problems: [] };

  const problems = [];
  for (const key of keys) {
    const problem = fingerprintProblem(certificates[key]);
    if (problem !== null) problems.push(`${LABELS[key]} (${key}): ${problem}`);
  }
  if (
    problems.length === 0 &&
    certificates.playAppSigning.toUpperCase() === certificates.upload.toUpperCase()
  ) {
    problems.push(
      'the app signing and upload certificates are the same value. With Play App Signing they ' +
        'are different keys; the same row was probably pasted twice.'
    );
  }
  return problems.length > 0 ? { state: 'invalid', problems } : { state: 'ready', problems: [] };
}

/** Where the association file is committed, to be copied into `dist/`. */
export const ASSET_LINKS_PATH = join(FRONTEND_ROOT, 'public', '.well-known', 'assetlinks.json');

/** The Android manifest that carries the intent-filter. */
export const MANIFEST_PATH = join(
  FRONTEND_ROOT,
  'android',
  'app',
  'src',
  'main',
  'AndroidManifest.xml'
);

/** The iOS entitlements whose associated domain the Android host must match. */
export const ENTITLEMENTS_PATH = join(FRONTEND_ROOT, 'ios', 'App', 'App', 'App.entitlements');

/** The relation that makes a statement an App Links claim. */
export const HANDLE_ALL_URLS = 'delegate_permission/common.handle_all_urls';

/**
 * The Digital Asset Links document. `handle_all_urls` only — the Android
 * counterpart of the iOS file's `applinks`-only scope. Credential sharing
 * (`get_login_creds`) is the counterpart of `webcredentials`, and like it is
 * not built.
 */
export function assetLinksDocument(certificates = SIGNING_CERTIFICATES) {
  const { state, problems } = signingCertificateState(certificates);
  if (state !== 'ready') {
    throw new Error(
      state === 'pending'
        ? 'Refusing to build assetlinks.json: the signing-certificate fingerprints are still ' +
            'placeholders. Paste both from Play Console → Test and release → App integrity → ' +
            'App signing into SIGNING_CERTIFICATES in frontend/scripts/asset-links.mjs.'
        : `Refusing to build assetlinks.json: ${problems.join('; ')}.`
    );
  }
  return [
    {
      relation: [HANDLE_ALL_URLS],
      target: {
        namespace: 'android_app',
        package_name: ANDROID_PACKAGE,
        sha256_cert_fingerprints: [certificates.playAppSigning, certificates.upload],
      },
    },
  ];
}

/** Exactly the bytes the committed association file must contain. */
export function renderAssetLinks(certificates = SIGNING_CERTIFICATES) {
  return `${JSON.stringify(assetLinksDocument(certificates), null, 2)}\n`;
}

/** The committed association file's bytes, or `null` when it is not in the tree. */
export function committedAssetLinks() {
  try {
    return readFileSync(ASSET_LINKS_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * One iOS component as one Android `<data>` element.
 *
 *   no wildcard            → `android:path` (exact, like the iOS component)
 *   a single trailing `/*` → `android:pathPrefix` (see the header: wider on
 *                            Android, and only below a claimed prefix)
 *   anything else          → `android:pathPattern`, `*` as `.*`, `?` as `.`
 *
 * A literal `.` or `\` would need Android's double escaping in XML; no route
 * has one, so meeting one is an error rather than a guess.
 */
export function androidDataFor(pattern) {
  if (/[.\\]/.test(pattern)) {
    throw new Error(
      `AASA component ${pattern} contains "." or "\\", which pathPattern would read as a ` +
        'wildcard or an escape. Teach androidDataFor() the escaping before claiming it.'
    );
  }
  const wildcards = pattern.match(/[*?]/g) ?? [];
  if (wildcards.length === 0) return { attribute: 'path', value: pattern };
  if (wildcards.length === 1 && pattern.endsWith('/*')) {
    return { attribute: 'pathPrefix', value: pattern.slice(0, -1) };
  }
  return { attribute: 'pathPattern', value: pattern.replaceAll('*', '.*').replaceAll('?', '.') };
}

/** Every Android `<data>` path element, one per iOS component, in iOS order. */
export function androidPathData(declared = declaredRoutePaths()) {
  return componentPatterns(declared).map((pattern) => ({ pattern, ...androidDataFor(pattern) }));
}

/**
 * Does an Android `<data>` path element accept `path`? Android's own rules
 * (android.os.PatternMatcher): `path` is literal, `pathPrefix` is a prefix,
 * and in `pathPattern` `.` is any character and `*` repeats the character
 * before it — so `.*` is any run of characters, `/` included.
 */
export function matchesAndroidData({ attribute, value }, path) {
  if (attribute === 'path') return path === value;
  if (attribute === 'pathPrefix') return path.startsWith(value);
  if (attribute !== 'pathPattern') throw new Error(`unknown <data> attribute ${attribute}`);
  let source = '^';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    source += character === '.' ? '[\\s\\S]' : character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (value[index + 1] === '*') {
      source += '*';
      index += 1;
    }
  }
  return new RegExp(`${source}$`).test(path);
}

export const BLOCK_START =
  '<!-- android-app-links:start. Generated by frontend/scripts/build-asset-links.mjs from ' +
  'ROUTE_POLICY; regenerate with npm run aasa, never hand-edit. -->';
export const BLOCK_END = '<!-- android-app-links:end -->';

/** Indentation of the block inside `<activity>`. */
const INDENT = ' '.repeat(12);

/**
 * The intent-filter, as the exact lines between (and including) the markers.
 *
 * One filter, one host, `https` only. `autoVerify` makes Android fetch
 * https://familygreenhouse.net/.well-known/assetlinks.json at install and on
 * every update; on Android 12+ an unverified filter never opens the app for a
 * web link, and on older releases it offers a chooser instead.
 */
export function renderIntentFilterBlock(declared = declaredRoutePaths()) {
  const inner = ' '.repeat(16);
  const lines = [
    BLOCK_START,
    '<intent-filter android:autoVerify="true">',
    `${inner}<action android:name="android.intent.action.VIEW" />`,
    `${inner}<category android:name="android.intent.category.DEFAULT" />`,
    `${inner}<category android:name="android.intent.category.BROWSABLE" />`,
    `${inner}<data android:scheme="https" />`,
    `${inner}<data android:host="${APP_LINKS_HOST}" />`,
    ...androidPathData(declared).map(
      ({ attribute, value }) => `${inner}<data android:${attribute}="${value}" />`
    ),
    '</intent-filter>',
    BLOCK_END,
  ];
  return lines.map((line) => (line.startsWith(' ') ? line : `${INDENT}${line}`)).join('\n');
}

/**
 * The committed manifest's generated block, the manifest with it removed, and
 * the `<data>` path elements the block declares. Throws on a manifest without
 * exactly one pair of markers.
 */
export function readManifestBlock(source = readFileSync(MANIFEST_PATH, 'utf8')) {
  const start = source.indexOf(BLOCK_START);
  const end = source.indexOf(BLOCK_END);
  if (
    start === -1 ||
    end === -1 ||
    end < start ||
    source.indexOf(BLOCK_START, start + 1) !== -1 ||
    source.indexOf(BLOCK_END, end + 1) !== -1
  ) {
    throw new Error(
      'AndroidManifest.xml must carry exactly one android-app-links:start/end marker pair ' +
        'inside the MainActivity <activity>.'
    );
  }
  const lineStart = source.lastIndexOf('\n', start) + 1;
  const block = source.slice(lineStart, end + BLOCK_END.length);
  const outside = source.slice(0, lineStart) + source.slice(end + BLOCK_END.length);
  const data = [...block.matchAll(/<data android:(path|pathPrefix|pathPattern)="([^"]*)"/g)].map(
    ([, attribute, value]) => ({ attribute, value })
  );
  return { block, outside, data };
}

/** The `applinks:` domains the iOS entitlements declare. */
export function iosAssociatedDomains(source = readFileSync(ENTITLEMENTS_PATH, 'utf8')) {
  return [...source.matchAll(/<string>applinks:([^<]+)<\/string>/g)].map(([, host]) => host);
}
