import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/householdService.js', () => ({
  getHouseholdMembers: vi.fn(),
  listAllHouseholdIds: vi.fn(),
  getHousehold: vi.fn(),
}));
vi.mock('../../../src/services/taskService.js', () => ({
  getYearInReview: vi.fn(),
}));
vi.mock('../../../src/services/plantService.js', () => ({
  getPlants: vi.fn(),
}));
vi.mock('../../../src/services/notificationPrefs.js', () => ({
  getPreferences: vi.fn(),
  isInDndWindow: vi.fn(() => false),
}));
vi.mock('../../../src/services/emailNotifier.js', () => ({
  // Resolves true = a real delivery (sendEmail returns false only on a dry-run).
  sendEmail: vi.fn().mockResolvedValue(true),
  // #433's discriminated result. The digest calls this one so a skipped send
  // can name its reason; `accepted` drives the marker exactly as before.
  sendEmailAccepted: vi.fn().mockResolvedValue({ accepted: true, reason: 'sent' }),
}));
// Composition is exercised in digestReport.test.ts; here we care about who
// gets mailed, in what language, once.
vi.mock('../../../src/services/digestReport.js', () => ({
  gatherDigestReport: vi.fn(),
  // #459: the cheap at-risk gate `digestHousehold` now runs BEFORE any member
  // or preference read. Defaults to "worth sending" so every existing test
  // reaches the code it was written for.
  gatherAtRisk: vi.fn(async () => ({ status: 'ok', rows: [{}], onTrack: 0, orphanTasks: 0 })),
  atRiskIsWorthSending: vi.fn(() => true),
  digestIsWorthSending: vi.fn(() => true),
  composeDigestEmail: vi.fn(() => ({
    subject: 'Weekly digest: 1 plant could use some care',
    text: 'text',
    html: '<p>html</p>',
    headers: { 'List-Unsubscribe': '<https://api.example/u?t=tok>' },
  })),
  readHouseholdName: vi.fn(async () => ({ status: 'ok', name: 'The Kim House' })),
}));
vi.mock('../../../src/services/email/capability.js', () => ({
  mintUnsubscribeToken: vi.fn(async () => ({ status: 'ok', token: 'tok' })),
}));

const NOW = new Date('2026-06-11T12:00:00.000Z'); // Thursday, ISO week 2026-W24

const memberA = {
  householdId: 'hh',
  userId: 'u1',
  name: 'A',
  email: 'a@x.com',
  role: 'admin' as const,
  joinedAt: '2026-01-01',
};
const memberB = {
  householdId: 'hh',
  userId: 'u2',
  name: 'B',
  email: 'b@x.com',
  role: 'member' as const,
  joinedAt: '2026-02-01',
};

const okReport = (over: Record<string, unknown> = {}) => ({
  householdId: 'hh',
  householdName: 'The Kim House',
  atRisk: { status: 'ok', rows: [{ plantId: 'p1' }], onTrack: 0, orphanTasks: 0 },
  lastCare: new Map(),
  weather: { status: 'none' },
  trend: { status: 'ok', last7: 0, prev7: 0 },
  pets: { status: 'ok', warnings: [] },
  awayUserIds: new Set<string>(),
  coverage: new Map(),
  ...over,
});

async function mockPrefs(
  byUser: Record<
    string,
    { email?: boolean; weeklyDigest?: boolean; yearRecap?: boolean; emailLocale?: string }
  >
) {
  const prefs = await import('../../../src/services/notificationPrefs.js');
  vi.mocked(prefs.getPreferences).mockImplementation(
    async (userId: string) =>
      ({
        email: true,
        weeklyDigest: true,
        yearRecap: true,
        emailLocale: '',
        ...byUser[userId],
      }) as never
  );
}

/** Same conditional-put simulation as reminders.test.ts: a second Put on a
 *  PK|SK throws ConditionalCheckFailed, which is what the dedupe relies on. */
