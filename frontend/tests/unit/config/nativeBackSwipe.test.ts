import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The iOS edge swipe back is switched on in MainViewController.swift, and only
 * while BackSwipePolicy allows it. The policy names sign-in and setup routes
 * by path; those paths live in App.tsx. Swift is not compiled in CI, so this
 * holds the contract between the two files: rename a route and forget the
 * Swift, and this fails instead of the swipe quietly reaching a screen it
 * should not (back into sign-in after signing in).
 */
const swift = readFileSync(resolve(process.cwd(), 'ios/App/App/MainViewController.swift'), 'utf8');
const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

function policyPaths(): string[] {
  const block = swift.match(/signInAndSetupPaths: Set<String> = \[([\s\S]*?)\]/);
  expect(block, 'BackSwipePolicy.signInAndSetupPaths').not.toBeNull();
  return [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe('iOS edge swipe back (MainViewController.swift)', () => {
  it('turns the gesture on only through BackSwipePolicy, re-decided as the page changes', () => {
    const assignments = [...swift.matchAll(/allowsBackForwardNavigationGestures\s*=\s*(.+)/g)];
    expect(assignments).toHaveLength(1);
    expect(assignments[0][1]).toMatch(/^BackSwipePolicy\.allows\(/);
    expect(swift).toMatch(/observe\(\\\.url/);
    expect(swift).toMatch(/observe\(\\\.canGoBack/);
    expect(swift).toMatch(/observeBackSwipe\(\)/);
  });

  it('names the sign-in and setup screens, each a real route in App.tsx', () => {
    const paths = policyPaths();
    expect(paths).toEqual(
      expect.arrayContaining(['/login', '/register', '/onboarding', '/forgot-password'])
    );
    for (const path of paths) {
      expect(app, `route ${path} in App.tsx`).toContain(`path="${path}"`);
    }
  });

  it('never swipes onto the redirecting root, another origin, or nothing', () => {
    expect(swift).toMatch(/if backPath == "\/" \{ return false \}/);
    expect(swift).toMatch(/back\.scheme == current\.scheme, back\.host == current\.host/);
    expect(swift).toMatch(/guard let current = current, let back = back else \{ return false \}/);
  });
});
