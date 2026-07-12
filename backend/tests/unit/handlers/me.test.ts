import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

// The /me handlers fan out to a handful of services for export/delete
// operations; auth.test.ts established the pattern of mocking each service
// surface and asserting on the merged response shape.
vi.mock('../../../src/utils/cognito.js', () => ({
  cognito: { send: vi.fn() },
  CLIENT_ID: 'test-client-id',
}));
vi.mock('../../../src/services/cognitoUsers.js');
vi.mock('../../../src/services/householdService.js');
vi.mock('../../../src/services/plantService.js');
vi.mock('../../../src/services/taskService.js');
vi.mock('../../../src/services/notificationPrefs.js');
vi.mock('../../../src/services/pushSubscriptions.js');
vi.mock('../../../src/services/deviceTokens.js');
vi.mock('../../../src/services/accountCleanup.js');
vi.mock('../../../src/services/apiKeys.js');
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
vi.mock('../../../src/services/icsExport.js', () => ({
  buildIcs: vi.fn(() => 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'),
}));

function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    path: '/',
    pathParameters: null,
    queryStringParameters: null,
    requestContext: {
      authorizer: {
        claims: {
          sub: 'user-1',
          email: 'test@example.com',
          name: 'Test User',
          'custom:household_id': 'hh-1',
          'custom:household_role': 'admin',
        },
      },
      identity: { sourceIp: '127.0.0.1' },
    } as APIGatewayProxyEvent['requestContext'],
    resource: '/',
    stageVariables: null,
    ...overrides,
  };
}

const ctx = {} as Context;

