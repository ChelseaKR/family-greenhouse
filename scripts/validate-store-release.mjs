#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const production = process.argv.includes('--production');
const synced = process.argv.includes('--synced');
const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function json(path) {
  return JSON.parse(read(path));
}

function match(text, pattern, label) {
  const result = text.match(pattern);
  if (!result) {
    fail(`Could not read ${label}`);
    return '';
  }
  return result[1];
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual || '(empty)'}`);
}

function assertLength(value, maximum, label) {
  if (!value) fail(`${label} is empty`);
  if (value.length > maximum) fail(`${label} exceeds ${maximum} characters (${value.length})`);
}

function assertHttps(value, label) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') fail(`${label} must use HTTPS`);
  } catch {
    fail(`${label} is not a valid URL`);
  }
}

function pngInfo(path) {
  const data = readFileSync(path);
  if (data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`${path} is not a PNG`);
  }
  const colorType = data[25];
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    hasAlpha: colorType === 4 || colorType === 6 || data.includes(Buffer.from('tRNS')),
  };
}

function assertPng(path, width, height, { opaque = false } = {}) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) {
    fail(`Missing generated store asset: ${path}`);
    return;
  }
  try {
    const info = pngInfo(absolute);
    if (info.width !== width || info.height !== height) {
      fail(`${path}: expected ${width}×${height}, got ${info.width}×${info.height}`);
    }
    if (opaque && info.hasAlpha) fail(`${path} must not contain an alpha channel`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files.sort();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function validateSyncedCopy(source, destination, label) {
  if (!existsSync(source)) {
    fail(`Missing frontend build at ${relative(root, source)}`);
    return;
  }
  if (!existsSync(destination)) {
    fail(`Missing ${label} web bundle; run npx cap sync`);
    return;
  }
  for (const sourceFile of listFiles(source)) {
    const relativePath = relative(source, sourceFile);
    const destinationFile = resolve(destination, relativePath);
    if (!existsSync(destinationFile)) {
      fail(`${label} bundle is missing ${relativePath}`);
      continue;
    }
    if (sha256(sourceFile) !== sha256(destinationFile)) {
      fail(`${label} bundle is stale at ${relativePath}`);
    }
  }
}

const packages = {
  root: json('package.json'),
  frontend: json('frontend/package.json'),
  backend: json('backend/package.json'),
};
const version = packages.root.version;
assertEqual(packages.frontend.version, version, 'frontend package version');
assertEqual(packages.backend.version, version, 'backend package version');

const semver = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!semver) fail(`Root version must be release SemVer, got ${version}`);
const expectedBuildNumber = semver
  ? Number(semver[1]) * 10_000 + Number(semver[2]) * 100 + Number(semver[3])
  : 0;
if (semver && (Number(semver[2]) > 99 || Number(semver[3]) > 99)) {
  fail('Native build-number mapping requires minor and patch versions below 100');
}

const capacitor = read('frontend/capacitor.config.ts');
const appId = match(capacitor, /appId:\s*['"]([^'"]+)['"]/, 'Capacitor appId');
const appName = match(capacitor, /appName:\s*['"]([^'"]+)['"]/, 'Capacitor appName');

const androidBuild = read('frontend/android/app/build.gradle');
assertEqual(
  match(androidBuild, /applicationId\s+['"]([^'"]+)['"]/, 'Android applicationId'),
  appId,
  'Android applicationId'
);
assertEqual(
  match(androidBuild, /versionName\s+['"]([^'"]+)['"]/, 'Android versionName'),
  version,
  'Android versionName'
);
assertEqual(
  Number(match(androidBuild, /versionCode\s+(\d+)/, 'Android versionCode')),
  expectedBuildNumber,
  'Android versionCode'
);

const androidVariables = read('frontend/android/variables.gradle');
const minSdk = Number(match(androidVariables, /minSdkVersion\s*=\s*(\d+)/, 'Android minSdk'));
const compileSdk = Number(
  match(androidVariables, /compileSdkVersion\s*=\s*(\d+)/, 'Android compileSdk')
);
const targetSdk = Number(
  match(androidVariables, /targetSdkVersion\s*=\s*(\d+)/, 'Android targetSdk')
);
if (minSdk < 24) fail(`Android minSdk unexpectedly dropped below Capacitor's baseline: ${minSdk}`);
if (compileSdk < 35) fail(`Android compileSdk must meet the Play API requirement: ${compileSdk}`);
if (targetSdk < 35) fail(`Android targetSdk must meet the Play API requirement: ${targetSdk}`);