async function mockConditionalMarkerStore() {
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  const markers = new Set<string>();
  vi.mocked(dynamodb.send).mockImplementation(async (cmd: unknown) => {
    const { input, kind } = cmd as {
      kind?: 'Put' | 'Get' | 'Delete' | 'Update';
      input: { Item?: { PK: string; SK: string }; Key?: { PK: string; SK: string } };
    };
    if (kind === 'Get' && input.Key) {
      const key = `${input.Key.PK}|${input.Key.SK}`;
      return {
        Item: markers.has(key) ? { PK: input.Key.PK, SK: input.Key.SK } : undefined,
      } as never;
    }
    if (kind === 'Delete' && input.Key) {
      markers.delete(`${input.Key.PK}|${input.Key.SK}`);
      return {} as never;
    }
    if (kind === 'Update' && input.Key) {
      return {} as never;
    }
    const key = `${input.Item!.PK}|${input.Item!.SK}`;
    if (markers.has(key)) {
      const err = new Error('The conditional request failed');
      err.name = 'ConditionalCheckFailedException';
      throw err;
    }
    markers.add(key);
    return {} as never;
  });
  return markers;
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.FRONTEND_URL = 'https://app.example';
  process.env.PUBLIC_API_URL = 'https://api.example';
  const report = await import('../../../src/services/digestReport.js');
  vi.mocked(report.gatherDigestReport).mockResolvedValue(okReport() as never);
  vi.mocked(report.digestIsWorthSending).mockReturnValue(true);
  vi.mocked(report.atRiskIsWorthSending).mockReturnValue(true);
  vi.mocked(report.readHouseholdName).mockResolvedValue({
    status: 'ok',
    name: 'The Kim House',
  } as never);
  const capability = await import('../../../src/services/email/capability.js');
  vi.mocked(capability.mintUnsubscribeToken).mockResolvedValue({
    status: 'ok',
    token: 'tok',
  } as never);
});

