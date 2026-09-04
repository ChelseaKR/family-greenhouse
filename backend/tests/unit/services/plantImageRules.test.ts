/**
 * The photo-key rules are now shared by two writers — the authenticated member
 * path and the token-scoped caretaker path — so the "is this a URL we issued
 * for THIS plant" check is tested once, here, rather than trusted twice.
 *
 * Every case below is an attempt to attach an object the caller was not given.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  IMAGE_CONTENT_TYPES,
  MAX_IMAGE_BYTES,
  imageKeyPrefix,
  mintImageKey,
  publicImageUrl,
  resolveIssuedImageKey,
} from '../../../src/services/plantImageRules.js';

const HH = 'hh-1';
const PLANT = 'plant-1';

const originalAssetsBase = process.env.ASSETS_BASE_URL;
afterEach(() => {
  if (originalAssetsBase === undefined) delete process.env.ASSETS_BASE_URL;
  else process.env.ASSETS_BASE_URL = originalAssetsBase;
});

describe('image rules', () => {
  it('allows exactly the three image types, mapped to their extensions', () => {
    expect(IMAGE_CONTENT_TYPES).toEqual({
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    });
  });

  it('caps uploads at 5 MiB', () => {
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
  });

  it('mints a unique key under the household + plant prefix', () => {
    const a = mintImageKey(HH, PLANT, 'image/png');
    const b = mintImageKey(HH, PLANT, 'image/png');
    expect(a).toMatch(new RegExp(`^${imageKeyPrefix(HH, PLANT)}[0-9a-f-]+\\.png$`));
    expect(a).not.toBe(b);
  });
});

describe('resolveIssuedImageKey', () => {
  beforeEach(() => {
    delete process.env.ASSETS_BASE_URL;
  });

  it('accepts a URL it would have minted', () => {
    const key = mintImageKey(HH, PLANT, 'image/jpeg');
    expect(resolveIssuedImageKey(HH, PLANT, publicImageUrl(key))).toBe(key);
  });

  it('accepts the assets-domain form when ASSETS_BASE_URL is set', () => {
    process.env.ASSETS_BASE_URL = 'https://example.test/';
    const key = mintImageKey(HH, PLANT, 'image/webp');
    expect(resolveIssuedImageKey(HH, PLANT, `https://example.test/${key}`)).toBe(key);
  });

  it('refuses another plant’s prefix', () => {
    const key = mintImageKey(HH, 'plant-2', 'image/jpeg');
    expect(resolveIssuedImageKey(HH, PLANT, publicImageUrl(key))).toBeNull();
  });

  it('refuses another household’s prefix', () => {
    const key = mintImageKey('hh-2', PLANT, 'image/jpeg');
    expect(resolveIssuedImageKey(HH, PLANT, publicImageUrl(key))).toBeNull();
  });

  it('refuses a traversal, a nested path, or a query string in the filename', () => {
    const prefix = publicImageUrl(imageKeyPrefix(HH, PLANT));
    expect(resolveIssuedImageKey(HH, PLANT, `${prefix}../secret.jpg`)).toBeNull();
    expect(resolveIssuedImageKey(HH, PLANT, `${prefix}nested/file.jpg`)).toBeNull();
    expect(resolveIssuedImageKey(HH, PLANT, `${prefix}file.jpg?x=1`)).toBeNull();
    expect(resolveIssuedImageKey(HH, PLANT, `${prefix}file.svg`)).toBeNull();
    expect(resolveIssuedImageKey(HH, PLANT, `${prefix}file.jpg.html`)).toBeNull();
  });

  it('refuses a foreign origin that merely contains our prefix', () => {
    expect(
      resolveIssuedImageKey(HH, PLANT, `https://evil.test/${imageKeyPrefix(HH, PLANT)}a.jpg`)
    ).toBeNull();
  });
});
