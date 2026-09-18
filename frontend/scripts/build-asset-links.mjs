#!/usr/bin/env node
/**
 * Generate — and, with `--check`, verify — the Android half of the app-link
 * claim: the `autoVerify` intent-filter in AndroidManifest.xml and
 * `frontend/public/.well-known/assetlinks.json`.
 *
 * The sibling of `build-app-site-association.mjs`, with the same rules: both
 * artifacts are committed, both are derived (the intent-filter from the iOS
 * components, the association file from SIGNING_CERTIFICATES), and `--check`
 * WRITES NOTHING. `npm run aasa` runs both generators and `npm run aasa:check`
 * runs both checks, so the two platforms cannot be regenerated or gated apart.
 *
 * `--check` asserts, against the COMMITTED files:
 *
 *   1. The manifest's generated block is byte-identical to the generator's
 *      output, and nothing outside it declares `autoVerify` or a host.
 *   2. Its `<data>` paths are exactly the committed iOS components, one for
 *      one, in order — the "mirror the iOS list" rule, checked against the
 *      file Apple fetches rather than against the generator.
 *   3. Evaluated with Android's own matching rules, every route ROUTE_POLICY
 *      claims opens the app, and NO route classified `web` does.
 *      `/account-deletion` is the one that matters: App Review and Play
 *      policy both expect deletion to work for someone who cannot sign in.
 *   4. The Android host is the iOS associated domain.
 *   5. `assetlinks.json` is ABSENT while the fingerprints are placeholders,
 *      and byte-identical to the generator's output once they are real.
 *
 * Usage:
 *   node scripts/build-asset-links.mjs           # write
 *   node scripts/build-asset-links.mjs --check   # verify, write nothing
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';

import { declaredRoutePaths, sampleUrlFor } from './app-routes.mjs';
import { committedAssociation, partitionRoutes } from './app-site-association.mjs';
import {
  APP_LINKS_HOST,
  ASSET_LINKS_PATH,
  BLOCK_START,
  MANIFEST_PATH,
  androidDataFor,
  committedAssetLinks,
  iosAssociatedDomains,
  matchesAndroidData,
  readManifestBlock,
  renderAssetLinks,
  renderIntentFilterBlock,
  signingCertificateState,
} from './asset-links.mjs';

const MANIFEST = 'frontend/android/app/src/main/AndroidManifest.xml';
const ASSET_LINKS = 'frontend/public/.well-known/assetlinks.json';

const PASTE_HOWTO =
  'Paste both "SHA-256 certificate fingerprint" values from Play Console → Test and release → ' +
  'App integrity → App signing into SIGNING_CERTIFICATES in frontend/scripts/asset-links.mjs, ' +
  'then run `npm run aasa --workspace frontend`.';

function check() {
  const declared = declaredRoutePaths();
  const problems = [];

  // (1) the block is generated, and alone.
  let manifest;
  try {
    manifest = readManifestBlock();
  } catch (error) {
    console.error(`\n❌ aasa:check (Android): ${MANIFEST}: ${error.message}\n`);
    return 1;
  }
  let expected;
  try {
    expected = renderIntentFilterBlock(declared);
  } catch (error) {
    console.error(`\n❌ aasa:check (Android): ${error.message}\n`);
    return 1;
  }
  if (manifest.block !== expected) {
    problems.push(
      `${MANIFEST}: the android-app-links block is not what the generator produces. It is a ` +
        'copy of the iOS claim; regenerate it rather than hand-editing: npm run aasa --workspace ' +
        'frontend. A different CLAIM is a ROUTE_POLICY change in app-site-association.mjs.'
    );
  }
  if (/android:autoVerify/.test(manifest.outside) || /android:host=/.test(manifest.outside)) {
    problems.push(
      `${MANIFEST}: an intent-filter outside the generated block declares autoVerify or a host. ` +
        'Every verified web link has to come from the one derived claim, or a route the gate ' +
        'keeps in the browser can be opened in the app from somewhere it cannot see.'
    );
  }
  const source = readFileSync(MANIFEST_PATH, 'utf8');
  const activityAt = source.indexOf('android:name=".MainActivity"');
  const blockAt = source.indexOf(BLOCK_START);
  const activityEnd = source.indexOf('</activity>', Math.max(activityAt, 0));
  if (activityAt === -1 || activityEnd === -1 || blockAt < activityAt || blockAt > activityEnd) {
    problems.push(
      `${MANIFEST}: the android-app-links block is not inside the MainActivity <activity>. An ` +
        'intent-filter anywhere else is either invalid or handled by nothing.'
    );
  }

  // (2) one Android path per COMMITTED iOS component, in order.
  const association = committedAssociation();
  if (association === null) {
    problems.push(
      'frontend/public/.well-known/apple-app-site-association is missing, so there is no iOS ' +
        'claim to mirror. Run npm run aasa --workspace frontend.'
    );
  } else {
    const components = JSON.parse(association).applinks.details[0].components.map(
      (component) => component['/']
    );
    const mirrored = components.map((pattern) => androidDataFor(pattern));
    const same =
      mirrored.length === manifest.data.length &&
      mirrored.every(
        (entry, index) =>
          entry.attribute === manifest.data[index].attribute &&
          entry.value === manifest.data[index].value
      );
    if (!same) {
      problems.push(
        `${MANIFEST}: the intent-filter declares ${manifest.data.length} paths, which are not the ` +
          `${components.length} components of the committed apple-app-site-association mapped ` +
          'one for one. The two platforms must open the same links.'
      );
    }
  }

  // (3) Android's own matching, against every declared route.
  const { claimed, web } = partitionRoutes(declared);
  for (const route of claimed) {
    const url = sampleUrlFor(route);
    if (!manifest.data.some((entry) => matchesAndroidData(entry, url))) {
      problems.push(
        `${route} is claimed on iOS but no <data> path in ${MANIFEST} accepts ${url}, so on ` +
          'Android that link opens the browser and asks a signed-in user to sign in again.'
      );
    }
  }
  for (const route of web) {
    const url = sampleUrlFor(route);
    const matching = manifest.data.filter((entry) => matchesAndroidData(entry, url));
    if (matching.length > 0) {
      problems.push(
        `${route} must stay in the browser, but ${matching
          .map((entry) => `android:${entry.attribute}="${entry.value}"`)
          .join(', ')} accepts ${url} under Android's matching rules, where ".*" and a prefix ` +
          'both cross "/". A public entry point that opens the app is unreachable for anyone ' +
          'without it, and /account-deletion must work for someone who cannot sign in.'
      );
    }
  }

  // (4) the same domain as iOS.
  const iosDomains = iosAssociatedDomains();
  if (iosDomains.length !== 1 || iosDomains[0] !== APP_LINKS_HOST) {
    problems.push(
      `The Android host is ${APP_LINKS_HOST}, but ios/App/App/App.entitlements associates ` +
        `${iosDomains.join(', ') || 'no domain'}. Both platforms claim one domain, the same one.`
    );
  }

  // (5) the association file follows the certificates.
  const { state, problems: certificateProblems } = signingCertificateState();
  const committed = committedAssetLinks();
  if (state === 'invalid') {
    problems.push(...certificateProblems.map((problem) => `SIGNING_CERTIFICATES: ${problem}.`));
  } else if (state === 'pending' && committed !== null) {
    problems.push(
      `${ASSET_LINKS} is in the tree while the signing-certificate fingerprints in ` +
        'frontend/scripts/asset-links.mjs are still placeholders. The generator never writes it ' +
        'in that state, so this one was written by hand, and a hand-written fingerprint is a ' +
        `guessed one. Delete it. ${PASTE_HOWTO}`
    );
  } else if (state === 'ready' && committed !== renderAssetLinks()) {
    problems.push(
      `${ASSET_LINKS} is ${committed === null ? 'missing' : 'not what the generator produces'} ` +
        'from SIGNING_CERTIFICATES. Regenerate it: npm run aasa --workspace frontend.'
    );
  }

  if (problems.length > 0) {
    console.error('\n❌ aasa:check (Android): the App Links claim is not fit to ship:\n');
    for (const problem of problems) console.error(`   ${problem}`);
    console.error('\nBackground: docs/mobile.md, "Android App Links".\n');
    return 1;
  }

  console.log(
    `aasa:check (Android) OK — the autoVerify intent-filter mirrors all ` +
      `${manifest.data.length} iOS components on ${APP_LINKS_HOST}, opens every one of the ` +
      `${claimed.length} claimed routes and none of the ${web.length} public ones under ` +
      "Android's matching rules, and " +
      (state === 'ready'
        ? `${ASSET_LINKS} is byte-identical to the generator's output.`
        : `${ASSET_LINKS} is correctly ABSENT: the signing-certificate fingerprints are still ` +
          'placeholders, so there is nothing true to publish yet.')
  );
  return 0;
}

function write() {
  const source = readFileSync(MANIFEST_PATH, 'utf8');
  const { block } = readManifestBlock(source);
  writeFileSync(MANIFEST_PATH, source.replace(block, renderIntentFilterBlock()));
  console.log(`wrote the android-app-links block in ${MANIFEST}`);

  const { state, problems } = signingCertificateState();
  if (state === 'invalid') {
    console.error(`\n❌ Refusing to write ${ASSET_LINKS}:\n   ${problems.join('\n   ')}\n`);
    return 1;
  }
  if (state === 'pending') {
    if (committedAssetLinks() !== null) {
      rmSync(ASSET_LINKS_PATH);
      console.log(`removed ${ASSET_LINKS}: the fingerprints are placeholders again`);
    } else {
      console.log(
        `did not write ${ASSET_LINKS}: the fingerprints are placeholders. ${PASTE_HOWTO}`
      );
    }
    return 0;
  }
  mkdirSync(dirname(ASSET_LINKS_PATH), { recursive: true });
  writeFileSync(ASSET_LINKS_PATH, renderAssetLinks());
  console.log(`wrote ${ASSET_LINKS}`);
  return 0;
}

process.exit(process.argv.includes('--check') ? check() : write());