describe('weekly digest delivery', () => {
  it('sends to members with email + weeklyDigest enabled, skips others', async () => {
    const household = await import('../../../src/services/householdService.js');
    const email = await import('../../../src/services/emailNotifier.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA, memberB] as never);
    await mockPrefs({ u1: {}, u2: { weeklyDigest: false } });

    expect(await digestHousehold('hh', NOW)).toBe(1);
    expect(email.sendEmailAccepted).toHaveBeenCalledOnce();
    expect(vi.mocked(email.sendEmailAccepted).mock.calls[0][0].to).toBe('a@x.com');
  });

  it('skips members whose email channel is off even if weeklyDigest is on', async () => {
    const household = await import('../../../src/services/householdService.js');
    const email = await import('../../../src/services/emailNotifier.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    await mockPrefs({ u1: { email: false } });

    expect(await digestHousehold('hh', NOW)).toBe(0);
    expect(email.sendEmailAccepted).not.toHaveBeenCalled();
  });

  it('sends both parts and the one-click unsubscribe headers', async () => {
    const household = await import('../../../src/services/householdService.js');
    const email = await import('../../../src/services/emailNotifier.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    await mockPrefs({ u1: {} });

    await digestHousehold('hh', NOW);
    const sent = vi.mocked(email.sendEmailAccepted).mock.calls[0][0];
    expect(sent.text).toBeTruthy();
    expect(sent.html).toBeTruthy();
    expect(sent.headers?.['List-Unsubscribe']).toBeTruthy();
  });

  it('mints a per-recipient unsubscribe token scoped to the digest category', async () => {
    const household = await import('../../../src/services/householdService.js');
    const capability = await import('../../../src/services/email/capability.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA, memberB] as never);
    await mockPrefs({ u1: {}, u2: {} });

    await digestHousehold('hh', NOW);
    expect(vi.mocked(capability.mintUnsubscribeToken).mock.calls).toEqual([
      ['u1', 'weekly_digest'],
      ['u2', 'weekly_digest'],
    ]);
  });

  it('omits the unsubscribe link rather than shipping one that cannot work', async () => {
    const household = await import('../../../src/services/householdService.js');
    const capability = await import('../../../src/services/email/capability.js');
    const report = await import('../../../src/services/digestReport.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    await mockPrefs({ u1: {} });
    vi.mocked(capability.mintUnsubscribeToken).mockResolvedValue({
      status: 'unavailable',
      reason: 'write_failed',
    } as never);

    await digestHousehold('hh', NOW);
    expect(vi.mocked(report.composeDigestEmail).mock.calls[0][1].unsubscribeUrl).toBeNull();
  });

  it('sends nobody a digest while they are away on a vacation window', async () => {
    const household = await import('../../../src/services/householdService.js');
    const email = await import('../../../src/services/emailNotifier.js');
    const report = await import('../../../src/services/digestReport.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(report.gatherDigestReport).mockResolvedValue(
      okReport({ awayUserIds: new Set(['u2']) }) as never
    );
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA, memberB] as never);
    await mockPrefs({ u1: {}, u2: {} });

    expect(await digestHousehold('hh', NOW)).toBe(1);
    expect(vi.mocked(email.sendEmailAccepted).mock.calls[0][0].to).toBe('a@x.com');
  });

  it('defers a digest during quiet hours without burning its weekly marker', async () => {
    const household = await import('../../../src/services/householdService.js');
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const email = await import('../../../src/services/emailNotifier.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    await mockPrefs({ u1: {} });

    vi.mocked(prefs.isInDndWindow).mockReturnValueOnce(true);
    expect(await digestHousehold('hh', NOW)).toBe(0);
    expect(email.sendEmailAccepted).not.toHaveBeenCalled();

    vi.mocked(prefs.isInDndWindow).mockReturnValue(false);
    expect(await digestHousehold('hh', NOW)).toBe(1);
  });

  it('dedupes per user and household per ISO week; a new week sends again', async () => {
    const household = await import('../../../src/services/householdService.js');
    const email = await import('../../../src/services/emailNotifier.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    await mockPrefs({ u1: {} });

    expect(await digestHousehold('hh', NOW)).toBe(1);
    expect(await digestHousehold('hh', NOW)).toBe(0);
    expect(await digestHousehold('hh', new Date(NOW.getTime() + 7 * 86400000))).toBe(1);
    expect(email.sendEmailAccepted).toHaveBeenCalledTimes(2);
  });

  it('sends distinct weekly summaries for a user who belongs to two households', async () => {
    const household = await import('../../../src/services/householdService.js');
    const email = await import('../../../src/services/emailNotifier.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    await mockPrefs({ u1: {} });

    expect(await digestHousehold('hh', NOW)).toBe(1);
    expect(await digestHousehold('hh-2', NOW)).toBe(1);
    expect(email.sendEmailAccepted).toHaveBeenCalledTimes(2);
  });

  it('releases the reservation when SES throws, so the next run retries', async () => {
    const household = await import('../../../src/services/householdService.js');
    const email = await import('../../../src/services/emailNotifier.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    await mockPrefs({ u1: {} });
    vi.mocked(email.sendEmailAccepted).mockRejectedValueOnce(new Error('SES down'));

    expect(await digestHousehold('hh', NOW)).toBe(0);
    vi.mocked(email.sendEmailAccepted).mockResolvedValue({
      accepted: true,
      reason: 'sent',
    } as never);
    expect(await digestHousehold('hh', NOW)).toBe(1);
  });
});

describe('suppression must not burn the weekly marker', () => {
  // #433 added self-service resume, so an address suppressed on Monday and
  // resumed on Wednesday has to be able to receive that week's digest. Burning
  // the marker would drop it silently — a delivery lost with nothing recording
  // why. This mirrors the DND path, which also skips without claiming.
  it('leaves the slot unclaimed for a suppressed address, so a later pass delivers', async () => {
    const household = await import('../../../src/services/householdService.js');
    const email = await import('../../../src/services/emailNotifier.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    await mockPrefs({ u1: {} });

    vi.mocked(email.sendEmailAccepted).mockResolvedValueOnce({
      accepted: false,
      reason: 'suppressed',
    } as never);
    expect(await digestHousehold('hh', NOW)).toBe(0);

    // Same ISO week, address since resumed: the digest still goes out.
    vi.mocked(email.sendEmailAccepted).mockResolvedValue({
      accepted: true,
      reason: 'sent',
    } as never);
    expect(await digestHousehold('hh', NOW)).toBe(1);
  });

  it('does the same when the suppression store could not be read', async () => {
    // "We could not tell" is not "fine" and not "blocked" — it must not cost
    // the recipient their week.
    const household = await import('../../../src/services/householdService.js');
    const email = await import('../../../src/services/emailNotifier.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    await mockPrefs({ u1: {} });

    vi.mocked(email.sendEmailAccepted).mockResolvedValueOnce({
      accepted: false,
      reason: 'suppression_unknown',
    } as never);
    expect(await digestHousehold('hh', NOW)).toBe(0);

    vi.mocked(email.sendEmailAccepted).mockResolvedValue({
      accepted: true,
      reason: 'sent',
    } as never);
    expect(await digestHousehold('hh', NOW)).toBe(1);
  });
});

describe('weekly digest: recipient gates run before the report is built (#459)', () => {
  // The EventBridge rule fires four times on Monday so households in every
  // timezone get their digest at a reasonable local hour, and the per-ISO-week
  // marker is what stops them getting four. That marker used to be the LAST
  // gate, so runs 2, 3 and 4 rebuilt the whole report for every household that
  // had already been digested at 00:00, in order to discover that it had.
  it('does not build the report when every member was already digested this week', async () => {
    const household = await import('../../../src/services/householdService.js');
    const report = await import('../../../src/services/digestReport.js');
    const { logger } = await import('../../../src/utils/logger.js');
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    await mockPrefs({ u1: {} });

    // Run 1 of the Monday: sends, and burns the week's marker.
    expect(await digestHousehold('hh', NOW)).toBe(1);
    expect(report.gatherDigestReport).toHaveBeenCalledTimes(1);

    // Runs 2, 3 and 4: the marker already says this member has been digested,
    // so there is nobody to build a report for.
    expect(await digestHousehold('hh', NOW)).toBe(0);
    expect(await digestHousehold('hh', NOW)).toBe(0);
    expect(await digestHousehold('hh', NOW)).toBe(0);
    expect(report.gatherDigestReport).toHaveBeenCalledTimes(1);

    // And the skip is on the record — a household that stops receiving digests
    // has to be explicable from the logs.
    const skips = info.mock.calls
      .map(([fields]) => fields as unknown as Record<string, unknown>)
      .filter((fields) => fields?.msg === 'digest.skipped_no_recipients');
    expect(skips).toHaveLength(3);
    expect(skips[0]).toMatchObject({ householdId: 'hh', members: 1 });
    info.mockRestore();
  });

  it('does not build the report when every member is inside their quiet hours', async () => {
    const household = await import('../../../src/services/householdService.js');
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const report = await import('../../../src/services/digestReport.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA, memberB] as never);
    await mockPrefs({ u1: {}, u2: {} });
    vi.mocked(prefs.isInDndWindow).mockReturnValue(true);

    expect(await digestHousehold('hh', NOW)).toBe(0);
    // Deferred, not skipped: neither weekly marker was claimed, so a later run
    // in the same week still delivers.
    expect(report.gatherDigestReport).not.toHaveBeenCalled();
    // `vi.clearAllMocks()` clears calls, not implementations — restore the
    // shared default so this cannot leak into the next test.
    vi.mocked(prefs.isInDndWindow).mockReturnValue(false);
  });

  it('does not build the report when nobody has the weekly digest turned on', async () => {
    const household = await import('../../../src/services/householdService.js');
    const report = await import('../../../src/services/digestReport.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    await mockPrefs({ u1: { weeklyDigest: false } });

    expect(await digestHousehold('hh', NOW)).toBe(0);
    expect(report.gatherDigestReport).not.toHaveBeenCalled();
  });

  it('reads the at-risk rows once and hands them to the report, not twice', async () => {
    const household = await import('../../../src/services/householdService.js');
    const report = await import('../../../src/services/digestReport.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    const atRisk = { status: 'ok', rows: [{ plantId: 'p1' }], onTrack: 0, orphanTasks: 0 };
    vi.mocked(report.gatherAtRisk).mockResolvedValue(atRisk as never);
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    await mockPrefs({ u1: {} });

    expect(await digestHousehold('hh', NOW)).toBe(1);

    expect(report.gatherAtRisk).toHaveBeenCalledTimes(1);
    // Gating on it early would be a false economy if the report then read it
    // again — the two queries would just move rather than disappear.
    expect(vi.mocked(report.gatherDigestReport).mock.calls[0][2]).toBe(atRisk);
  });

  it('still checks the away set, which only the report can answer', async () => {
    // The issue proposed hoisting this one with the others. It cannot be
    // hoisted: `awayUserIds` is produced BY the report, out of the household's
    // vacation map. It stays below, where it costs nothing.
    const household = await import('../../../src/services/householdService.js');
    const report = await import('../../../src/services/digestReport.js');
    const email = await import('../../../src/services/emailNotifier.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(report.gatherDigestReport).mockResolvedValue(
      okReport({ awayUserIds: new Set(['u1']) }) as never
    );
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    await mockPrefs({ u1: {} });

    expect(await digestHousehold('hh', NOW)).toBe(0);
    expect(email.sendEmailAccepted).not.toHaveBeenCalled();
  });
});

describe('weekly digest: nothing to say', () => {
  it('skips the send and logs why rather than mailing a cheerful nothing', async () => {
    const household = await import('../../../src/services/householdService.js');
    const email = await import('../../../src/services/emailNotifier.js');
    const report = await import('../../../src/services/digestReport.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    // #459 moved this decision onto the at-risk result alone so it can be made
    // from two reads instead of thirteen; `digestIsWorthSending` still agrees.
    vi.mocked(report.atRiskIsWorthSending).mockReturnValue(false);
    vi.mocked(report.digestIsWorthSending).mockReturnValue(false);
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    await mockPrefs({ u1: {} });

    expect(await digestHousehold('hh', NOW)).toBe(0);
    expect(email.sendEmailAccepted).not.toHaveBeenCalled();
    // No member or preference reads at all on the quiet path.
    expect(household.getHouseholdMembers).not.toHaveBeenCalled();
    // …and none of the eleven reads the rest of the report costs, either.
    expect(report.gatherDigestReport).not.toHaveBeenCalled();
  });

  it('STILL sends when the at-risk read failed, so silence is not an all-clear', async () => {
    const household = await import('../../../src/services/householdService.js');
    const email = await import('../../../src/services/emailNotifier.js');
    const report = await import('../../../src/services/digestReport.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    // The real predicates, against an at-risk read that failed.
    vi.mocked(report.atRiskIsWorthSending).mockImplementation(
      (a) => a.status !== 'ok' || a.rows.length > 0
    );
    vi.mocked(report.gatherAtRisk).mockResolvedValue({ status: 'unavailable' } as never);
    vi.mocked(report.digestIsWorthSending).mockImplementation(
      (r) => r.atRisk.status !== 'ok' || r.atRisk.rows.length > 0
    );
    vi.mocked(report.gatherDigestReport).mockResolvedValue(
      okReport({ atRisk: { status: 'unavailable' } }) as never
    );
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    await mockPrefs({ u1: {} });

    expect(await digestHousehold('hh', NOW)).toBe(1);
    expect(email.sendEmailAccepted).toHaveBeenCalledOnce();
  });
});

describe('weekly digest: language', () => {
  it("writes in the recipient's own language when they have chosen one", async () => {
    const household = await import('../../../src/services/householdService.js');
    const report = await import('../../../src/services/digestReport.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    await mockPrefs({ u1: { emailLocale: 'es' } });

    await digestHousehold('hh', NOW);
    expect(vi.mocked(report.composeDigestEmail).mock.calls[0][1].locale).toBe('es');
  });

  it("falls back to the household's language before falling back to English", async () => {
    const household = await import('../../../src/services/householdService.js');
    const report = await import('../../../src/services/digestReport.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA, memberB] as never);
    // The earliest joiner chose Spanish; the newest member has chosen nothing
    // and must not be mailed in English just for being new.
    await mockPrefs({ u1: { emailLocale: 'es' }, u2: {} });

    await digestHousehold('hh', NOW);
    const locales = vi.mocked(report.composeDigestEmail).mock.calls.map((call) => call[1].locale);
    expect(locales).toEqual(['es', 'es']);
  });

  it('falls back to English only when nobody in the household has chosen', async () => {
    const household = await import('../../../src/services/householdService.js');
    const report = await import('../../../src/services/digestReport.js');
    const { digestHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    await mockPrefs({ u1: {} });

    await digestHousehold('hh', NOW);
    expect(vi.mocked(report.composeDigestEmail).mock.calls[0][1].locale).toBe('en');
  });
});

describe('runWeeklyDigests', () => {
  it('scans every household and survives one failing', async () => {
    const household = await import('../../../src/services/householdService.js');
    const report = await import('../../../src/services/digestReport.js');
    const { runWeeklyDigests } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.listAllHouseholdIds).mockResolvedValue(['h1', 'h2'] as never);
    vi.mocked(report.gatherDigestReport)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(okReport() as never);
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA] as never);
    await mockPrefs({ u1: {} });

    await expect(runWeeklyDigests(NOW)).resolves.toEqual({
      households: 2,
      // Both were reached: an untruncated run visits every household, so
      // `attempted` equals `households` and nothing was left for next time.
      attempted: 2,
      sent: 1,
      failed: 1,
      truncated: false,
    });
  });
});

describe('isoWeekKey', () => {
  it('produces stable ISO-8601 week keys across year boundaries', async () => {
    const { isoWeekKey } = await import('../../../src/services/digest.js');
    expect(isoWeekKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeekKey(new Date('2026-06-11T00:00:00Z'))).toBe('2026-W24');
    expect(isoWeekKey(new Date('2027-01-03T00:00:00Z'))).toBe('2026-W53');
  });
});

// ---------------------------------------------------------------------------
// Year recap
// ---------------------------------------------------------------------------

const review = (over: Record<string, unknown> = {}) => ({
  year: 2025,
  totalCompletions: 412,
  byMember: [
    { userId: 'u1', name: 'Sam', count: 233 },
    { userId: 'u2', name: 'Alex', count: 179 },
  ],
  byTaskType: [{ type: 'water', count: 301 }],
  topPlants: [{ plantId: 'p1', count: 51 }],
  ...over,
});

const recapRecipient = { name: 'Sam', locale: 'en' as const, unsubscribeUrl: null };

describe('composeRecapEmail', () => {
  it('celebrates completions by member, type and top plant, with links', async () => {
    const { composeRecapEmail } = await import('../../../src/services/digest.js');
    const { subject, text, html } = composeRecapEmail(
      review(),
      { status: 'ok', names: new Map([['p1', 'Monstera']]) },
      recapRecipient,
      'The Kim House'
    );
    expect(subject).toBe('Your 2025 plant care year in review 🌱');
    expect(text).toContain('Your household completed 412 plant-care tasks in 2025.');
    expect(text).toContain('Sam');
    expect(text).toContain('Monstera');
    expect(html).toContain('https://app.example/plants/p1');
    expect(html).toContain('https://app.example/analytics');
  });

  it('never announces a plant as gone because its name could not be looked up', async () => {
    // 'A former plant' asserted a fact about the plant's lifecycle from a
    // failed read — the exact defect class ADR 0010 names.
    const { composeRecapEmail } = await import('../../../src/services/digest.js');
    const { text } = composeRecapEmail(review(), { status: 'unavailable' }, recapRecipient);
    expect(text).not.toContain('A former plant');
    expect(text).toContain('A plant we could not look up');
    expect(text).toContain('It does not mean those plants are gone.');
  });

  it('renders a member with no stored display name as an unknown, not as a UUID', async () => {
    const { composeRecapEmail } = await import('../../../src/services/digest.js');
    const { text } = composeRecapEmail(
      review({
        byMember: [{ userId: '8f3c1d2e-0000-4000-8000-000000000001', name: null, count: 37 }],
      }),
      { status: 'ok', names: new Map() },
      recapRecipient
    );
    expect(text).not.toContain('8f3c1d2e');
    expect(text).toContain('A household member');
  });

  it('caps the listed plants at ten while the service list stays complete', async () => {
    const { composeRecapEmail } = await import('../../../src/services/digest.js');
    const topPlants = Array.from({ length: 14 }, (_, i) => ({ plantId: `p${i}`, count: 14 - i }));
    const names = new Map(topPlants.map((p) => [p.plantId, `Plant ${p.plantId}`]));
    const { text } = composeRecapEmail(
      review({ topPlants }),
      { status: 'ok', names },
      recapRecipient
    );
    expect(text).toContain('Plant p9');
    expect(text).not.toContain('Plant p10');
  });

  it('writes the recap in Spanish', async () => {
    const { composeRecapEmail } = await import('../../../src/services/digest.js');
    const { subject, html } = composeRecapEmail(
      review(),
      { status: 'ok', names: new Map([['p1', 'Monstera']]) },
      { ...recapRecipient, locale: 'es' }
    );
    expect(subject).toBe('Tu año 2025 de cuidado de plantas 🌱');
    expect(html).toContain('<html lang="es"');
  });

  it('carries the unsubscribe headers when a capability URL exists', async () => {
    const { composeRecapEmail } = await import('../../../src/services/digest.js');
    const { headers } = composeRecapEmail(
      review(),
      { status: 'ok', names: new Map() },
      {
        ...recapRecipient,
        unsubscribeUrl: 'https://api.example/u?t=tok',
      }
    );
    expect(headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });
});

describe('year recap delivery', () => {
  async function setupRecap() {
    const tasks = await import('../../../src/services/taskService.js');
    const plants = await import('../../../src/services/plantService.js');
    const household = await import('../../../src/services/householdService.js');
    vi.mocked(tasks.getYearInReview).mockResolvedValue(review() as never);
    vi.mocked(plants.getPlants).mockResolvedValue([{ id: 'p1', name: 'Monstera' }] as never);
    vi.mocked(household.getHouseholdMembers).mockResolvedValue([memberA, memberB] as never);
  }

  it('honours the new yearRecap opt-out, which used to not exist', async () => {
    // Before this, the recap was gated on `email` alone: a user who unticked
    // the weekly digest still received the January summary.
    const email = await import('../../../src/services/emailNotifier.js');
    const { recapHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    await setupRecap();
    await mockPrefs({ u1: {}, u2: { yearRecap: false } });

    expect(await recapHousehold('hh', 2025, NOW)).toBe(1);
    expect(vi.mocked(email.sendEmailAccepted).mock.calls[0][0].to).toBe('a@x.com');
  });

  it('sends both parts with the recap unsubscribe category', async () => {
    const email = await import('../../../src/services/emailNotifier.js');
    const capability = await import('../../../src/services/email/capability.js');
    const { recapHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    await setupRecap();
    await mockPrefs({ u1: {}, u2: { email: false } });

    await recapHousehold('hh', 2025, NOW);
    const sent = vi.mocked(email.sendEmailAccepted).mock.calls[0][0];
    expect(sent.html).toContain('<!DOCTYPE html>');
    expect(sent.headers?.['List-Unsubscribe']).toBeTruthy();
    expect(vi.mocked(capability.mintUnsubscribeToken).mock.calls[0]).toEqual(['u1', 'year_recap']);
  });

  it('says the plant names could not be loaded rather than claiming plants are gone', async () => {
    const plants = await import('../../../src/services/plantService.js');
    const email = await import('../../../src/services/emailNotifier.js');
    const { recapHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    await setupRecap();
    vi.mocked(plants.getPlants).mockRejectedValue(new Error('ddb down'));
    await mockPrefs({ u1: {}, u2: { email: false } });

    expect(await recapHousehold('hh', 2025, NOW)).toBe(1);
    expect(vi.mocked(email.sendEmailAccepted).mock.calls[0][0].text).toContain(
      'A plant we could not look up'
    );
  });

  it('skips households with zero completions BEFORE claiming any marker', async () => {
    const tasks = await import('../../../src/services/taskService.js');
    const household = await import('../../../src/services/householdService.js');
    const email = await import('../../../src/services/emailNotifier.js');
    const { recapHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(tasks.getYearInReview).mockResolvedValue(review({ totalCompletions: 0 }) as never);

    expect(await recapHousehold('hh', 2025, NOW)).toBe(0);
    expect(household.getHouseholdMembers).not.toHaveBeenCalled();
    expect(email.sendEmailAccepted).not.toHaveBeenCalled();
  });

  it('honours the once-per-year marker and retries only a failed recipient', async () => {
    const email = await import('../../../src/services/emailNotifier.js');
    const { recapHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    await setupRecap();
    await mockPrefs({ u1: {}, u2: {} });
    vi.mocked(email.sendEmailAccepted)
      .mockResolvedValueOnce({ accepted: true, reason: 'sent' } as never)
      .mockResolvedValueOnce({ accepted: false, reason: 'dry_run' } as never);

    expect(await recapHousehold('hh', 2025, NOW)).toBe(1);
    vi.mocked(email.sendEmailAccepted).mockResolvedValue({
      accepted: true,
      reason: 'sent',
    } as never);
    // u1 is already recapped; only u2 is retried.
    expect(await recapHousehold('hh', 2025, NOW)).toBe(1);
    expect(vi.mocked(email.sendEmailAccepted).mock.calls.at(-1)?.[0].to).toBe('b@x.com');
  });

  it('defers a recap during quiet hours without burning its annual marker', async () => {
    const prefs = await import('../../../src/services/notificationPrefs.js');
    const email = await import('../../../src/services/emailNotifier.js');
    const { recapHousehold } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    await setupRecap();
    await mockPrefs({ u1: {}, u2: { email: false } });

    vi.mocked(prefs.isInDndWindow).mockReturnValueOnce(true);
    expect(await recapHousehold('hh', 2025, NOW)).toBe(0);
    expect(email.sendEmailAccepted).not.toHaveBeenCalled();

    vi.mocked(prefs.isInDndWindow).mockReturnValue(false);
    expect(await recapHousehold('hh', 2025, NOW)).toBe(1);
  });

  it('runYearRecaps defaults to the previous calendar year', async () => {
    const tasks = await import('../../../src/services/taskService.js');
    const household = await import('../../../src/services/householdService.js');
    const { runYearRecaps, defaultRecapYear } = await import('../../../src/services/digest.js');
    await mockConditionalMarkerStore();
    vi.mocked(household.listAllHouseholdIds).mockResolvedValue(['h1'] as never);
    vi.mocked(tasks.getYearInReview).mockResolvedValue(review({ totalCompletions: 0 }) as never);

    const result = await runYearRecaps(undefined, NOW);
    expect(result.year).toBe(defaultRecapYear(NOW));
    expect(vi.mocked(tasks.getYearInReview).mock.calls[0][1]).toBe(2025);
  });
});