const xcodeProject = read('frontend/ios/App/App.xcodeproj/project.pbxproj');
const iosIdentifiers = [...xcodeProject.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map(
  (item) => item[1]
);
for (const identifier of new Set(iosIdentifiers)) assertEqual(identifier, appId, 'iOS bundle ID');
const iosVersions = [...xcodeProject.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(
  (item) => item[1]
);
for (const iosVersion of new Set(iosVersions)) assertEqual(iosVersion, version, 'iOS version');
const iosBuilds = [...xcodeProject.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((item) =>
  Number(item[1])
);
for (const build of new Set(iosBuilds)) assertEqual(build, expectedBuildNumber, 'iOS build number');

const privacyManifest = read('frontend/ios/App/App/PrivacyInfo.xcprivacy');
for (const dataType of [
  'Name',
  'EmailAddress',
  'PhoneNumber',
  'PhotosorVideos',
  'OtherUserContent',
  'UserID',
  'CoarseLocation',
]) {
  if (!privacyManifest.includes(`NSPrivacyCollectedDataType${dataType}`)) {
    fail(`iOS privacy manifest is missing collected data type ${dataType}`);
  }
}
if (/NSPrivacyAccessedAPITypes<\/key>\s*<array\s*\/>/.test(privacyManifest)) {
  fail(
    'iOS privacy manifest must omit NSPrivacyAccessedAPITypes instead of declaring an empty array'
  );
}

const metadata = json('store-assets/metadata/en-US.json');
assertEqual(metadata.shared.appName, appName, 'Shared store app name');
assertEqual(metadata.googlePlay.title, appName, 'Google Play title');
assertEqual(metadata.appStore.name, appName, 'App Store name');
assertLength(metadata.googlePlay.title, 30, 'Google Play title');
assertLength(metadata.googlePlay.shortDescription, 80, 'Google Play short description');
assertLength(metadata.googlePlay.fullDescription, 4000, 'Google Play full description');
assertLength(metadata.googlePlay.releaseNotes, 500, 'Google Play release notes');
assertLength(metadata.appStore.name, 30, 'App Store name');
assertLength(metadata.appStore.subtitle, 30, 'App Store subtitle');
assertLength(metadata.appStore.promotionalText, 170, 'App Store promotional text');
assertLength(metadata.appStore.description, 4000, 'App Store description');
assertLength(metadata.appStore.keywords, 100, 'App Store keywords');
assertLength(metadata.appStore.releaseNotes, 4000, 'App Store release notes');
for (const [key, value] of Object.entries(metadata.shared.urls)) assertHttps(value, `URL ${key}`);

assertPng('store-assets/google-play/app-icon-512.png', 512, 512);
assertPng('store-assets/google-play/feature-graphic-1024x500.png', 1024, 500, {
  opaque: true,
});
assertPng('store-assets/app-store/app-icon-1024.png', 1024, 1024, { opaque: true });
for (const name of ['01-dashboard', '02-plants', '03-plant-detail', '04-tasks']) {
  assertPng(`store-assets/app-store/iphone-6.9/${name}.png`, 1320, 2868);
  assertPng(`store-assets/app-store/ipad-13/${name}.png`, 2064, 2752);
  assertPng(`store-assets/google-play/phone/${name}.png`, 1080, 2400);
}

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const privateFile =
  /(?:^|\/)(?:google-services\.json|GoogleService-Info\.plist|AuthKey_[^/]+\.p8|[^/]+\.(?:jks|keystore|p12|mobileprovision))$/i;
for (const path of tracked.filter((candidate) => privateFile.test(candidate))) {
  fail(`Private signing/service material must not be tracked: ${path}`);
}

for (const ignoredPath of [
  'frontend/.env.mobile.production',
  'frontend/android/app/release-upload.jks',
  'frontend/android/app/google-services.json',
  'frontend/ios/App/AuthKey_EXAMPLE.p8',
  'frontend/ios/App/release.mobileprovision',
]) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', ignoredPath], { cwd: root });
  } catch {
    fail(`Sensitive local path is not gitignored: ${ignoredPath}`);
  }
}

if (production) {
  const requiredEnvironment = [
    'VITE_API_URL',
    'VITE_COGNITO_USER_POOL_ID',
    'VITE_COGNITO_CLIENT_ID',
    'VITE_COGNITO_REGION',
  ];
  for (const key of requiredEnvironment) {
    const value = process.env[key] ?? '';
    if (!value) fail(`Missing production build variable ${key}`);
    if (/(?:localhost|127\.0\.0\.1|example|<|>)/i.test(value)) {
      fail(`${key} contains a development or placeholder value`);
    }
  }
  if (process.env.VITE_API_URL) assertHttps(process.env.VITE_API_URL, 'VITE_API_URL');
  if (process.env.VITE_CHAT_STREAM_URL) {
    assertHttps(process.env.VITE_CHAT_STREAM_URL, 'VITE_CHAT_STREAM_URL');
  }
  if (String(process.env.VITE_BETA_MODE).toLowerCase() !== 'false') {
    fail('VITE_BETA_MODE must be false for public store builds');
  }
  const signingKeys = [
    'ANDROID_UPLOAD_KEYSTORE',
    'ANDROID_UPLOAD_KEYSTORE_PASSWORD',
    'ANDROID_UPLOAD_KEY_ALIAS',
    'ANDROID_UPLOAD_KEY_PASSWORD',
  ];
  const configuredSigningKeys = signingKeys.filter((key) => Boolean(process.env[key]));
  if (configuredSigningKeys.length > 0 && configuredSigningKeys.length < signingKeys.length) {
    fail(`Android signing is partially configured; set all of ${signingKeys.join(', ')}`);
  }

  const googleServicesPath = resolve(root, 'frontend/android/app/google-services.json');
  if (existsSync(googleServicesPath)) {
    try {
      const googleServices = JSON.parse(readFileSync(googleServicesPath, 'utf8'));
      const packageNames = (googleServices.client ?? [])
        .map((client) => client?.client_info?.android_client_info?.package_name)
        .filter(Boolean);
      if (!packageNames.includes(appId)) {
        fail(`google-services.json does not contain Android package ${appId}`);
      }
    } catch (error) {
      fail(`Could not validate google-services.json: ${String(error)}`);
    }
  } else {
    warn('Android push credentials are absent; native push UI must remain hidden for this release');
  }
}

if (synced) {
  const dist = resolve(root, 'frontend/dist');
  validateSyncedCopy(dist, resolve(root, 'frontend/android/app/src/main/assets/public'), 'Android');
  validateSyncedCopy(dist, resolve(root, 'frontend/ios/App/App/public'), 'iOS');

  const sourceMaps = existsSync(dist)
    ? listFiles(dist).filter((path) => path.endsWith('.map'))
    : [];
  if (sourceMaps.length)
    fail(`Production mobile bundle contains source maps: ${sourceMaps.length}`);

  if (existsSync(dist) && process.env.VITE_API_URL) {
    const builtText = listFiles(dist)
      .filter((path) => /\.(?:js|html)$/.test(path))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    if (!builtText.includes(process.env.VITE_API_URL)) {
      fail('Built frontend does not contain VITE_API_URL; production variables were not embedded');
    }
  }
}

if (!production && !existsSync(resolve(root, 'frontend/android/app/google-services.json'))) {
  warn('Android push credentials are intentionally local and are not present in this checkout');
}

for (const message of warnings) console.warn(`WARN: ${message}`);
if (errors.length) {
  console.error(`Store release validation failed:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}

console.log(
  `Store release validation passed for ${appName} ${version} (${expectedBuildNumber}), ${appId}.`
);