describe('me handler', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    // authMiddleware validates the claim household against the membership
    // table; pre-warm the cache so the automocked householdService doesn't
    // 403 every request that carries the hh-1 claim.
    const { __resetMembershipCacheForTests } = await import('../../../src/middleware/auth.js');
    __resetMembershipCacheForTests();
    const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
    setCachedMembership('user-1', 'hh-1', 'admin');
  });

  describe('deleteMe', () => {
    // The deleteMe flow touches push subscriptions + notification prefs even
    // when the user has no memberships; default those mocks to empty here so
    // each test only declares what it cares about.
    async function mockUserScopedCleanup() {
      const pushSubscriptions = await import('../../../src/services/pushSubscriptions.js');
      const deviceTokens = await import('../../../src/services/deviceTokens.js');
      const accountCleanup = await import('../../../src/services/accountCleanup.js');
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      vi.mocked(pushSubscriptions.getUserSubscriptions).mockResolvedValue([]);
      vi.mocked(pushSubscriptions.deleteSubscription).mockResolvedValue(undefined);
      vi.mocked(deviceTokens.deleteUserDeviceTokens).mockResolvedValue(undefined);
      vi.mocked(accountCleanup.anonymizeUserInHousehold).mockResolvedValue(undefined);
      vi.mocked(dynamodb.send).mockResolvedValue({} as never);
    }

    it('returns 204 when the lone member deletes their account (cascades plant + key cleanup)', async () => {
      const householdService = await import('../../../src/services/householdService.js');
      const plantService = await import('../../../src/services/plantService.js');
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const apiKeys = await import('../../../src/services/apiKeys.js');
      const { deleteMe } = await import('../../../src/handlers/me/handler.js');
      await mockUserScopedCleanup();

      vi.mocked(householdService.getMembershipsByUser).mockResolvedValueOnce([
        { householdId: 'hh-1', role: 'admin', name: 'Home', joinedAt: '' },
      ]);
      vi.mocked(householdService.getHouseholdMembers).mockResolvedValueOnce([
        {
          householdId: 'hh-1',
          userId: 'user-1',
          name: 'Test User',
          email: 'test@example.com',
          role: 'admin',
          joinedAt: '',
        },
      ]);
      vi.mocked(plantService.getPlants).mockResolvedValueOnce([
        {
          id: 'p1',
          householdId: 'hh-1',
          name: 'Pothos',
          species: null,
          location: null,
          imageUrl: null,
          notes: null,
          createdAt: '',
          createdBy: '',
          updatedAt: '',
        },
      ]);
      vi.mocked(plantService.deletePlant).mockResolvedValueOnce(undefined);
      vi.mocked(apiKeys.listApiKeys).mockResolvedValueOnce([
        {
          id: 'key-1',
          householdId: 'hh-1',
          label: 'old key',
          last4: 'abcd',
          scopes: ['read:plants'],
          createdAt: '',
          createdBy: 'user-1',
          lastUsedAt: null,
        },
      ]);
      vi.mocked(apiKeys.revokeApiKey).mockResolvedValueOnce(true);
      vi.mocked(householdService.removeMember).mockResolvedValueOnce(undefined);
      vi.mocked(cognitoUsers.deleteUser).mockResolvedValueOnce(undefined);

      const res = (await deleteMe(
        buildEvent({ httpMethod: 'DELETE' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(204);
      expect(plantService.deletePlant).toHaveBeenCalledWith('hh-1', 'p1');
      expect(apiKeys.revokeApiKey).toHaveBeenCalledWith('hh-1', 'key-1');
      expect(householdService.removeMember).toHaveBeenCalledWith('hh-1', 'user-1');
      expect(cognitoUsers.deleteUser).toHaveBeenCalledWith('user-1');
    });

    it('cleans up EVERY household membership, push subscriptions, and prefs (multi-household)', async () => {
      const householdService = await import('../../../src/services/householdService.js');
      const plantService = await import('../../../src/services/plantService.js');
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const apiKeys = await import('../../../src/services/apiKeys.js');
      const pushSubscriptions = await import('../../../src/services/pushSubscriptions.js');
      const deviceTokens = await import('../../../src/services/deviceTokens.js');
      const accountCleanup = await import('../../../src/services/accountCleanup.js');
      const { dynamodb } = await import('../../../src/utils/dynamodb.js');
      const { deleteMe } = await import('../../../src/handlers/me/handler.js');

      // hh-1: solo household (full wipe). hh-2: multi-member household where
      // the caller is a plain member (just remove the row).
      vi.mocked(householdService.getMembershipsByUser).mockResolvedValueOnce([
        { householdId: 'hh-1', role: 'admin', name: 'Home', joinedAt: '' },
        { householdId: 'hh-2', role: 'member', name: 'Cabin', joinedAt: '' },
      ]);
      vi.mocked(householdService.getHouseholdMembers).mockImplementation(async (hh: string) =>
        hh === 'hh-1'
          ? [
              {
                householdId: 'hh-1',
                userId: 'user-1',
                name: 'Test User',
                email: 'test@example.com',
                role: 'admin',
                joinedAt: '',
              },
            ]
          : [
              {
                householdId: 'hh-2',
                userId: 'user-1',
                name: 'Test User',
                email: 'test@example.com',
                role: 'member',
                joinedAt: '',
              },
              {
                householdId: 'hh-2',
                userId: 'user-9',
                name: 'Owner',
                email: 'o@x.com',
                role: 'admin',
                joinedAt: '',
              },
            ]
      );
      vi.mocked(plantService.getPlants).mockResolvedValue([]);
      vi.mocked(apiKeys.listApiKeys).mockResolvedValue([]);
      vi.mocked(householdService.removeMember).mockResolvedValue(undefined);
      vi.mocked(pushSubscriptions.getUserSubscriptions).mockResolvedValueOnce([
        {
          userId: 'user-1',
          householdId: 'hh-1',
          endpoint: 'https://push.example/ep1',
          keys: { p256dh: 'k', auth: 'a' },
          createdAt: '',
        },
      ]);
      vi.mocked(pushSubscriptions.deleteSubscription).mockResolvedValue(undefined);
      vi.mocked(deviceTokens.deleteUserDeviceTokens).mockResolvedValue(undefined);
      vi.mocked(accountCleanup.anonymizeUserInHousehold).mockResolvedValue(undefined);
      vi.mocked(dynamodb.send).mockResolvedValue({} as never);
      vi.mocked(cognitoUsers.deleteUser).mockResolvedValueOnce(undefined);

      const res = (await deleteMe(
        buildEvent({ httpMethod: 'DELETE' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(204);
      // Member rows removed from BOTH households, not just the active claim one.
      expect(householdService.removeMember).toHaveBeenCalledWith('hh-1', 'user-1');
      expect(householdService.removeMember).toHaveBeenCalledWith('hh-2', 'user-1');
      // Solo household hh-1 had its keys enumerated; multi-member hh-2 did not.
      expect(apiKeys.listApiKeys).toHaveBeenCalledWith('hh-1');
      expect(apiKeys.listApiKeys).not.toHaveBeenCalledWith('hh-2');
      // Push subscription deleted via the service surface.
      expect(pushSubscriptions.deleteSubscription).toHaveBeenCalledWith(
        'user-1',
        'https://push.example/ep1'
      );
      expect(deviceTokens.deleteUserDeviceTokens).toHaveBeenCalledWith('user-1');
      expect(accountCleanup.anonymizeUserInHousehold).toHaveBeenCalledWith('hh-1', 'user-1');
      expect(accountCleanup.anonymizeUserInHousehold).toHaveBeenCalledWith('hh-2', 'user-1');
      // Notification prefs row deleted inline (USER#{id}/PREFS).
      const prefDelete = vi
        .mocked(dynamodb.send)
        .mock.calls.map((c) => c[0] as unknown as { input?: { Key?: Record<string, string> } })
        .find((c) => c.input?.Key?.SK === 'PREFS');
      expect(prefDelete?.input?.Key).toEqual({ PK: 'USER#user-1', SK: 'PREFS' });
      expect(cognitoUsers.deleteUser).toHaveBeenCalledWith('user-1');
    });

    it('refuses when caller is the only admin in ANY multi-member household, before deleting anything', async () => {
      const householdService = await import('../../../src/services/householdService.js');
      const plantService = await import('../../../src/services/plantService.js');
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const { deleteMe } = await import('../../../src/handlers/me/handler.js');
      await mockUserScopedCleanup();

      vi.mocked(householdService.getMembershipsByUser).mockResolvedValueOnce([
        { householdId: 'hh-1', role: 'admin', name: 'Home', joinedAt: '' },
      ]);
      vi.mocked(householdService.getHouseholdMembers).mockResolvedValueOnce([
        {
          householdId: 'hh-1',
          userId: 'user-1',
          name: 'Test User',
          email: 'test@example.com',
          role: 'admin',
          joinedAt: '',
        },
        {
          householdId: 'hh-1',
          userId: 'user-2',
          name: 'Other',
          email: 'b@x.com',
          role: 'member',
          joinedAt: '',
        },
      ]);

      const res = (await deleteMe(
        buildEvent({ httpMethod: 'DELETE' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/promote another member/i);
      // Make sure we didn't get past the guardrail.
      expect(plantService.deletePlant).not.toHaveBeenCalled();
      expect(householdService.removeMember).not.toHaveBeenCalled();
      expect(cognitoUsers.deleteUser).not.toHaveBeenCalled();
    });

    it('returns 401 when no auth claims are present', async () => {
      const { deleteMe } = await import('../../../src/handlers/me/handler.js');
      const res = (await deleteMe(
        buildEvent({
          httpMethod: 'DELETE',
          requestContext: {} as APIGatewayProxyEvent['requestContext'],
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(401);
    });

    it('allows deletion before the user has created or joined a household', async () => {
      const householdService = await import('../../../src/services/householdService.js');
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const deviceTokens = await import('../../../src/services/deviceTokens.js');
      const { deleteMe } = await import('../../../src/handlers/me/handler.js');
      await mockUserScopedCleanup();
      vi.mocked(householdService.getMembershipsByUser).mockResolvedValueOnce([]);
      vi.mocked(cognitoUsers.deleteUser).mockResolvedValueOnce(undefined);

      const event = buildEvent({ httpMethod: 'DELETE' });
      event.requestContext.authorizer = {
        claims: { sub: 'user-1', email: 'test@example.com', name: 'Test User' },
      };
      const res = (await deleteMe(event, ctx, () => {})) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(204);
      expect(deviceTokens.deleteUserDeviceTokens).toHaveBeenCalledWith('user-1');
      expect(cognitoUsers.deleteUser).toHaveBeenCalledWith('user-1');
    });
  });

  describe('exportMe', () => {
    it('returns the merged GDPR payload across user/prefs/memberships', async () => {
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const householdService = await import('../../../src/services/householdService.js');
      const plantService = await import('../../../src/services/plantService.js');
      const taskService = await import('../../../src/services/taskService.js');
      const notificationPrefs = await import('../../../src/services/notificationPrefs.js');
      const { exportMe } = await import('../../../src/handlers/me/handler.js');

      vi.mocked(cognitoUsers.getUserName).mockResolvedValueOnce('Test User');
      vi.mocked(notificationPrefs.getPreferences).mockResolvedValueOnce({
        userId: 'user-1',
        browser: false,
        email: true,
        sms: false,
        phone: '',
        dndStart: '',
        dndEnd: '',
        timezone: 'UTC',
        pestAlerts: false,
        updatedAt: '',
      });
      vi.mocked(householdService.getMembershipsByUser).mockResolvedValueOnce([
        { householdId: 'hh-1', role: 'admin', name: 'Home', joinedAt: '2025-01-01' },
      ]);
      vi.mocked(householdService.getHousehold).mockResolvedValueOnce({
        id: 'hh-1',
        name: 'Home',
        location: null,
        createdAt: '',
        createdBy: 'user-1',
      });
      vi.mocked(plantService.getPlants).mockResolvedValueOnce([]);
      vi.mocked(taskService.getTasks).mockResolvedValueOnce([]);

      const res = (await exportMe(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      // Filename header is what makes browsers offer the export as a download.
      expect(res.headers?.['Content-Disposition']).toMatch(/family-greenhouse-export\.json/);
      expect(res.headers?.['Cache-Control']).toBe('no-store');
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        format: 'family-greenhouse-export',
        version: 1,
        user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
        households: [
          expect.objectContaining({
            id: 'hh-1',
            name: 'Home',
            role: 'admin',
            plants: [],
            tasks: [],
          }),
        ],
      });
    });

    it('includes died/gave-away plants in the export (explicit filter: "all")', async () => {
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const householdService = await import('../../../src/services/householdService.js');
      const plantService = await import('../../../src/services/plantService.js');
      const taskService = await import('../../../src/services/taskService.js');
      const notificationPrefs = await import('../../../src/services/notificationPrefs.js');
      const { exportMe } = await import('../../../src/handlers/me/handler.js');

      vi.mocked(cognitoUsers.getUserName).mockResolvedValueOnce('Test User');
      vi.mocked(notificationPrefs.getPreferences).mockResolvedValueOnce({
        userId: 'user-1',
        browser: false,
        email: true,
        sms: false,
        phone: '',
        dndStart: '',
        dndEnd: '',
        timezone: 'UTC',
        pestAlerts: false,
        updatedAt: '',
      });
      vi.mocked(householdService.getMembershipsByUser).mockResolvedValueOnce([
        { householdId: 'hh-1', role: 'admin', name: 'Home', joinedAt: '2025-01-01' },
      ]);
      vi.mocked(householdService.getHousehold).mockResolvedValueOnce({
        id: 'hh-1',
        name: 'Home',
        location: null,
        createdAt: '',
        createdBy: 'user-1',
      });
      // getPlants defaults to filter:'active' when called with no filter —
      // the bug was exportMe relying on that default and silently dropping
      // this plant.
      vi.mocked(plantService.getPlants).mockResolvedValueOnce([
        {
          id: 'p-died',
          householdId: 'hh-1',
          name: 'Fiddle Leaf Fig',
          species: null,
          location: null,
          imageUrl: null,
          notes: null,
          status: 'died',
          statusChangedAt: '2026-01-01',
          tags: [],
          perenualSpeciesId: null,
          parentPlantId: null,
          createdAt: '',
          createdBy: 'user-1',
          updatedAt: '',
        },
      ]);
      vi.mocked(taskService.getTasks).mockResolvedValueOnce([]);

      const res = (await exportMe(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(plantService.getPlants).toHaveBeenCalledWith('hh-1', 'all');
      const body = JSON.parse(res.body);
      expect(body.households[0].plants).toContainEqual(
        expect.objectContaining({ id: 'p-died', status: 'died' })
      );
    });

    it('returns an empty households array when the user has no memberships', async () => {
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const householdService = await import('../../../src/services/householdService.js');
      const notificationPrefs = await import('../../../src/services/notificationPrefs.js');
      const { exportMe } = await import('../../../src/handlers/me/handler.js');

      vi.mocked(cognitoUsers.getUserName).mockResolvedValueOnce('Test User');
      vi.mocked(notificationPrefs.getPreferences).mockResolvedValueOnce({
        userId: 'user-1',
        browser: false,
        email: true,
        sms: false,
        phone: '',
        dndStart: '',
        dndEnd: '',
        timezone: 'UTC',
        pestAlerts: false,
        updatedAt: '',
      });
      vi.mocked(householdService.getMembershipsByUser).mockResolvedValueOnce([]);

      const res = (await exportMe(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.households).toEqual([]);
    });
  });

  describe('listMyHouseholds', () => {
    it('hydrates membership rows with household names', async () => {
      const householdService = await import('../../../src/services/householdService.js');
      const { listMyHouseholds } = await import('../../../src/handlers/me/handler.js');

      vi.mocked(householdService.getMembershipsByUser).mockResolvedValueOnce([
        { householdId: 'hh-1', role: 'admin', name: '', joinedAt: '2025-01-01' },
        { householdId: 'hh-2', role: 'member', name: '', joinedAt: '2025-02-02' },
      ]);
      vi.mocked(householdService.getHousehold)
        .mockResolvedValueOnce({
          id: 'hh-1',
          name: 'Home',
          location: null,
          createdAt: '',
          createdBy: 'user-1',
        })
        .mockResolvedValueOnce({
          id: 'hh-2',
          name: 'Cabin',
          location: null,
          createdAt: '',
          createdBy: 'user-2',
        });

      const res = (await listMyHouseholds(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual([
        { householdId: 'hh-1', name: 'Home', role: 'admin', joinedAt: '2025-01-01' },
        { householdId: 'hh-2', name: 'Cabin', role: 'member', joinedAt: '2025-02-02' },
      ]);
    });

    it('returns 401 without auth claims', async () => {
      const { listMyHouseholds } = await import('../../../src/handlers/me/handler.js');
      const res = (await listMyHouseholds(
        buildEvent({ requestContext: {} as APIGatewayProxyEvent['requestContext'] }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(401);
    });
  });

  describe('calendarIcs', () => {
    it('returns an ICS body with calendar headers for the caller household', async () => {
      const taskService = await import('../../../src/services/taskService.js');
      const icsExport = await import('../../../src/services/icsExport.js');
      const { calendarIcs } = await import('../../../src/handlers/me/handler.js');

      vi.mocked(taskService.getTasks).mockResolvedValueOnce([]);
      // The default mock for buildIcs already returns a tiny VCALENDAR; we just
      // assert the handler hands it through with the right Content-Type.
      vi.mocked(icsExport.buildIcs).mockReturnValueOnce(
        'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'
      );

      const res = (await calendarIcs(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(res.headers?.['Content-Type']).toMatch(/text\/calendar/);
      expect(res.headers?.['Content-Disposition']).toMatch(/family-greenhouse\.ics/);
      expect(res.body).toContain('BEGIN:VCALENDAR');
      expect(taskService.getTasks).toHaveBeenCalledWith('hh-1');
    });

    it('returns 403 when the caller has no active household', async () => {
      const { calendarIcs } = await import('../../../src/handlers/me/handler.js');
      const res = (await calendarIcs(
        buildEvent({
          requestContext: {
            authorizer: {
              claims: {
                sub: 'user-1',
                email: 'test@example.com',
                // No custom:household_id — user is in onboarding
              },
            },
          } as APIGatewayProxyEvent['requestContext'],
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      // 403 per convention: well-formed request, identity lacks a household.
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/no household/i);
    });
  });
});
