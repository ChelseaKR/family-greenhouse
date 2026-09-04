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
vi.mock('../../../src/services/calendarTokens.js');
vi.mock('../../../src/services/billingEmails.js');
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
    // The deleteMe flow erases the whole user partition even when the user has
    // no memberships; default that mock here so each test declares only what
    // it cares about.
    async function mockUserScopedCleanup() {
      const accountCleanup = await import('../../../src/services/accountCleanup.js');
      vi.mocked(accountCleanup.anonymizeUserInHousehold).mockResolvedValue(undefined);
      vi.mocked(accountCleanup.deleteAbandonedHouseholdData).mockResolvedValue(undefined);
      vi.mocked(accountCleanup.deleteUserScopedData).mockResolvedValue(undefined);
      vi.mocked(accountCleanup.cancelAbandonedHouseholdSubscription).mockResolvedValue({
        outcome: 'no_subscription',
      });
    }

    // One household, one member, one plant: the shape in which account
    // deletion erases the household row that records its subscription.
    async function mockSoloHousehold() {
      const householdService = await import('../../../src/services/householdService.js');
      const plantService = await import('../../../src/services/plantService.js');
      const apiKeys = await import('../../../src/services/apiKeys.js');
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      vi.mocked(householdService.getMembershipsByUser).mockResolvedValue([
        { householdId: 'hh-1', role: 'admin', name: 'Home', joinedAt: '' },
      ]);
      vi.mocked(householdService.getHouseholdMembers).mockResolvedValue([
        {
          householdId: 'hh-1',
          userId: 'user-1',
          name: 'Test User',
          email: 'test@example.com',
          role: 'admin',
          joinedAt: '',
        },
      ]);
      vi.mocked(plantService.getPlants).mockResolvedValue([
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
      vi.mocked(plantService.deletePlant).mockResolvedValue(undefined);
      vi.mocked(apiKeys.listApiKeys).mockResolvedValue([]);
      vi.mocked(cognitoUsers.deleteUser).mockResolvedValue(undefined);
    }

    it('returns 204 when the lone member deletes their account (cascades plant + key cleanup)', async () => {
      const householdService = await import('../../../src/services/householdService.js');
      const plantService = await import('../../../src/services/plantService.js');
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const apiKeys = await import('../../../src/services/apiKeys.js');
      const accountCleanup = await import('../../../src/services/accountCleanup.js');
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
      expect(plantService.getPlants).toHaveBeenCalledWith('hh-1', 'all');
      expect(plantService.deletePlant).toHaveBeenCalledWith('hh-1', 'p1');
      expect(apiKeys.revokeApiKey).toHaveBeenCalledWith('hh-1', 'key-1');
      expect(accountCleanup.deleteAbandonedHouseholdData).toHaveBeenCalledWith('hh-1');
      expect(householdService.removeMember).not.toHaveBeenCalled();
      expect(cognitoUsers.deleteUser).toHaveBeenCalledWith('user-1');
    });

    it('cleans up EVERY household membership, push subscriptions, and prefs (multi-household)', async () => {
      const householdService = await import('../../../src/services/householdService.js');
      const plantService = await import('../../../src/services/plantService.js');
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const apiKeys = await import('../../../src/services/apiKeys.js');
      const accountCleanup = await import('../../../src/services/accountCleanup.js');
      const { deleteMe } = await import('../../../src/handlers/me/handler.js');
      await mockUserScopedCleanup();

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
      vi.mocked(accountCleanup.anonymizeUserInHousehold).mockResolvedValue(undefined);
      vi.mocked(accountCleanup.deleteUserScopedData).mockResolvedValue(undefined);
      vi.mocked(cognitoUsers.deleteUser).mockResolvedValueOnce(undefined);

      const res = (await deleteMe(
        buildEvent({ httpMethod: 'DELETE' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(204);
      // The solo household is swept as a whole; the retained household loses
      // only this user's member row.
      expect(householdService.removeMember).not.toHaveBeenCalledWith('hh-1', 'user-1');
      expect(householdService.removeMember).toHaveBeenCalledWith('hh-2', 'user-1');
      // Solo household hh-1 had its keys enumerated; multi-member hh-2 did not.
      expect(apiKeys.listApiKeys).toHaveBeenCalledWith('hh-1');
      expect(apiKeys.listApiKeys).not.toHaveBeenCalledWith('hh-2');
      expect(accountCleanup.deleteAbandonedHouseholdData).toHaveBeenCalledWith('hh-1');
      expect(accountCleanup.anonymizeUserInHousehold).not.toHaveBeenCalledWith('hh-1', 'user-1');
      expect(accountCleanup.anonymizeUserInHousehold).toHaveBeenCalledWith('hh-2', 'user-1');
      expect(accountCleanup.deleteUserScopedData).toHaveBeenCalledWith('user-1');
      expect(cognitoUsers.deleteUser).toHaveBeenCalledWith('user-1');
      // Subscriptions are per household: the abandoned solo household's is
      // cancelled, the retained household's is left alone.
      expect(accountCleanup.cancelAbandonedHouseholdSubscription).toHaveBeenCalledWith('hh-1');
      expect(accountCleanup.cancelAbandonedHouseholdSubscription).not.toHaveBeenCalledWith('hh-2');
    });

    it('cancels the abandoned household subscription before anything is destroyed', async () => {
      const plantService = await import('../../../src/services/plantService.js');
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const accountCleanup = await import('../../../src/services/accountCleanup.js');
      const { deleteMe } = await import('../../../src/handlers/me/handler.js');
      await mockUserScopedCleanup();
      await mockSoloHousehold();
      vi.mocked(accountCleanup.cancelAbandonedHouseholdSubscription).mockResolvedValue({
        outcome: 'canceled',
        subscriptionId: 'sub_1',
      });

      const res = (await deleteMe(
        buildEvent({ httpMethod: 'DELETE' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(204);
      expect(accountCleanup.cancelAbandonedHouseholdSubscription).toHaveBeenCalledWith('hh-1');
      // Ordering is the point: the subscription is dead before the household
      // row that records it and before the identity that could reach the
      // billing portal are erased.
      const cancelledAt = vi.mocked(accountCleanup.cancelAbandonedHouseholdSubscription).mock
        .invocationCallOrder[0];
      for (const later of [
        plantService.deletePlant,
        accountCleanup.deleteAbandonedHouseholdData,
        accountCleanup.deleteUserScopedData,
        cognitoUsers.deleteUser,
      ]) {
        expect(vi.mocked(later).mock.invocationCallOrder[0]).toBeGreaterThan(cancelledAt);
      }
    });

    it('never touches billing when a member leaves a household that keeps other members', async () => {
      const householdService = await import('../../../src/services/householdService.js');
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const accountCleanup = await import('../../../src/services/accountCleanup.js');
      const { deleteMe } = await import('../../../src/handlers/me/handler.js');
      await mockUserScopedCleanup();
      vi.mocked(householdService.getMembershipsByUser).mockResolvedValueOnce([
        { householdId: 'hh-2', role: 'member', name: 'Cabin', joinedAt: '' },
      ]);
      vi.mocked(householdService.getHouseholdMembers).mockResolvedValueOnce([
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
      ]);
      vi.mocked(householdService.removeMember).mockResolvedValueOnce(undefined);
      vi.mocked(cognitoUsers.deleteUser).mockResolvedValueOnce(undefined);

      const res = (await deleteMe(
        buildEvent({ httpMethod: 'DELETE' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(204);
      // The household — and its subscription — carry on without this member.
      expect(accountCleanup.cancelAbandonedHouseholdSubscription).not.toHaveBeenCalled();
      expect(householdService.removeMember).toHaveBeenCalledWith('hh-2', 'user-1');
      expect(cognitoUsers.deleteUser).toHaveBeenCalledWith('user-1');
    });

    it('refuses the deletion and destroys nothing when Stripe cannot confirm the cancellation', async () => {
      const householdService = await import('../../../src/services/householdService.js');
      const plantService = await import('../../../src/services/plantService.js');
      const apiKeys = await import('../../../src/services/apiKeys.js');
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const accountCleanup = await import('../../../src/services/accountCleanup.js');
      const { deleteMe } = await import('../../../src/handlers/me/handler.js');
      await mockUserScopedCleanup();
      await mockSoloHousehold();
      vi.mocked(accountCleanup.cancelAbandonedHouseholdSubscription).mockRejectedValue(
        new Error('Stripe is down')
      );

      const res = (await deleteMe(
        buildEvent({ httpMethod: 'DELETE' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      // Fail closed: a deleted user who is still being charged has no way to
      // stop it, so the account stays until Stripe confirms the cancellation.
      expect(res.statusCode).toBe(502);
      expect(res.body).toMatch(/not deleted/i);
      expect(plantService.deletePlant).not.toHaveBeenCalled();
      expect(apiKeys.listApiKeys).not.toHaveBeenCalled();
      expect(accountCleanup.deleteAbandonedHouseholdData).not.toHaveBeenCalled();
      expect(accountCleanup.anonymizeUserInHousehold).not.toHaveBeenCalled();
      expect(householdService.removeMember).not.toHaveBeenCalled();
      expect(accountCleanup.deleteUserScopedData).not.toHaveBeenCalled();
      expect(cognitoUsers.deleteUser).not.toHaveBeenCalled();
    });

    it('still deletes the account when the subscription was already cancelled (safe retry)', async () => {
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const accountCleanup = await import('../../../src/services/accountCleanup.js');
      const { deleteMe } = await import('../../../src/handlers/me/handler.js');
      await mockUserScopedCleanup();
      await mockSoloHousehold();
      vi.mocked(accountCleanup.cancelAbandonedHouseholdSubscription).mockResolvedValue({
        outcome: 'already_canceled',
        subscriptionId: 'sub_1',
      });

      const res = (await deleteMe(
        buildEvent({ httpMethod: 'DELETE' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(204);
      expect(accountCleanup.deleteAbandonedHouseholdData).toHaveBeenCalledWith('hh-1');
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
      const accountCleanup = await import('../../../src/services/accountCleanup.js');
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
      expect(accountCleanup.deleteUserScopedData).toHaveBeenCalledWith('user-1');
      expect(cognitoUsers.deleteUser).toHaveBeenCalledWith('user-1');
    });

    // ADR 0023: DELETE /me had a documented pseudonymization caveat and
    // nothing confirming it. These pin the two properties that make the
    // confirmation honest — it is sent only after the deletion really
    // happened, and its counts come from the work done, not an estimate.
    it('confirms the deletion by email, only after every step succeeded', async () => {
      const householdService = await import('../../../src/services/householdService.js');
      const plantService = await import('../../../src/services/plantService.js');
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const apiKeys = await import('../../../src/services/apiKeys.js');
      const billingEmails = await import('../../../src/services/billingEmails.js');
      const { deleteMe } = await import('../../../src/handlers/me/handler.js');
      await mockUserScopedCleanup();

      // One household the user is alone in (erased outright) and one they
      // share (history retained under a pseudonym).
      vi.mocked(householdService.getMembershipsByUser).mockResolvedValueOnce([
        { householdId: 'hh-1', role: 'admin', name: 'Home', joinedAt: '' },
        { householdId: 'hh-2', role: 'member', name: 'Cabin', joinedAt: '' },
      ]);
      const self = {
        householdId: 'hh-1',
        userId: 'user-1',
        name: 'Test User',
        email: 'test@example.com',
        role: 'admin' as const,
        joinedAt: '',
      };
      vi.mocked(householdService.getHouseholdMembers).mockImplementation(async (hh: string) =>
        hh === 'hh-1'
          ? [self]
          : [
              { ...self, householdId: 'hh-2', role: 'member' as const },
              {
                householdId: 'hh-2',
                userId: 'user-2',
                name: 'Other',
                email: 'other@example.com',
                role: 'admin' as const,
                joinedAt: '',
              },
            ]
      );
      vi.mocked(plantService.getPlants).mockResolvedValue([]);
      vi.mocked(apiKeys.listApiKeys).mockResolvedValue([]);
      vi.mocked(householdService.removeMember).mockResolvedValue(undefined);
      vi.mocked(cognitoUsers.deleteUser).mockResolvedValue(undefined);

      const res = (await deleteMe(
        buildEvent({ httpMethod: 'DELETE' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(204);
      expect(billingEmails.sendAccountDeletionEmail).toHaveBeenCalledWith({
        email: 'test@example.com',
        soleMemberHouseholds: 1,
        sharedHouseholds: 1,
      });
      // Sent last: the Cognito user is already gone, so the email cannot
      // promise a deletion that then failed.
      const deleteOrder = vi.mocked(cognitoUsers.deleteUser).mock.invocationCallOrder[0];
      const emailOrder = vi.mocked(billingEmails.sendAccountDeletionEmail).mock
        .invocationCallOrder[0];
      expect(emailOrder).toBeGreaterThan(deleteOrder);
    });

    it('still deletes the account when the confirmation email cannot be sent', async () => {
      const householdService = await import('../../../src/services/householdService.js');
      const cognitoUsers = await import('../../../src/services/cognitoUsers.js');
      const billingEmails = await import('../../../src/services/billingEmails.js');
      const { deleteMe } = await import('../../../src/handlers/me/handler.js');
      await mockUserScopedCleanup();
      vi.mocked(householdService.getMembershipsByUser).mockResolvedValueOnce([]);
      vi.mocked(cognitoUsers.deleteUser).mockResolvedValueOnce(undefined);
      vi.mocked(billingEmails.sendAccountDeletionEmail).mockResolvedValueOnce(false);

      const res = (await deleteMe(
        buildEvent({ httpMethod: 'DELETE' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      // The account is gone either way; refusing to confirm would not undo it.
      expect(res.statusCode).toBe(204);
      expect(billingEmails.sendAccountDeletionEmail).toHaveBeenCalled();
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

    it('is the ORIGINAL bug: rejects a calendar-app fetch (no session) with 401', async () => {
      // Settings used to hand out this URL bare. Calendar apps carry no
      // Cognito session, so every subscription fetch landed here (and, in
      // production, on the API Gateway JWT authorizer before that).
      const { calendarIcs } = await import('../../../src/handlers/me/handler.js');
      const res = (await calendarIcs(
        buildEvent({ requestContext: { identity: { sourceIp: '127.0.0.1' } } as never }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // Calendar-feed link (capability URL) — management routes + public feed
  // -------------------------------------------------------------------------

  const TOKEN = 'f'.repeat(64);
  const GRANT = {
    userId: 'user-1',
    householdId: 'hh-1',
    createdAt: '2026-09-01T00:00:00.000Z',
    lastUsedAt: null,
  };

  /** A genuinely anonymous event — no authorizer claims, as API Gateway
   *  delivers for an auth=none route. */
  function anonFeedEvent(token: string, ip = '10.0.0.1'): APIGatewayProxyEvent {
    return buildEvent({
      path: `/calendar/${token}/family-greenhouse.ics`,
      pathParameters: { token },
      requestContext: { identity: { sourceIp: ip } } as never,
    });
  }

  describe('getCalendarToken', () => {
    it('returns the non-secret status for the active household', async () => {
      const calendarTokens = await import('../../../src/services/calendarTokens.js');
      const { getCalendarToken } = await import('../../../src/handlers/me/handler.js');
      vi.mocked(calendarTokens.getCalendarToken).mockResolvedValueOnce({
        ...GRANT,
        lastUsedAt: '2026-09-02T00:00:00.000Z',
      });

      const res = (await getCalendarToken(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        active: true,
        createdAt: '2026-09-01T00:00:00.000Z',
        lastUsedAt: '2026-09-02T00:00:00.000Z',
      });
      expect(calendarTokens.getCalendarToken).toHaveBeenCalledWith('user-1', 'hh-1');
      // Status never carries a token (it isn't stored in a readable form).
      expect(res.body).not.toMatch(/token/);
    });

    it('reports active:false when the caller has no link', async () => {
      const calendarTokens = await import('../../../src/services/calendarTokens.js');
      const { getCalendarToken } = await import('../../../src/handlers/me/handler.js');
      vi.mocked(calendarTokens.getCalendarToken).mockResolvedValueOnce(null);
      const res = (await getCalendarToken(buildEvent(), ctx, () => {})) as APIGatewayProxyResult;
      expect(JSON.parse(res.body)).toEqual({ active: false, createdAt: null, lastUsedAt: null });
    });

    it('401s without claims and 403s without a household (management is authed)', async () => {
      const { getCalendarToken } = await import('../../../src/handlers/me/handler.js');
      const anon = (await getCalendarToken(
        buildEvent({ requestContext: { identity: { sourceIp: '127.0.0.1' } } as never }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(anon.statusCode).toBe(401);

      const noHousehold = (await getCalendarToken(
        buildEvent({
          requestContext: {
            authorizer: { claims: { sub: 'user-1', email: 'test@example.com' } },
          } as APIGatewayProxyEvent['requestContext'],
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(noHousehold.statusCode).toBe(403);
    });
  });

  describe('createCalendarToken', () => {
    beforeEach(async () => {
      const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
      __resetRateLimitForTests();
    });

    it('mints a token for (caller, active household) and returns it with the feed path — once', async () => {
      const calendarTokens = await import('../../../src/services/calendarTokens.js');
      const { createCalendarToken } = await import('../../../src/handlers/me/handler.js');
      vi.mocked(calendarTokens.createCalendarToken).mockResolvedValueOnce({
        record: GRANT,
        token: TOKEN,
      });
      vi.mocked(calendarTokens.calendarFeedPath).mockReturnValueOnce(
        `/calendar/${TOKEN}/family-greenhouse.ics`
      );

      const res = (await createCalendarToken(
        buildEvent({ httpMethod: 'POST' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body)).toEqual({
        active: true,
        createdAt: GRANT.createdAt,
        lastUsedAt: null,
        token: TOKEN,
        path: `/calendar/${TOKEN}/family-greenhouse.ics`,
      });
      expect(calendarTokens.createCalendarToken).toHaveBeenCalledWith('user-1', 'hh-1');
    });

    it('honours the X-Household-Id switch: the token binds to the ACTIVE household', async () => {
      const calendarTokens = await import('../../../src/services/calendarTokens.js');
      const { setCachedMembership } = await import('../../../src/utils/membershipCache.js');
      const { createCalendarToken } = await import('../../../src/handlers/me/handler.js');
      setCachedMembership('user-1', 'hh-2', 'member');
      vi.mocked(calendarTokens.createCalendarToken).mockResolvedValueOnce({
        record: { ...GRANT, householdId: 'hh-2' },
        token: TOKEN,
      });
      vi.mocked(calendarTokens.calendarFeedPath).mockReturnValueOnce('/calendar/x');

      const res = (await createCalendarToken(
        buildEvent({ httpMethod: 'POST', headers: { 'x-household-id': 'hh-2' } }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(201);
      expect(calendarTokens.createCalendarToken).toHaveBeenCalledWith('user-1', 'hh-2');
    });

    it('401s without claims — a calendar app can never mint its own link', async () => {
      const { createCalendarToken } = await import('../../../src/handlers/me/handler.js');
      const res = (await createCalendarToken(
        buildEvent({
          httpMethod: 'POST',
          requestContext: { identity: { sourceIp: '127.0.0.1' } } as never,
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(401);
    });
  });

  describe('revokeCalendarToken', () => {
    it('returns 204 after revoking', async () => {
      const calendarTokens = await import('../../../src/services/calendarTokens.js');
      const { revokeCalendarToken } = await import('../../../src/handlers/me/handler.js');
      vi.mocked(calendarTokens.revokeCalendarToken).mockResolvedValueOnce(true);
      const res = (await revokeCalendarToken(
        buildEvent({ httpMethod: 'DELETE' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(204);
      expect(calendarTokens.revokeCalendarToken).toHaveBeenCalledWith('user-1', 'hh-1');
    });

    it('returns 404 when there was no link to revoke', async () => {
      const calendarTokens = await import('../../../src/services/calendarTokens.js');
      const { revokeCalendarToken } = await import('../../../src/handlers/me/handler.js');
      vi.mocked(calendarTokens.revokeCalendarToken).mockResolvedValueOnce(false);
      const res = (await revokeCalendarToken(
        buildEvent({ httpMethod: 'DELETE' }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(404);
    });
  });

  describe('calendarFeed (public, auth=none)', () => {
    beforeEach(async () => {
      const { __resetRateLimitForTests } = await import('../../../src/middleware/rateLimit.js');
      __resetRateLimitForTests();
    });

    it('serves the feed for a valid token with NO Cognito session', async () => {
      const calendarTokens = await import('../../../src/services/calendarTokens.js');
      const householdService = await import('../../../src/services/householdService.js');
      const taskService = await import('../../../src/services/taskService.js');
      const icsExport = await import('../../../src/services/icsExport.js');
      const { calendarFeed } = await import('../../../src/handlers/me/handler.js');

      vi.mocked(calendarTokens.resolveCalendarToken).mockResolvedValueOnce(GRANT);
      vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce({
        householdId: 'hh-1',
        userId: 'user-1',
        name: 'Test User',
        email: 'test@example.com',
        role: 'member',
        joinedAt: '',
      });
      vi.mocked(taskService.getTasks).mockResolvedValueOnce([]);
      vi.mocked(icsExport.buildIcs).mockReturnValueOnce(
        'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'
      );

      const res = (await calendarFeed(
        anonFeedEvent(TOKEN),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(200);
      expect(res.headers?.['Content-Type']).toMatch(/text\/calendar/);
      expect(res.headers?.['Content-Disposition']).toMatch(/family-greenhouse\.ics/);
      expect(res.body).toContain('BEGIN:VCALENDAR');
      expect(calendarTokens.resolveCalendarToken).toHaveBeenCalledWith(TOKEN);
      // Scoped by the grant — the household the token was minted for.
      expect(householdService.getMemberByUserId).toHaveBeenCalledWith('hh-1', 'user-1');
      expect(taskService.getTasks).toHaveBeenCalledWith('hh-1');
    });

    it('ignores any household the request tries to smuggle in — the grant decides', async () => {
      const calendarTokens = await import('../../../src/services/calendarTokens.js');
      const householdService = await import('../../../src/services/householdService.js');
      const taskService = await import('../../../src/services/taskService.js');
      const { calendarFeed } = await import('../../../src/handlers/me/handler.js');

      vi.mocked(calendarTokens.resolveCalendarToken).mockResolvedValueOnce(GRANT);
      vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce({
        householdId: 'hh-1',
        userId: 'user-1',
        name: 'Test User',
        email: 'test@example.com',
        role: 'member',
        joinedAt: '',
      });
      vi.mocked(taskService.getTasks).mockResolvedValueOnce([]);

      const event = anonFeedEvent(TOKEN);
      event.headers = { 'x-household-id': 'hh-victim' };
      event.queryStringParameters = { householdId: 'hh-victim' };
      await calendarFeed(event, ctx, () => {});

      expect(taskService.getTasks).toHaveBeenCalledWith('hh-1');
      expect(taskService.getTasks).not.toHaveBeenCalledWith('hh-victim');
    });

    it('404s (one generic message) for an unknown, revoked, or regenerated token', async () => {
      const calendarTokens = await import('../../../src/services/calendarTokens.js');
      const taskService = await import('../../../src/services/taskService.js');
      const { calendarFeed } = await import('../../../src/handlers/me/handler.js');
      vi.mocked(calendarTokens.resolveCalendarToken).mockResolvedValueOnce(null);

      const res = (await calendarFeed(
        anonFeedEvent('0'.repeat(64)),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({
        message: 'This calendar link is invalid or has been revoked.',
      });
      expect(taskService.getTasks).not.toHaveBeenCalled();
    });

    it('404s with the SAME message when the token holder is no longer a household member', async () => {
      const calendarTokens = await import('../../../src/services/calendarTokens.js');
      const householdService = await import('../../../src/services/householdService.js');
      const taskService = await import('../../../src/services/taskService.js');
      const { calendarFeed } = await import('../../../src/handlers/me/handler.js');
      vi.mocked(calendarTokens.resolveCalendarToken).mockResolvedValueOnce(GRANT);
      vi.mocked(householdService.getMemberByUserId).mockResolvedValueOnce(null);

      const res = (await calendarFeed(
        anonFeedEvent(TOKEN),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({
        message: 'This calendar link is invalid or has been revoked.',
      });
      expect(taskService.getTasks).not.toHaveBeenCalled();
    });

    it('404s a missing token segment without a lookup', async () => {
      const calendarTokens = await import('../../../src/services/calendarTokens.js');
      const { calendarFeed } = await import('../../../src/handlers/me/handler.js');
      // resolveCalendarToken is automocked → returns undefined for '' — the
      // handler must treat that as a miss, not as a grant.
      const res = (await calendarFeed(
        buildEvent({
          pathParameters: null,
          requestContext: { identity: { sourceIp: '10.0.0.9' } } as never,
        }),
        ctx,
        () => {}
      )) as APIGatewayProxyResult;
      expect(res.statusCode).toBe(404);
      expect(calendarTokens.resolveCalendarToken).toHaveBeenCalledWith('');
    });

    it('is IP rate-limited (60/min) so a token can never be brute-forced through the feed', async () => {
      const calendarTokens = await import('../../../src/services/calendarTokens.js');
      const { calendarFeed } = await import('../../../src/handlers/me/handler.js');
      vi.mocked(calendarTokens.resolveCalendarToken).mockResolvedValue(null);
      let last: APIGatewayProxyResult | undefined;
      for (let i = 0; i < 61; i += 1) {
        last = (await calendarFeed(
          anonFeedEvent('1'.repeat(64), '10.9.9.9'),
          ctx,
          () => {}
        )) as APIGatewayProxyResult;
      }
      expect(last?.statusCode).toBe(429);
    });
  });
});
