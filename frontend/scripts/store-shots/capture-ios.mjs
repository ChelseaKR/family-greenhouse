#!/usr/bin/env node
/**
 * App Store screenshots of the REAL iOS app, native frame included:
 * `npm run store:screenshots:ios --workspace frontend`.
 *
 * The Playwright frames (`npm run store:screenshots`) are a website in a phone
 * viewport. Since the native tab bar and navigation bar (#905) the iPhone app
 * no longer looks like that, so the 6.9-inch set comes from the app itself:
 *
 *   1. the mock API with SEED_STORE_DEMO=1 (The Fernwood House; every name in
 *      it is invented and every address is @example.com), started here unless
 *      one holding the demo household is already on :4000;
 *   2. a Debug simulator build of this checkout (`npm run build`, `cap sync
 *      ios`, `xcodebuild`), with tour.js added to the synced web folder of THIS
 *      build only and removed again as soon as Xcode has copied it;
 *   3. a clean install on an iPhone 6.9-inch simulator (iPhone 17 Pro Max:
 *      1320 x 2868), light appearance, and Apple's 9:41 status bar;
 *   4. tour.js signs in through the real form and walks SHOTS one step at a
 *      time; after each step settles this script takes the screenshot with
 *      `simctl io screenshot` and checks its size.
 *
 * Options: --udid <id> (default: the one available "iPhone 17 Pro Max"),
 * --out <dir> (default: store-assets/app-store/iphone-6.9), --skip-build (reuse
 * the last xcodebuild output in --derived-data), --derived-data <dir>,
 * --reuse-web (skip `npm run build` and `cap sync`, for iterating on the tour),
 * --only <name,name> (capture a subset, for iterating on one frame).
 *
 * It stops only what it started: the API process it spawned, and the
 * simulator if it booted it.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateSync, inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO, SHOTS, setUpDemoHousehold } from './shots.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, '..', '..');
const root = path.resolve(frontend, '..');
const API = 'http://localhost:4000';
const TOUR_PORT = 4199;
const BUNDLE_ID = 'net.familygreenhouse.app';
const SIZE = { width: 1320, height: 2868 }; // App Store "iPhone 6.9-inch display"

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  return value && !value.startsWith('--') ? value : true;
}

const out = path.resolve(root, arg('out', 'store-assets/app-store/iphone-6.9'));
const derivedData = path.resolve(arg('derived-data', path.join(tmpdir(), 'fg-store-shots-dd')));
const skipBuild = arg('skip-build', false) === true;
const reuseWeb = arg('reuse-web', false) === true;
const only = typeof arg('only', '') === 'string' && arg('only', '') ? arg('only').split(',') : null;
const shots = only ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;

const log = (...a) => console.log('[store-shots]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const read = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });

function resolveUdid() {
  const given = arg('udid', process.env.STORE_SHOTS_UDID);
  if (typeof given === 'string') return given;
  const { devices } = JSON.parse(read('xcrun', ['simctl', 'list', 'devices', 'available', '-j']));
  const matches = Object.values(devices)
    .flat()
    .filter((d) => d.name === 'iPhone 17 Pro Max');
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one available "iPhone 17 Pro Max" simulator, found ${matches.length}. ` +
        'Pass --udid <id> for a 6.9-inch iPhone (1320 x 2868).'
    );
  }
  return matches[0].udid;
}

async function demoLogin() {
  try {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(DEMO),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function apiUp() {
  try {
    return (await fetch(`${API}/health`)).ok;
  } catch {
    return false;
  }
}

/** The mock API with the demo household, or a clear failure. Returns the process if we started it. */
async function ensureApi() {
  if (await demoLogin()) return null;
  if (await apiUp()) {
    throw new Error(
      `${API} is up but has no store-demo household. It is seeded only when the API starts with ` +
        'SEED_STORE_DEMO=1. Stop the server holding port 4000 and re-run.'
    );
  }
  log('starting the mock API with SEED_STORE_DEMO=1');
  const child = spawn('npm', ['--workspace', 'backend', 'run', 'dev'], {
    cwd: root,
    env: { ...process.env, SEED_STORE_DEMO: '1' },
    stdio: 'ignore',
    detached: true,
  });
  for (let i = 0; i < 120; i++) {
    if (await demoLogin()) return child;
    await sleep(1000);
  }
  stopApi(child);
  throw new Error('The mock API did not come up with the demo household within two minutes.');
}

