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

function firstPartyEvents(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([url]) => typeof url === 'string' && url.includes('/telemetry/product'))
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
}

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
  it('sends authenticated product events to the first-party rail', async () => {
    const { mod, fetchMock } = await loadShim();
    mod.setTelemetryAuthToken('jwt-token');
    mod.identify(USER_A);
    mod.setActiveHousehold(HOUSEHOLD_A);
    mod.track('plant_added', { ordinal: 'first' });
    await Promise.resolve();
    await Promise.resolve();

    expect(firstPartyEvents(fetchMock)).toContainEqual({
      event: 'plant_added',
      properties: { ordinal: 'first' },
      superProperties: {},
    });
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/telemetry/product'));
    expect((call?.[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer jwt-token',
      'X-Household-Id': HOUSEHOLD_A,
    });
  });

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

/**
 * Characterization tests for the anonymous (pre-signin) visitor.
 *
 * These pin a real property of the current design rather than a bug: every
 * rail in the shim is identity-gated, so a visitor who has not signed in
 * produces NO network traffic at all. That is the privacy posture working as
 * intended — no anonymous beaconing from marketing pages — and it is also the
 * reason the top of the acquisition funnel is not measurable today. See
 * docs/analytics.md, "What this instrumentation cannot answer".
 *
 * If a future change makes anonymous visitors emit events, these tests should
 * fail loudly: that is a privacy-posture decision and a privacy-page change,
 * not a silent instrumentation tweak.
 */
describe('anonymous visitors', () => {
  it('sends nothing on any rail before identify()', async () => {
    const { mod, fetchMock } = await loadShim();
    // No identify(), no setTelemetryAuthToken() — an anonymous landing visitor.
    mod.track('experiment_viewed', { experiment: 'landing_hero_framing', variant: 'B' });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops the first-party event when identified but not yet token-bearing', async () => {
    // identify() alone is not enough: /telemetry/product is authenticated, so
    // the first-party rail stays closed until a JWT is set.
    const { mod, fetchMock } = await loadShim();
    mod.identify(USER_A);
    mod.track('signup_completed');
    await Promise.resolve();
    await Promise.resolve();

    expect(firstPartyEvents(fetchMock)).toHaveLength(0);
  });

  it('honors Do-Not-Track for an identified, token-bearing user', async () => {
    Object.defineProperty(globalThis.navigator, 'doNotTrack', {
      value: '1',
      configurable: true,
    });
    const { mod, fetchMock } = await loadShim();
    mod.setTelemetryAuthToken('jwt-token');
    mod.identify(USER_A);
    mod.track('subscription_upgraded', { upgradeTo: 'garden', interval: 'month' });
    await Promise.resolve();
    await Promise.resolve();

    expect(firstPartyEvents(fetchMock)).toHaveLength(0);
    expect(captures(fetchMock)).toHaveLength(0);
  });
});

/**
 * Deferred replay of events fired before any identity existed.
 *
 * `experiment_viewed` (landing hero A/B) and `cutting_graft_started` (public
 * cutting card) both fire for signed-out visitors, so before this they reached
 * no rail at all and the experiment produced literally zero rows. They are now
 * held in memory and replayed at sign-in.
 *
 * The privacy posture is deliberately unchanged: the `anonymous visitors`
 * suite above still asserts zero network traffic before `identify()`, and
 * these tests exist to prove the queue does not quietly become anonymous
 * beaconing.
 */
describe('pre-identity event replay', () => {
  it('replays the landing experiment impression onto the first-party rail at sign-in', async () => {
    const { mod, fetchMock } = await loadShim();
    // Anonymous landing visit.
    mod.registerSuperProperties({ landing_hero_framing: 'B' });
    mod.track('experiment_viewed', { experiment: 'landing_hero_framing', variant: 'B' });
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    // …the same browser signs in.
    mod.setTelemetryAuthToken('jwt-token');
    mod.identify(USER_A);
    await Promise.resolve();
    await Promise.resolve();

    expect(firstPartyEvents(fetchMock)).toContainEqual({
      event: 'experiment_viewed',
      properties: { experiment: 'landing_hero_framing', variant: 'B' },
      superProperties: { landing_hero_framing: 'B' },
    });
  });

  it('replays in the order the visitor generated the events', async () => {
    const { mod, fetchMock } = await loadShim();
    mod.track('experiment_viewed', { experiment: 'landing_hero_framing', variant: 'A' });
    mod.track('cutting_graft_started');
    mod.setTelemetryAuthToken('jwt-token');
    mod.identify(USER_A);
    await Promise.resolve();
    await Promise.resolve();

    expect(firstPartyEvents(fetchMock).map((e) => e.event)).toEqual([
      'experiment_viewed',
      'cutting_graft_started',
    ]);
  });

  it('replays exactly once — a second identify() does not re-send the queue', async () => {
    // `authStore.setUser` calls identify() on every set, and session restore
    // calls it again. A queue that refilled or replayed twice would double the
    // experiment's numerator.
    const { mod, fetchMock } = await loadShim();
    mod.track('experiment_viewed', { experiment: 'landing_hero_framing', variant: 'B' });
    mod.setTelemetryAuthToken('jwt-token');
    mod.identify(USER_A);
    mod.identify(USER_A);
    mod.setTelemetryAuthToken('jwt-token-refreshed');
    await Promise.resolve();
    await Promise.resolve();

    expect(firstPartyEvents(fetchMock).filter((e) => e.event === 'experiment_viewed')).toHaveLength(
      1
    );
  });

  it('sends nothing when only half of the identity exists', async () => {
    // `distinct_id` without a JWT opens the PostHog rail only. Flushing there
    // would consume the queue before the first-party rail — the only rail
    // configured in production — could ever receive it.
    const { mod, fetchMock } = await loadShim();
    mod.track('experiment_viewed', { experiment: 'landing_hero_framing', variant: 'A' });
    mod.identify(USER_A);
    await Promise.resolve();
    await Promise.resolve();

    expect(firstPartyEvents(fetchMock)).toHaveLength(0);
    expect(captures(fetchMock).some((e) => e.event === 'experiment_viewed')).toBe(false);
  });

  it('drops the queue on logout so one visitor’s impression is never attributed to the next', async () => {
    const { mod, fetchMock } = await loadShim();
    mod.track('experiment_viewed', { experiment: 'landing_hero_framing', variant: 'B' });
    mod.reset();
    mod.setTelemetryAuthToken('jwt-token');
    mod.identify(USER_A);
    await Promise.resolve();
    await Promise.resolve();

    expect(firstPartyEvents(fetchMock)).toHaveLength(0);
  });

  it('bounds the queue so an anonymous visitor cannot grow it without limit', async () => {
    const { mod, fetchMock } = await loadShim();
    for (let i = 0; i < 20; i += 1) {
      mod.track('experiment_viewed', { experiment: 'landing_hero_framing', variant: 'A' });
    }
    mod.setTelemetryAuthToken('jwt-token');
    mod.identify(USER_A);
    await Promise.resolve();
    await Promise.resolve();

    expect(firstPartyEvents(fetchMock).length).toBeLessThanOrEqual(5);
  });
});

describe('upgrade-intent event', () => {
  it('carries only closed-enum properties on the first-party rail', async () => {
    const { mod, fetchMock } = await loadShim();
    mod.setTelemetryAuthToken('jwt-token');
    mod.identify(USER_A);
    mod.setActiveHousehold(HOUSEHOLD_A);
    mod.track('subscription_upgraded', { upgradeTo: 'greenhouse', interval: 'year' });
    await Promise.resolve();
    await Promise.resolve();

    expect(firstPartyEvents(fetchMock)).toContainEqual({
      event: 'subscription_upgraded',
      properties: { upgradeTo: 'greenhouse', interval: 'year' },
      superProperties: {},
    });
  });
});
