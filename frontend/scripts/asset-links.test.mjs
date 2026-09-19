/**
 * The Android App Links claim, pinned.
 *
 * `build-asset-links.mjs --check` re-derives the intent-filter and evaluates
 * every declared route against it on each gate run. What these tests add is
 * the layer underneath: Android's matching rules as this repository models
 * them, the one-for-one mapping from the iOS components, and the refusal of
 * every fingerprint that is not a real SHA-256 digest — so the placeholder
 * path cannot quietly start producing a file.
 *
 * Run by `npm run test:edge`, a step of `npm run verify` and of CI's Test
 * Frontend job.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { declaredRoutePaths, sampleUrlFor } from './app-routes.mjs';
import { committedAssociation, partitionRoutes } from './app-site-association.mjs';
import {
  ANDROID_PACKAGE,
  APP_LINKS_HOST,
  FINGERPRINT_PLACEHOLDER_PREFIX,
  HANDLE_ALL_URLS,
  SIGNING_CERTIFICATES,
  androidDataFor,
  assetLinksDocument,
  committedAssetLinks,
  fingerprintProblem,
  iosAssociatedDomains,
  matchesAndroidData,
  readManifestBlock,
  renderAssetLinks,
  renderIntentFilterBlock,
  signingCertificateState,
} from './asset-links.mjs';

// Test digests, generated for this file. Not anyone's certificate.
const DIGEST_A =
  '3A:91:0C:5E:77:D2:18:B4:6F:E0:29:8D:C1:43:5A:0B:E6:7F:92:1D:44:C8:BA:03:5E:6D:71:F9:28:AE:14:C7';
const DIGEST_B =
  'B7:02:6E:C9:31:58:AD:E4:0F:92:7B:16:D3:48:A5:6C:E1:39:0D:84:F2:57:1B:C6:9E:23:70:D8:4F:05:BA:61';

test('the committed file follows the committed certificates: absent while pending', () => {
  const { state } = signingCertificateState();
  assert.notEqual(state, 'invalid');
  if (state === 'pending') {
    assert.equal(committedAssetLinks(), null);
    assert.ok(SIGNING_CERTIFICATES.playAppSigning.startsWith(FINGERPRINT_PLACEHOLDER_PREFIX));
    assert.ok(SIGNING_CERTIFICATES.upload.startsWith(FINGERPRINT_PLACEHOLDER_PREFIX));
  } else {
    assert.equal(committedAssetLinks(), renderAssetLinks());
  }
});

test('a placeholder, a SHA-1, a lowercase paste or a stand-in is never a fingerprint', () => {
  assert.match(fingerprintProblem(`${FINGERPRINT_PLACEHOLDER_PREFIX}_UPLOAD`), /placeholder/);
  assert.match(fingerprintProblem(DIGEST_A.split(':').slice(0, 20).join(':')), /SHA-1/);
  assert.match(fingerprintProblem(DIGEST_A.toLowerCase()), /lowercase/);
  assert.match(fingerprintProblem(DIGEST_A.replaceAll(':', '')), /not 32 uppercase hex pairs/);
  assert.match(fingerprintProblem(Array(32).fill('00').join(':')), /stand-in/);
  assert.match(fingerprintProblem(''), /empty/);
  assert.equal(fingerprintProblem(DIGEST_A), null);
});

test('both certificates are required, and they must differ', () => {
  const pending = `${FINGERPRINT_PLACEHOLDER_PREFIX}_PLAY_APP_SIGNING`;
  assert.equal(
    signingCertificateState({ playAppSigning: pending, upload: DIGEST_B }).state,
    'invalid'
  );
  assert.equal(
    signingCertificateState({ playAppSigning: DIGEST_A, upload: DIGEST_A }).state,
    'invalid'
  );
  assert.equal(
    signingCertificateState({ playAppSigning: DIGEST_A, upload: DIGEST_B }).state,
    'ready'
  );
});

test('the generator refuses to build a file from placeholders', () => {
  assert.throws(() => assetLinksDocument(SIGNING_CERTIFICATES), /placeholders/);
});

test('a ready file names the package and both certificates, app signing first', () => {
  const [statement] = assetLinksDocument({ playAppSigning: DIGEST_A, upload: DIGEST_B });
  assert.deepEqual(statement.relation, [HANDLE_ALL_URLS]);
  assert.equal(statement.target.namespace, 'android_app');
  assert.equal(statement.target.package_name, ANDROID_PACKAGE);
  assert.deepEqual(statement.target.sha256_cert_fingerprints, [DIGEST_A, DIGEST_B]);
});

test('each iOS component becomes exactly one Android path element', () => {
  assert.deepEqual(androidDataFor('/account'), { attribute: 'path', value: '/account' });
  assert.deepEqual(androidDataFor('/plants/*'), { attribute: 'pathPrefix', value: '/plants/' });
  assert.deepEqual(androidDataFor('/sit/*/brief'), {
    attribute: 'pathPattern',
    value: '/sit/.*/brief',
  });
  assert.throws(() => androidDataFor('/file.json'), /pathPattern would read/);
});

test("Android's matching: path is exact, a prefix and `.*` both cross a slash", () => {
  assert.ok(matchesAndroidData({ attribute: 'path', value: '/account' }, '/account'));
  assert.ok(!matchesAndroidData({ attribute: 'path', value: '/account' }, '/account-deletion'));
  assert.ok(matchesAndroidData({ attribute: 'pathPrefix', value: '/plants/' }, '/plants/a/b'));
  assert.ok(!matchesAndroidData({ attribute: 'pathPrefix', value: '/plants/' }, '/plants'));
  const brief = { attribute: 'pathPattern', value: '/sit/.*/brief' };
  assert.ok(matchesAndroidData(brief, '/sit/token/brief'));
  assert.ok(matchesAndroidData(brief, '/sit/a/b/brief'));
  assert.ok(!matchesAndroidData(brief, '/sit/token'));
});

test('the widening the check exists for is caught: a prefix /account claims /account-deletion', () => {
  // The negative control for the gate's "no web route opens the app"
  // assertion. If this ever stops matching, the gate cannot see the failure
  // it is there to catch.
  assert.ok(
    matchesAndroidData({ attribute: 'pathPrefix', value: '/account' }, '/account-deletion')
  );
});

test('the committed manifest opens every claimed route and no public one', () => {
  const { block, data } = readManifestBlock();
  assert.equal(block, renderIntentFilterBlock());
  assert.match(block, /<intent-filter android:autoVerify="true">/);

  const { claimed, web } = partitionRoutes(declaredRoutePaths());
  for (const route of claimed) {
    assert.ok(
      data.some((entry) => matchesAndroidData(entry, sampleUrlFor(route))),
      `${route} should open the app on Android`
    );
  }
  for (const route of web) {
    assert.ok(
      !data.some((entry) => matchesAndroidData(entry, sampleUrlFor(route))),
      `${route} must stay in the browser on Android`
    );
  }
  assert.ok(!data.some((entry) => matchesAndroidData(entry, '/account-deletion')));
});

test('Android mirrors the committed iOS components one for one, on the same domain', () => {
  const components = JSON.parse(committedAssociation()).applinks.details[0].components.map(
    (component) => component['/']
  );
  assert.deepEqual(readManifestBlock().data, components.map(androidDataFor));
  assert.deepEqual(iosAssociatedDomains(), [APP_LINKS_HOST]);
});