function stopApi(child) {
  if (!child) return;
  try {
    process.kill(-child.pid, 'SIGTERM'); // the whole group: npm, tsx and node
  } catch {
    /* already gone */
  }
}

const publicDir = path.join(frontend, 'ios', 'App', 'App', 'public');
const TOUR_TAG = `<script src="/store-shots-tour.js" data-port="${TOUR_PORT}"></script>`;

function injectTour() {
  const index = path.join(publicDir, 'index.html');
  const html = readFileSync(index, 'utf8');
  if (!html.includes(TOUR_TAG)) writeFileSync(index, html.replace('</body>', `${TOUR_TAG}</body>`));
  copyFileSync(path.join(here, 'tour.js'), path.join(publicDir, 'store-shots-tour.js'));
}

function removeTour() {
  const index = path.join(publicDir, 'index.html');
  if (existsSync(index)) writeFileSync(index, readFileSync(index, 'utf8').replace(TOUR_TAG, ''));
  rmSync(path.join(publicDir, 'store-shots-tour.js'), { force: true });
}

function build(udid) {
  if (!skipBuild) {
    if (!reuseWeb) {
      log('building the web bundle and syncing it into the iOS project');
      run('npm', ['run', 'build'], { cwd: frontend });
      run('npx', ['cap', 'sync', 'ios'], { cwd: frontend });
    }
    injectTour();
    try {
      log('building the app for the simulator (Debug, unsigned)');
      run(
        'xcodebuild',
        [
          '-project',
          path.join(frontend, 'ios', 'App', 'App.xcodeproj'),
          '-scheme',
          'App',
          '-configuration',
          'Debug',
          '-sdk',
          'iphonesimulator',
          '-destination',
          `platform=iOS Simulator,id=${udid}`,
          '-derivedDataPath',
          derivedData,
          'CODE_SIGNING_ALLOWED=NO',
          '-quiet',
          'build',
        ],
        { cwd: frontend }
      );
    } finally {
      removeTour();
    }
  }
  const app = path.join(derivedData, 'Build', 'Products', 'Debug-iphonesimulator', 'App.app');
  if (!existsSync(path.join(app, 'public', 'store-shots-tour.js'))) {
    throw new Error(`${app} has no tour in it. Run without --skip-build.`);
  }
  return app;
}

function pngSize(file) {
  const b = readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([head.subarray(4), data])) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}

/**
 * `simctl io screenshot` writes 8-bit RGBA. App Store screenshots should carry
 * no alpha channel, so rewrite it as 8-bit RGB. Every pixel of a device
 * screenshot is opaque; anything else is a capture fault and fails the run.
 */
function flattenPng(file) {
  const b = readFileSync(file);
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  if (b[24] !== 8 || b[25] !== 6 || b[28] !== 0) return; // already not 8-bit RGBA
  const idat = [];
  for (let at = 8; at < b.length;) {
    const length = b.readUInt32BE(at);
    if (b.toString('ascii', at + 4, at + 8) === 'IDAT')
      idat.push(b.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rgba.subarray(y * stride, (y + 1) * stride);
    const up = y ? rgba.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[x - 4] : 0;
      const c = x >= 4 ? up[x - 4] : 0;
      const p = a + up[x] - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - up[x]);
      const pc = Math.abs(p - c);
      const predictor = [
        0,
        a,
        up[x],
        (a + up[x]) >> 1,
        pa <= pb && pa <= pc ? a : pb <= pc ? up[x] : c,
      ][filter];
      out[x] = (line[x] + predictor) & 0xff;
    }
  }
  const rgb = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    rgb[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const from = y * stride + x * 4;
      if (rgba[from + 3] !== 255) throw new Error(`${file}: a transparent pixel at ${x},${y}`);
      rgba.copy(rgb, y * (width * 3 + 1) + 1 + x * 3, from, from + 3);
    }
  }
  const ihdr = Buffer.from(b.subarray(16, 29));
  ihdr[9] = 2; // color type: RGB
  writeFileSync(
    file,
    Buffer.concat([
      b.subarray(0, 8),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(rgb, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ])
  );
}

