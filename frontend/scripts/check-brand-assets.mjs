#!/usr/bin/env node

import { readFileSync } from 'node:fs';
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
