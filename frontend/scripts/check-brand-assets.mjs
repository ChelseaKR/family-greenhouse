#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const expected = new Map([
  ['public/brand/favicon-32x32.png', [32, 32]],
  ['public/brand/favicon-64.png', [64, 64]],
  ['public/brand/apple-touch-icon.png', [180, 180]],
  ['public/brand/icon-192.png', [192, 192]],
  ['public/brand/icon-512.png', [512, 512]],
  ['public/brand/icon-512-on-green.png', [512, 512]],
  ['public/brand/logo-light.png', [800, 460]],
  ['public/brand/logo-on-white.png', [800, 460]],
  ['public/brand/logo-dark.png', [800, 460]],
  ['public/brand/og-image.png', [1200, 630]],
  ['public/brand/twitter-card.png', [1200, 600]],
  ['../store-assets/google-play/app-icon-512.png', [512, 512]],
  ['../store-assets/google-play/feature-graphic-1024x500.png', [1024, 500]],
  ['../store-assets/app-store/app-icon-1024.png', [1024, 1024]],
  ['ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', [1024, 1024]],
  ['ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png', [2732, 2732]],
  ['ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-1.png', [2732, 2732]],
  ['ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732-2.png', [2732, 2732]],
]);

const launcherSizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const foregroundSizes = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
for (const density of Object.keys(launcherSizes)) {
  expected.set(`android/app/src/main/res/mipmap-${density}/ic_launcher.png`, [
    launcherSizes[density],
    launcherSizes[density],
  ]);
  expected.set(`android/app/src/main/res/mipmap-${density}/ic_launcher_round.png`, [
    launcherSizes[density],
    launcherSizes[density],
  ]);
  expected.set(`android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`, [
    foregroundSizes[density],
    foregroundSizes[density],
  ]);
}

for (const [path, width, height] of [
  ['drawable/splash.png', 480, 320],
  ['drawable-land-mdpi/splash.png', 480, 320],
  ['drawable-land-hdpi/splash.png', 800, 480],
  ['drawable-land-xhdpi/splash.png', 1280, 720],
  ['drawable-land-xxhdpi/splash.png', 1600, 960],
  ['drawable-land-xxxhdpi/splash.png', 1920, 1280],
  ['drawable-port-mdpi/splash.png', 320, 480],
  ['drawable-port-hdpi/splash.png', 480, 800],
  ['drawable-port-xhdpi/splash.png', 720, 1280],
  ['drawable-port-xxhdpi/splash.png', 960, 1600],
  ['drawable-port-xxxhdpi/splash.png', 1280, 1920],
]) {
  expected.set(`android/app/src/main/res/${path}`, [width, height]);
}

function pngDimensions(path) {
  const data = readFileSync(path);
  if (data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`${path} is not a PNG`);
  }
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

const problems = [];
const sha256 = (contents) => createHash('sha256').update(contents).digest('hex');

// Public logo SVGs are also consumed outside the app, where the bundled web
// fonts are unavailable. Keep the serif wordmark as reviewed vector outlines
// and bind each SVG to its generated PNG export(s). This prevents a future
// text-based wordmark from silently falling back during raw SVG rasterization.
const reviewedLogoExports = [
  {
    label: 'light logo',
    source: 'public/brand/logo.svg',
    sourceHash: '5e8ce1f007c757141fb7ebc5c655432b19ac4335087cc797ffb0a8c6981722ef',
    rasters: [
      {
        path: 'public/brand/logo-light.png',
        hash: '6eb4a717fcc9a12962aabdce16fd136f765d45da31960fd058c53a3aef7596be',
      },
      {
        path: 'public/brand/logo-on-white.png',
        hash: 'd6b5eb21052d1891db90b64709ecdd4a4d781e8dbe4774df56a7e6e9055b749a',
      },
    ],
  },
  {
    label: 'dark logo',
    source: 'public/brand/logo-dark.svg',
    sourceHash: '90952b4e1bb043f218c3ff3904eef42b6f7f9f78498ed20a5c44f12c7fb4e76b',
    rasters: [
      {
        path: 'public/brand/logo-dark.png',
        hash: '488396951be1bdd1f5708702b0fd5cd11eb824af68c1515975e7ac24e23098a7',
      },
    ],
  },
];

for (const logo of reviewedLogoExports) {
  const sourcePath = resolve(root, logo.source);
  const source = readFileSync(sourcePath, 'utf8');
  const outlinedWordmarks = source.match(
    /<path\b[^>]*\bid="bitter-wordmark-outline"[^>]*\bdata-font-family="Bitter"[^>]*>/g
  );

  if (outlinedWordmarks?.length !== 1) {
    problems.push(`${logo.source}: expected one reviewed Bitter wordmark outline`);
  }
  if (
    /<text\b[^>]*>\s*Family Greenhouse\s*<\/text>/i.test(source) ||
    /class="wordmark"/i.test(source)
  ) {
    problems.push(`${logo.source}: serif wordmark must be paths, not font-dependent SVG text`);
  }
  if (sha256(readFileSync(sourcePath)) !== logo.sourceHash) {
    problems.push(
      `${logo.label} source hash is unreviewed; regenerate its PNG export(s) and update the reviewed source+raster hashes`
    );
  }

  for (const raster of logo.rasters) {
    if (sha256(readFileSync(resolve(root, raster.path))) !== raster.hash) {
      problems.push(
        `${raster.path} hash is unreviewed; regenerate it and update the reviewed source+raster hashes`
      );
    }
  }
}

const socialSourcePath = resolve(root, 'scripts/brand-assets/og-image.svg');
const socialRasterPath = resolve(root, 'public/brand/og-image.png');
const socialSource = readFileSync(socialSourcePath, 'utf8');
if (
  /\b(?:buy now|subscribe(?: now)?|upgrade(?: now)?|start (?:a |your )?paid plan)\b/i.test(
    socialSource
  )
) {
  problems.push('scripts/brand-assets/og-image.svg contains paid-conversion copy');
}

// The PNG is checked into source control and can otherwise drift from its SVG
// while still passing the dimension gate. These reviewed hashes bind the pair:
// a deliberate social-card edit must regenerate the raster and update both
// values in the same change.
const reviewedSocialCardHashes = {
  source: 'e9cc7b7955977c4c8cd6a75eea8fab9b776f00ea7347ae9a8df58b753dfef10f',
  raster: 'be98c2cd7dba8c54814cd60b2fd21efb305efb5b029aeb8ac0a0003567938989',
};
const actualSocialCardHashes = {
  source: sha256(readFileSync(socialSourcePath)),
  raster: sha256(readFileSync(socialRasterPath)),
};
for (const kind of ['source', 'raster']) {
  if (actualSocialCardHashes[kind] !== reviewedSocialCardHashes[kind]) {
    problems.push(
      `social card ${kind} hash is unreviewed; regenerate og-image.png and update the reviewed source+raster hash pair`
    );
  }
}

for (const [relativePath, dimensions] of expected) {
  const actual = pngDimensions(resolve(root, relativePath));
  if (actual[0] !== dimensions[0] || actual[1] !== dimensions[1]) {
    problems.push(`${relativePath}: expected ${dimensions.join('×')}, got ${actual.join('×')}`);
  }
}

const ico = readFileSync(resolve(root, 'public/brand/favicon.ico'));
const icoFrames = ico.readUInt16LE(4);
if (icoFrames !== 3) problems.push(`favicon.ico: expected 3 frames, got ${icoFrames}`);

if (problems.length) {
  console.error(`Brand asset check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

console.log(`Brand asset check passed: ${expected.size} PNGs and ${icoFrames} favicon frames.`);