function bootedState(udid) {
  const { devices } = JSON.parse(read('xcrun', ['simctl', 'list', 'devices', '-j']));
  return Object.values(devices)
    .flat()
    .find((d) => d.udid === udid)?.state;
}

async function capture(udid, app, context) {
  const weBooted = bootedState(udid) !== 'Booted';
  if (weBooted) run('xcrun', ['simctl', 'boot', udid]);
  run('xcrun', ['simctl', 'bootstatus', udid, '-b'], { stdio: 'ignore' });
  run('xcrun', ['simctl', 'ui', udid, 'appearance', 'light']);
  run('xcrun', [
    'simctl',
    'status_bar',
    udid,
    'override',
    '--time',
    '9:41',
    '--dataNetwork',
    'wifi',
    '--wifiMode',
    'active',
    '--wifiBars',
    '3',
    '--cellularMode',
    'active',
    '--cellularBars',
    '4',
    '--batteryState',
    'charged',
    '--batteryLevel',
    '100',
  ]);
  // A clean install every time: signed out, no cached data from an earlier run.
  try {
    run('xcrun', ['simctl', 'uninstall', udid, BUNDLE_ID], { stdio: 'ignore' });
  } catch {
    /* not installed */
  }
  run('xcrun', ['simctl', 'install', udid, app]);
  mkdirSync(out, { recursive: true });

  const queue = [
    { name: null, step: { signIn: DEMO, settleMs: 800 } },
    ...shots.map((s) => ({
      name: s.name,
      step: typeof s.step === 'function' ? s.step(context) : s.step,
    })),
  ];
  let index = 0;
  let failure = null;
  const finished = new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        const msg = body ? JSON.parse(body) : {};
        const reply = (o) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(o));
        };
        if (req.url === '/next') {
          if (failure || index >= queue.length) {
            reply({ done: true });
            server.close();
            resolve();
            return;
          }
          reply({ id: index, step: queue[index].step });
          return;
        }
        if (req.url === '/ready') {
          const item = queue[msg.id];
          if (!msg.ok) {
            failure = `${item.name ?? 'sign-in'}: ${msg.error}`;
          } else if (item.name) {
            await sleep(600);
            const file = path.join(out, `${item.name}.png`);
            run('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=png', file], {
              stdio: 'ignore',
            });
            flattenPng(file);
            const size = pngSize(file);
            if (size.width !== SIZE.width || size.height !== SIZE.height) {
              failure = `${item.name}: ${size.width} x ${size.height}, expected ${SIZE.width} x ${SIZE.height} (use a 6.9-inch iPhone)`;
            }
            log(`${item.name}.png  ${msg.result.path}  scrollY ${msg.result.scrollY}`);
          }
          index = msg.id + 1;
          reply({ ok: true });
        }
      });
    });
    server.listen(TOUR_PORT, '127.0.0.1');
  });

  run('xcrun', ['simctl', 'launch', udid, BUNDLE_ID], { stdio: 'ignore' });
  const timeout = sleep(5 * 60 * 1000).then(() => {
    failure ??= 'the tour did not finish within five minutes';
  });
  await Promise.race([finished, timeout]);

  try {
    run('xcrun', ['simctl', 'terminate', udid, BUNDLE_ID], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
  run('xcrun', ['simctl', 'status_bar', udid, 'clear']);
  if (weBooted) run('xcrun', ['simctl', 'shutdown', udid]);
  if (failure) throw new Error(failure);
}

const udid = resolveUdid();
log(`simulator ${udid}, writing to ${path.relative(root, out)}`);
const api = await ensureApi();
try {
  const context = await setUpDemoHousehold(API, await demoLogin());
  const app = build(udid);
  await capture(udid, app, context);
  log(`done: ${shots.length} screenshots`);
} finally {
  stopApi(api);
}
process.exit(0);
