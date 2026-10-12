import { hasNativePlugin } from '@/lib/platform';

/**
 * Where the refresh token lives inside the iOS/Android shells: the iOS
 * keychain and the Android keystore, through @aparajita/capacitor-secure-storage
 * (ADR 0034).
 *
 * On the website the refresh token is held in sessionStorage unless the
 * person ticks "Keep me signed in" (store/authStore.ts, the 2026-05-31
 * finding 7.1 hardening). sessionStorage is the storage a browser tab drops
 * when it closes, and a WebView drops it the same way every time the app
 * process ends: a force quit, a reboot, or iOS reclaiming memory. So the app
 * forgot the one credential that outlives the hour-long ID token, and every
 * launch more than an hour after the last one started on the sign-in screen.
 *
 * A phone is a personal device with a lock screen in front of it, and the
 * keychain is the OS's own place for exactly this kind of secret. The item
 * is written `afterFirstUnlockThisDeviceOnly`: readable once the phone has
 * been unlocked since it booted (so a launch from a notification works), and
 * never part of a backup, so it cannot move to another device. iCloud
 * keychain sync is off. Android encrypts the value with an AES-GCM key the
 * Keystore generates and never exports.
 *
 * The plugin is imported dynamically and only inside the shells, like
 * nativePush.ts, so the website never downloads it. Every operation fails
 * soft: a vault that cannot be read is an empty vault, and a write that
 * fails is logged nowhere (the token must never appear in a log) and costs
 * one more sign-in, not a crash.
 */

/** The plugin's key; its own prefix is prepended on the device. */
const REFRESH_TOKEN_KEY = 'session.refreshToken';

/** The plugin's name on the bridge, and the methods every operation goes through. */
const PLUGIN_NAME = 'SecureStorage';
const PLUGIN_METHODS = ['internalGetItem', 'internalSetItem', 'internalRemoveItem'];

/**
 * True inside a shell whose bridge lists the SecureStorage plugin. Only then
 * does the refresh token go to the keychain; a shell without the plugin (an
 * app build that does not register it, or a test that pretends the shell
 * without it) keeps the website's storage model exactly, checkbox included.
 * Checked on every call, synchronously: the plugin's JavaScript is never
 * loaded without its native half (see lib/platform.ts, hasNativePlugin).
 * Driven without it, its first read never settles and never yields either:
 * an endless chain of promise callbacks, so the page stops answering and no
 * timer, the 5 s ceiling below included, ever fires. Measured on the
 * production build with the shell pretended and no header, 2026-10-09.
 */
export function sessionVaultAvailable(): boolean {
  return hasNativePlugin(PLUGIN_NAME, PLUGIN_METHODS);
}

type Vault = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

let vaultPromise: Promise<Vault | null> | null = null;

async function loadVault(): Promise<Vault | null> {
  if (!sessionVaultAvailable()) return null;
  vaultPromise ??= import('@aparajita/capacitor-secure-storage')
    .then(async ({ SecureStorage, KeychainAccess }) => {
      await SecureStorage.setDefaultKeychainAccess(KeychainAccess.afterFirstUnlockThisDeviceOnly);
      // Never hand the plugin object itself through a promise. Capacitor
      // plugins are Proxies that turn every property, `then` included, into
      // a bridge call, so resolving a promise with one makes the promise
      // machinery call a `then` that never answers, and the promise never
      // settles. Measured on the production build with the shell pretended:
      // "SecureStorage.then() is not implemented on ios", and a launch that
      // waited on it forever.
      return {
        getItem: (key) => SecureStorage.getItem(key),
        setItem: (key, value) => SecureStorage.setItem(key, value),
        removeItem: (key) => SecureStorage.removeItem(key),
      } satisfies Vault;
    })
    .catch(() => null);
  return vaultPromise;
}

/**
 * The launch waits on the read; a keychain that never answers must not hold
 * the launch screen up for good. Far longer than a keychain read takes.
 */
export const VAULT_READ_TIMEOUT_MS = 5000;

/**
 * The refresh token the device holds, or null: outside the shells, before
 * any sign-in, after a sign-out, or when the keychain cannot be read or
 * does not answer in time.
 */
export async function readVaultedRefreshToken(): Promise<string | null> {
  if (!sessionVaultAvailable()) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), VAULT_READ_TIMEOUT_MS);
  });
  const read = (async () => {
    const vault = await loadVault();
    if (!vault) return null;
    const value = await vault.getItem(REFRESH_TOKEN_KEY);
    return typeof value === 'string' && value.length > 0 ? value : null;
  })().catch(() => null);
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Writes are serialized. The bridge runs each plugin call on its own, so a
// sign-out's removal could otherwise land before the sign-in's write it was
// meant to undo, leaving the signed-out device holding a live token.
let writeChain: Promise<void> = Promise.resolve();

/**
 * Stores the refresh token on the device, or removes it when given null.
 * Resolves once the write has settled; never rejects.
 */
export function writeVaultedRefreshToken(token: string | null): Promise<void> {
  if (!sessionVaultAvailable()) return Promise.resolve();
  writeChain = writeChain.then(async () => {
    const vault = await loadVault();
    if (!vault) return;
    try {
      if (token) await vault.setItem(REFRESH_TOKEN_KEY, token);
      else await vault.removeItem(REFRESH_TOKEN_KEY);
    } catch {
      // A failed write costs one more sign-in. Nothing to log: the value is
      // the secret.
    }
  });
  return writeChain;
}

/** Test seam: forget the loaded plugin and any pending writes. */
export function resetSessionVaultForTests(): void {
  vaultPromise = null;
  writeChain = Promise.resolve();
}
