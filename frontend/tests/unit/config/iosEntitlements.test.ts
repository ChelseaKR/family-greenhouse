import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The iOS App target's entitlements.
 *
 * `@capacitor/push-notifications` is the only native plugin the apps link, and
 * it could not register from the committed project: enabling the Push
 * Notifications capability was a manual Xcode step (docs/mobile.md), so no
 * entitlements file existed in the repo, and without an `aps-environment`
 * entitlement `PushNotifications.register()` fails at runtime with no
 * build-time signal — the plugin links, AppDelegate.swift forwards the APNs
 * callbacks, and registration simply never succeeds (#469 §3).
 *
 * `scripts/validate-store-release.mjs` already requires this file the moment
 * anything in `frontend/src` calls `registerNativePush()`. That is the right
 * gate for wiring the feature up, and the wrong one for keeping the file
 * correct in the meantime: today nothing calls it, so today that gate is
 * dormant and the entitlements could be deleted, emptied, or detached from the
 * target without a single check going red. These assertions run on every PR
 * regardless, in the required `Test Frontend` job.
 *
 * They are file assertions, not device assertions. Only a signed build on real
 * hardware proves a token arrives; what is checkable here is that the material
 * a signed build needs is committed rather than living in someone's Xcode.
 */

// vitest runs with `frontend/` as cwd (see vitest.config.ts `root`).
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

const ENTITLEMENTS = 'ios/App/App/App.entitlements';
const PROJECT = 'ios/App/App.xcodeproj/project.pbxproj';

describe('iOS entitlements', () => {
  it('commits an aps-environment entitlement rather than leaving it to Xcode', () => {
    const entitlements = read(ENTITLEMENTS);
    expect(entitlements).toContain('<key>aps-environment</key>');
  });

  it('applies the entitlements to the App target in every configuration', () => {
    const project = read(PROJECT);

    // Two build configurations exist (Debug and Release); both must point at
    // the file, or the configuration that misses it is signed without the
    // entitlement and registration fails only in that build — the hardest
    // shape of this bug to notice.
    const applied = project.match(/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/g) ?? [];
    expect(applied).toHaveLength(2);

    // And the file is in the project navigator, so it is editable in Xcode
    // rather than being an invisible build setting pointing at a path.
    expect(project).toContain('App.entitlements */ = {isa = PBXFileReference');
  });

  it('registers against the sandbox APNs gateway in Debug and production in Release', () => {
    const entitlements = read(ENTITLEMENTS);
    const project = read(PROJECT);

    // The value is a build setting rather than a literal so the split is
    // stated in the project instead of relying on Xcode silently rewriting the
    // entitlement at export time. A Release build carrying `development`
    // registers against the sandbox gateway and mints tokens the production
    // gateway rejects — which looks like a backend bug, from the backend.
    expect(entitlements).toContain('<string>$(APS_ENVIRONMENT)</string>');
    expect(project).toContain('APS_ENVIRONMENT = development;');
    expect(project).toContain('APS_ENVIRONMENT = production;');
    expect(project.match(/APS_ENVIRONMENT = /g) ?? []).toHaveLength(2);
  });

  it('is valid property-list XML', () => {
    const entitlements = read(ENTITLEMENTS);
    expect(entitlements).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(entitlements).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
    expect(entitlements.trimEnd().endsWith('</plist>')).toBe(true);
    // Balanced dict/plist tags — a truncated entitlements file is accepted by
    // the Xcode build and rejected by codesign, at the end of an archive.
    expect((entitlements.match(/<dict>/g) ?? []).length).toBe(
      (entitlements.match(/<\/dict>/g) ?? []).length
    );
  });
});
