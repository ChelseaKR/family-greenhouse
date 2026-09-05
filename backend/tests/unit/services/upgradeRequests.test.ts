/**
 * Member → admin upgrade requests: tier resolution, admin resolution (every
 * admin, never the requester), the DynamoDB-backed once-a-week limit, the
 * email/push fan-out, and honest delivery flags.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  GetCommand: vi.fn(function (input) {
    return { input, kind: 'Get' };
  }),
  PutCommand: vi.fn(function (input) {
    return { input, kind: 'Put' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/householdService.js');
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(),
}));
vi.mock('../../../src/services/notifier.js');
vi.mock('../../../src/services/emailNotifier.js');
vi.mock('../../../src/services/activity.js', () => ({ recordActivity: vi.fn(async () => {}) }));

const NOW = new Date('2026-09-03T10:00:00.000Z');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const MEMBERS = [
  {
    householdId: 'hh-1',
    userId: 'u-admin',
    name: 'Maria',
    email: 'maria@example.com',
    role: 'admin' as const,
    joinedAt: '',
  },
  {
    householdId: 'hh-1',
    userId: 'u-admin-2',
    name: 'Tom',
    email: 'tom@example.com',
    role: 'admin' as const,
    joinedAt: '',
  },
  {
    householdId: 'hh-1',
    userId: 'u-sam',
    name: 'Sam',
    email: 'sam@example.com',
    role: 'member' as const,
    joinedAt: '',
  },
];

async function setup({
  planId = 'seedling' as 'seedling' | 'garden' | 'greenhouse',
  members = MEMBERS,
  emailSent = true,
  pushDelivered = true,
} = {}) {
  const billing = await import('../../../src/services/billing.js');
  const householdService = await import('../../../src/services/householdService.js');
  const notifier = await import('../../../src/services/notifier.js');
  const emailNotifier = await import('../../../src/services/emailNotifier.js');
  const { dynamodb } = await import('../../../src/utils/dynamodb.js');
  vi.mocked(billing.getHouseholdSubscription).mockResolvedValue({ planId } as never);
  vi.mocked(householdService.getHousehold).mockResolvedValue({
    id: 'hh-1',
    name: 'The Kelly-Reifs',
    createdAt: '',
    createdBy: 'u-admin',
  });
  vi.mocked(householdService.getHouseholdMembers).mockResolvedValue(members);
  vi.mocked(emailNotifier.sendEmail).mockResolvedValue(emailSent);
  vi.mocked(notifier.sendToUser).mockResolvedValue({
    delivered: pushDelivered,
    dndSuppressedOnly: false,
    channels: { browser: pushDelivered ? 'delivered' : 'failed', email: 'skipped', sms: 'skipped' },
  });
  vi.mocked(dynamodb.send).mockResolvedValue({} as never);
  return { billing, householdService, notifier, emailNotifier, dynamodb };
}

function request(overrides: Partial<{ feature: string; userId: string }> = {}) {
  return {
    householdId: 'hh-1',
    requester: { userId: overrides.userId ?? 'u-sam', email: 'sam@example.com' },
    feature: (overrides.feature ?? 'chat') as never,
    appUrl: 'https://app.example.net/',
    now: NOW,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveTargetPlan', () => {
  it('names the lowest tier that includes a fixed-tier feature', async () => {
    const { resolveTargetPlan } = await import('../../../src/services/upgradeRequests.js');
    expect(resolveTargetPlan('chat', 'seedling')).toBe('garden');
    expect(resolveTargetPlan('api_keys', 'seedling')).toBe('greenhouse');
    expect(resolveTargetPlan('api_keys', 'garden')).toBe('greenhouse');
    expect(resolveTargetPlan('greenhouse_plan', 'garden')).toBe('greenhouse');
  });

  it('answers null when the household already includes the feature', async () => {
    const { resolveTargetPlan } = await import('../../../src/services/upgradeRequests.js');
    expect(resolveTargetPlan('chat', 'garden')).toBeNull();
    expect(resolveTargetPlan('chat', 'greenhouse')).toBeNull();
    expect(resolveTargetPlan('api_keys', 'greenhouse')).toBeNull();
    expect(resolveTargetPlan('garden_plan', 'garden')).toBeNull();
  });

  it('resolves the Away Kit against the one boundary planIncludesAwayKit draws', async () => {
    const { resolveTargetPlan } = await import('../../../src/services/upgradeRequests.js');
    const { PLANS, planIncludesAwayKit } = await import('../../../src/models/plans.js');
    // The ask must target the same line the entitlement check uses, or a
    // member is emailing an admin about a gate they are already past (#480).
    expect(resolveTargetPlan('away_kit', 'seedling')).toBe('garden');
    expect(resolveTargetPlan('away_kit', 'garden')).toBeNull();
    expect(resolveTargetPlan('away_kit', 'greenhouse')).toBeNull();
    for (const plan of Object.values(PLANS)) {
      expect(resolveTargetPlan('away_kit', plan.id) === null).toBe(planIncludesAwayKit(plan));
    }
  });

  it('names the Away Kit in the copy an admin actually receives', async () => {
    const { composeUpgradeRequestEmail, composeUpgradeRequestPush } =
      await import('../../../src/models/upgradeFeatures.js');
    const input = {
      adminName: 'Maria',
      memberName: 'Sam',
      householdName: 'The Kim House',
      feature: 'away_kit' as const,
      targetPlanId: 'garden' as const,
      appUrl: 'https://app.example',
      householdId: 'hh-1',
    };
    expect(composeUpgradeRequestEmail(input).text).toContain('The Away Kit');
    expect(composeUpgradeRequestPush(input).body).toContain('The Away Kit');
  });

  it('resolves cap features against the live catalog, skipping tiers that do not raise the cap', async () => {
    const { resolveTargetPlan } = await import('../../../src/services/upgradeRequests.js');
    const { PLANS, isUnlimited } = await import('../../../src/models/plans.js');
    expect(resolveTargetPlan('plant_cap', 'seedling')).toBe('garden');
    expect(resolveTargetPlan('plant_cap', 'garden')).toBe('greenhouse');
    expect(resolveTargetPlan('plant_cap', 'greenhouse')).toBeNull();
    // The first tier that actually adds seats is the answer — whichever that
    // is in the catalog. Since ADR 0014 a cap is a `Limit`, so `null`
    // (unlimited) is the HIGHEST ceiling, not a missing one: Garden's
    // unlimited membership genuinely raises Seedling's three.
    const seedlingMembers = PLANS.seedling.limits.members;
    const gardenMembers = PLANS.garden.limits.members;
    const gardenAddsSeats = isUnlimited(gardenMembers)
      ? !isUnlimited(seedlingMembers)
      : !isUnlimited(seedlingMembers) && gardenMembers > seedlingMembers;
    expect(resolveTargetPlan('member_cap', 'seedling')).toBe(
      gardenAddsSeats ? 'garden' : 'greenhouse'
    );
    expect(resolveTargetPlan('member_cap', 'greenhouse')).toBeNull();
  });
});

describe('composeUpgradeRequestEmail', () => {
  it('names the member, the feature, the plan with its price, and links to billing', async () => {
    const { composeUpgradeRequestEmail } = await import('../../../src/services/upgradeRequests.js');
    const { subject, text } = composeUpgradeRequestEmail({
      adminName: 'Maria',
      memberName: 'Sam',
      householdName: 'The Kelly-Reifs',
      feature: 'chat',
      targetPlanId: 'garden',
      appUrl: 'https://app.example.net/',
    });
    expect(subject).toBe('Sam asked to upgrade The Kelly-Reifs');
    expect(text).toContain('Hi Maria,');
    expect(text).toContain('Plant care chat');
    expect(text).toContain('Garden plan, $4.99 a month');
    expect(text).toContain('https://app.example.net/settings/billing');
    expect(text).not.toContain('https://app.example.net//');
    expect(text).toContain('Nothing has been');
  });

  it('uses a generic greeting for a blank admin name', async () => {
    const { composeUpgradeRequestEmail } = await import('../../../src/services/upgradeRequests.js');
    const { text } = composeUpgradeRequestEmail({
      adminName: '  ',
      memberName: 'Sam',
      householdName: 'Home',
      feature: 'api_keys',
      targetPlanId: 'greenhouse',
      appUrl: 'https://app.example.net',
    });
    expect(text).toContain('Hi there,');
    expect(text).toContain('Greenhouse plan, $9.99 a month');
  });
});

describe('requestUpgrade — admin resolution', () => {
  it('tells EVERY admin, never the requester, and returns names only', async () => {
    const { emailNotifier, notifier } = await setup();
    const { requestUpgrade } = await import('../../../src/services/upgradeRequests.js');

    const result = await requestUpgrade(request());

    expect(result.targetPlanId).toBe('garden');
    expect(result.admins).toEqual([
      { userId: 'u-admin', name: 'Maria' },
      { userId: 'u-admin-2', name: 'Tom' },
    ]);
    expect(JSON.stringify(result)).not.toContain('@example.com');
    const emailTo = vi.mocked(emailNotifier.sendEmail).mock.calls.map(([m]) => m.to);
    expect(emailTo.sort()).toEqual(['maria@example.com', 'tom@example.com']);
    const pushTo = vi.mocked(notifier.sendToUser).mock.calls.map(([r]) => r.userId);
    expect(pushTo.sort()).toEqual(['u-admin', 'u-admin-2']);
    // Push is browser-only so the email is not doubled through the reminder path.
    for (const [, , opts] of vi.mocked(notifier.sendToUser).mock.calls) {
      expect(opts?.channels).toEqual(['browser']);
    }
  });

  it('names the specific feature in both the email and the push', async () => {
    const { emailNotifier, notifier } = await setup({ planId: 'garden' });
    const { requestUpgrade } = await import('../../../src/services/upgradeRequests.js');

    await requestUpgrade(request({ feature: 'api_keys' }));

    const [email] = vi.mocked(emailNotifier.sendEmail).mock.calls[0];
    expect(email.subject).toBe('Sam asked to upgrade The Kelly-Reifs');
    expect(email.text).toContain('API keys');
    expect(email.text).toContain('Greenhouse plan');
    const [, push] = vi.mocked(notifier.sendToUser).mock.calls[0];
    expect(push.title).toBe('Sam asked to upgrade The Kelly-Reifs');
    expect(push.body).toContain('API keys');
    expect(push.url).toBe('https://app.example.net/settings/billing');
    expect(push.tag).toBe('upgrade-request:hh-1:api_keys');
  });

  it('excludes the requester even when their row says admin', async () => {
    const { emailNotifier } = await setup({
      members: MEMBERS.map((m) => (m.userId === 'u-sam' ? { ...m, role: 'admin' as const } : m)),
    });
    const { requestUpgrade } = await import('../../../src/services/upgradeRequests.js');
    const result = await requestUpgrade(request());
    expect(result.admins.map((a) => a.userId)).not.toContain('u-sam');
    expect(vi.mocked(emailNotifier.sendEmail).mock.calls.map(([m]) => m.to)).not.toContain(
      'sam@example.com'
    );
  });

  it('refuses, without writing, when the household has no other admin', async () => {
    const { dynamodb } = await setup({
      members: [MEMBERS[2], { ...MEMBERS[2], userId: 'u-x', name: 'X', email: 'x@example.com' }],
    });
    const { requestUpgrade } = await import('../../../src/services/upgradeRequests.js');
    await expect(requestUpgrade(request())).rejects.toMatchObject({
      name: 'NoHouseholdAdminError',
    });
    expect(dynamodb.send).not.toHaveBeenCalled();
  });

  it('refuses, without writing or sending, when the plan already includes the feature', async () => {
    const { dynamodb, emailNotifier } = await setup({ planId: 'garden' });
    const { requestUpgrade } = await import('../../../src/services/upgradeRequests.js');
    await expect(requestUpgrade(request({ feature: 'chat' }))).rejects.toMatchObject({
      name: 'UpgradeAlreadyIncludedError',
    });
    expect(dynamodb.send).not.toHaveBeenCalled();
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
  });

  it('records the ask in the household activity feed', async () => {
    await setup();
    const { recordActivity } = await import('../../../src/services/activity.js');
    const { requestUpgrade } = await import('../../../src/services/upgradeRequests.js');
    await requestUpgrade(request());
    expect(recordActivity).toHaveBeenCalledWith({
      type: 'upgrade.requested',
      householdId: 'hh-1',
      actorId: 'u-sam',
      actorName: 'Sam',
      payload: { feature: 'chat', plan: 'garden' },
    });
  });
});

describe('requestUpgrade — once per member per feature per 7 days', () => {
  it('claims the weekly slot with a conditional Put keyed by feature + member, with a TTL', async () => {
    const { dynamodb } = await setup();
    const { requestUpgrade } = await import('../../../src/services/upgradeRequests.js');

    const result = await requestUpgrade(request());

    const put = vi
      .mocked(dynamodb.send)
      .mock.calls.map(([c]) => c as unknown as { kind: string; input: Record<string, unknown> })
      .find((c) => c.kind === 'Put')!;
    expect(put.input.TableName).toBe('test-table');
    const item = put.input.Item as Record<string, unknown>;
    expect(item.PK).toBe('HOUSEHOLD#hh-1');
    expect(item.SK).toBe('UPGRADE_REQUEST#chat#u-sam');
    expect(item.requestedAtEpoch).toBe(Math.floor(NOW.getTime() / 1000));
    expect(item.ttl).toBeGreaterThan(Math.floor((NOW.getTime() + WEEK_MS) / 1000));
    expect(put.input.ConditionExpression).toBe(
      'attribute_not_exists(PK) OR requestedAtEpoch < :cutoff'
    );
    expect(put.input.ExpressionAttributeValues).toEqual({
      ':cutoff': Math.floor((NOW.getTime() - WEEK_MS) / 1000),
    });
    expect(result.nextAllowedAt).toBe(new Date(NOW.getTime() + WEEK_MS).toISOString());
  });

  it('refuses a repeat inside the window, sends nothing, and reports when to ask again', async () => {
    const { dynamodb, emailNotifier, notifier } = await setup();
    const earlierEpoch = Math.floor((NOW.getTime() - 2 * 24 * 60 * 60 * 1000) / 1000);
    vi.mocked(dynamodb.send)
      .mockRejectedValueOnce(
        Object.assign(new Error('The conditional request failed'), {
          name: 'ConditionalCheckFailedException',
        })
      )
      .mockResolvedValueOnce({ Item: { requestedAtEpoch: earlierEpoch } } as never);
    const { requestUpgrade } = await import('../../../src/services/upgradeRequests.js');

    await expect(requestUpgrade(request())).rejects.toMatchObject({
      name: 'UpgradeRequestRateLimitedError',
      nextAllowedAt: new Date(earlierEpoch * 1000 + WEEK_MS).toISOString(),
    });
    expect(emailNotifier.sendEmail).not.toHaveBeenCalled();
    expect(notifier.sendToUser).not.toHaveBeenCalled();
    const { recordActivity } = await import('../../../src/services/activity.js');
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it('scopes the limit per feature: a different feature is a fresh ask', async () => {
    const { dynamodb } = await setup();
    const { requestUpgrade } = await import('../../../src/services/upgradeRequests.js');
    await requestUpgrade(request({ feature: 'chat' }));
    await requestUpgrade(request({ feature: 'api_keys' }));
    const keys = vi
      .mocked(dynamodb.send)
      .mock.calls.map(([c]) => c as unknown as { kind: string; input: { Item?: { SK: string } } })
      .filter((c) => c.kind === 'Put')
      .map((c) => c.input.Item!.SK);
    expect(keys).toEqual(['UPGRADE_REQUEST#chat#u-sam', 'UPGRADE_REQUEST#api_keys#u-sam']);
  });

  it('never guesses the retry date: an unreadable marker reports null', async () => {
    const { dynamodb } = await setup();
    vi.mocked(dynamodb.send)
      .mockRejectedValueOnce(
        Object.assign(new Error('The conditional request failed'), {
          name: 'ConditionalCheckFailedException',
        })
      )
      .mockRejectedValueOnce(new Error('ddb down'));
    const { requestUpgrade } = await import('../../../src/services/upgradeRequests.js');
    await expect(requestUpgrade(request())).rejects.toMatchObject({
      name: 'UpgradeRequestRateLimitedError',
      nextAllowedAt: null,
    });
  });

  it('propagates a non-conditional DynamoDB failure', async () => {
    const { dynamodb } = await setup();
    vi.mocked(dynamodb.send).mockRejectedValueOnce(new Error('throttled'));
    const { requestUpgrade } = await import('../../../src/services/upgradeRequests.js');
    await expect(requestUpgrade(request())).rejects.toThrow('throttled');
  });
});

describe('requestUpgrade — honest delivery flags', () => {
  it('reports emailDelivered=false when SES is unconfigured (dry run), not a success', async () => {
    await setup({ emailSent: false });
    const { requestUpgrade } = await import('../../../src/services/upgradeRequests.js');
    const result = await requestUpgrade(request());
    expect(result.emailDelivered).toBe(false);
    expect(result.pushDelivered).toBe(true);
  });

  it('isolates channel failures: a throwing email sender still leaves the push and the record', async () => {
    const { emailNotifier } = await setup();
    vi.mocked(emailNotifier.sendEmail).mockRejectedValue(new Error('ses down'));
    const { requestUpgrade } = await import('../../../src/services/upgradeRequests.js');
    const result = await requestUpgrade(request());
    expect(result.emailDelivered).toBe(false);
    expect(result.pushDelivered).toBe(true);
    const { recordActivity } = await import('../../../src/services/activity.js');
    expect(recordActivity).toHaveBeenCalledTimes(1);
  });

  it('counts a delivery when ANY admin was reached', async () => {
    const { emailNotifier, notifier } = await setup({ pushDelivered: false });
    vi.mocked(emailNotifier.sendEmail).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(notifier.sendToUser).mockRejectedValue(new Error('push down'));
    const { requestUpgrade } = await import('../../../src/services/upgradeRequests.js');
    const result = await requestUpgrade(request());
    expect(result.emailDelivered).toBe(true);
    expect(result.pushDelivered).toBe(false);
  });
});
