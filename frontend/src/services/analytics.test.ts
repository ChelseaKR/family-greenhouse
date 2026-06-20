/**
 * Unit tests for the household group-analytics wiring in the PostHog shim.
 *
 * The shim is mostly module state + `fetch`, so we mock global `fetch` and
 * read back the JSON we would have POSTed to `/capture/`. We only assert on
 * the household grouping behaviour — the rest of the shim is exercised
 * elsewhere — namely:
 *   - events carry `$groups.household` once a household is set,
 *   - they OMIT it (no stray `{ household: null }`) when none is set,
 *   - `reset()` clears the household.
 *
 * `VITE_POSTHOG_KEY` is stubbed on so the shim doesn't short-circuit, and
 * DNT is forced off. Each test re-imports the module so the module-scoped
 * `distinctId`/`activeHouseholdId` start clean.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HOUSEHOLD_A = 'a0000000-0000-4000-8000-000000000001';
const USER_A = 'u0000000-0000-4000-8000-000000000009';

type CapturePayload = {
  event: string;
  distinct_id: string;
  $groups?: { household?: string };
  properties?: Record<string, unknown>;
};

/** All JSON bodies POSTed to a PostHog `/capture/` URL this test. */
function captures(fetchMock: ReturnType<typeof vi.fn>): CapturePayload[] {
  return fetchMock.mock.calls
    .filter(([url]) => typeof url === 'string' && url.includes('/capture/'))
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as CapturePayload);
}

/** Fresh module instance with a mocked fetch, returns the shim + the mock. */
async function loadShim() {
  vi.resetModules();
  const fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  const mod = await import('./analytics');
  return { mod, fetchMock };
}

beforeEach(() => {
  vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test_key');
  // Force Do-Not-Track off so isEnabled() is true.
  Object.defineProperty(globalThis.navigator, 'doNotTrack', {
    value: null,
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('household group analytics', () => {
  it('omits $groups.household when no household is set', async () => {
    const { mod, fetchMock } = await loadShim();
    mod.identify(USER_A);
    mod.track('plant_added', { ordinal: 'first' });
    // Let the fire-and-forget send() microtask settle.
    await Promise.resolve();
    await Promise.resolve();

    const events = captures(fetchMock);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.$groups).toBeUndefined();
    }
  });

  it('includes $groups.household on capture events once a household is set', async () => {
    const { mod, fetchMock } = await loadShim();
    mod.identify(USER_A);
    mod.setActiveHousehold(HOUSEHOLD_A);
    mod.track('invite_sent');
    await Promise.resolve();
    await Promise.resolve();

    const captured = captures(fetchMock).find((e) => e.event === 'invite_sent');
    expect(captured).toBeDefined();
    expect(captured?.$groups).toEqual({ household: HOUSEHOLD_A });
  });

  it('emits a $groupidentify the first time a household is set', async () => {
    const { mod, fetchMock } = await loadShim();
    mod.setActiveHousehold(HOUSEHOLD_A);
    // Setting the same household again should NOT emit a second groupidentify.
    mod.setActiveHousehold(HOUSEHOLD_A);
    await Promise.resolve();

    const groupIdentifies = captures(fetchMock).filter((e) => e.event === '$groupidentify');
    expect(groupIdentifies).toHaveLength(1);
    expect(groupIdentifies[0].properties).toMatchObject({
      $group_type: 'household',
      $group_key: HOUSEHOLD_A,
    });
  });

  it('reset() clears the active household so later events omit $groups', async () => {
    const { mod, fetchMock } = await loadShim();
    mod.identify(USER_A);
    mod.setActiveHousehold(HOUSEHOLD_A);
    mod.reset();
    // After reset we have no distinct id, so re-identify to allow a capture.
    mod.identify(USER_A);
    mod.track('task_completed');
    await Promise.resolve();
    await Promise.resolve();

    const captured = captures(fetchMock).find((e) => e.event === 'task_completed');
    expect(captured).toBeDefined();
    expect(captured?.$groups).toBeUndefined();
  });

  it('setActiveHousehold(null) detaches the group from subsequent events', async () => {
    const { mod, fetchMock } = await loadShim();
    mod.identify(USER_A);
    mod.setActiveHousehold(HOUSEHOLD_A);
    mod.setActiveHousehold(null);
    mod.track('plant_added');
    await Promise.resolve();
    await Promise.resolve();

    const captured = captures(fetchMock).find((e) => e.event === 'plant_added');
    expect(captured).toBeDefined();
    expect(captured?.$groups).toBeUndefined();
  });
});
