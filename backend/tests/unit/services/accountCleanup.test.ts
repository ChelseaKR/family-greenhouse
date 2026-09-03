import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { HouseholdSubscription } from '../../../src/services/billing.js';

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  QueryCommand: vi.fn(function (input) {
    return { input, kind: 'Query' };
  }),
  UpdateCommand: vi.fn(function (input) {
    return { input, kind: 'Update' };
  }),
  DeleteCommand: vi.fn(function (input) {
    return { input, kind: 'Delete' };
  }),
}));
vi.mock('../../../src/utils/dynamodb.js', () => ({
  dynamodb: { send: vi.fn() },
  TABLE_NAME: 'test-table',
}));
// The cancellation path only needs billing's two exported seams: the stored
// household subscription and the lazily built Stripe client. Faking the client
// here (the same `subscriptions.cancel` shape billing.test.ts fakes) keeps the
// Stripe SDK and its key out of the picture entirely.
vi.mock('../../../src/services/billing.js', () => ({
  getHouseholdSubscription: vi.fn(),
  getStripe: vi.fn(),
}));

describe('account cleanup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('anonymizes retained history and clears active task assignments', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockImplementation(async (raw) => {
      const command = raw as unknown as {
        kind: string;
        input: {
          IndexName?: string;
          Key?: Record<string, string>;
          KeyConditionExpression?: string;
          ExpressionAttributeValues?: Record<string, string>;
        };
      };
      if (command.kind !== 'Query') return {} as never;
      if (command.input.IndexName === 'GSI1') {
        if (command.input.ExpressionAttributeValues?.[':pk'] === 'HOUSEHOLD#hh#SITTER') {
          return {
            Items: [
              {
                PK: 'SITTER#secret',
                SK: 'METADATA',
                createdBy: 'u1',
              },
            ],
          } as never;
        }
        return {
          Items: [
            {
              PK: 'HOUSEHOLD#hh#ACTIVITY',
              SK: 'EVENT#1',
              entityType: 'ActivityEvent',
              actorId: 'u1',
            },
            {
              PK: 'HOUSEHOLD#hh#PLANT#p1',
              SK: 'COMPLETION#1',
              entityType: 'TaskCompletion',
              completedBy: 'u1',
            },
          ],
        } as never;
      }
      if (command.input.KeyConditionExpression?.includes('begins_with')) {
        return {
          Items: [
            {
              PK: 'HOUSEHOLD#hh#PLANT#p1',
              SK: 'PHOTO#1',
              entityType: 'PlantPhoto',
              uploadedBy: 'u1',
            },
          ],
        } as never;
      }
      return {
        Items: [
          {
            PK: 'HOUSEHOLD#hh',
            SK: 'PLANT#p1',
            entityType: 'Plant',
            id: 'p1',
          },
          {
            PK: 'HOUSEHOLD#hh',
            SK: 'TASK#t1',
            entityType: 'Task',
            createdBy: 'u1',
            assignedTo: 'u1',
          },
          {
            PK: 'HOUSEHOLD#hh',
            SK: 'VACATION#u2',
            entityType: 'VacationWindow',
            userId: 'u2',
            coveredBy: 'u1',
          },
          {
            PK: 'HOUSEHOLD#hh',
            SK: 'SPACE#s1',
            entityType: 'PlantSpace',
            defaultCaregiverId: 'u1',
          },
        ],
      } as never;
    });

    const { anonymizeUserInHousehold } = await import('../../../src/services/accountCleanup.js');
    await anonymizeUserInHousehold('hh', 'u1');

    const updates = vi
      .mocked(dynamodb.send)
      .mock.calls.map((call) => call[0] as unknown as { kind: string; input: Record<string, any> })
      .filter((command) => command.kind === 'Update');
    expect(updates).toHaveLength(6);
    const taskUpdate = updates.find((update) => update.input.Key?.SK === 'TASK#t1');
    expect(taskUpdate?.input.UpdateExpression).toContain('#createdBy = :deletedId');
    expect(taskUpdate?.input.UpdateExpression).toContain('#assignedTo = :null');
    expect(taskUpdate?.input.UpdateExpression).toContain('#assignmentSource = :null');
    expect(taskUpdate?.input.UpdateExpression).toContain('REMOVE GSI2PK, GSI2SK');
    const spaceUpdate = updates.find((update) => update.input.Key?.SK === 'SPACE#s1');
    expect(spaceUpdate?.input.UpdateExpression).toContain('#defaultCaregiverId = :null');
    const photoUpdate = updates.find((update) => update.input.Key?.SK === 'PHOTO#1');
    expect(photoUpdate?.input.UpdateExpression).toBe('SET #uploadedBy = :deletedId');
    const sitterUpdate = updates.find((update) => update.input.Key?.PK === 'SITTER#secret');
    expect(sitterUpdate?.input.UpdateExpression).toBe('SET #createdBy = :deletedId');
    const activityUpdate = updates.find((update) => update.input.Key?.SK === 'EVENT#1');
    expect(activityUpdate?.input.ExpressionAttributeValues).toMatchObject({
      ':deletedId': 'deleted-user',
      ':deletedName': 'Former member',
    });
    const completionUpdate = updates.find((update) => update.input.Key?.SK === 'COMPLETION#1');
    expect(completionUpdate?.input.ExpressionAttributeValues).toMatchObject({
      ':deletedId': 'deleted-user',
      ':deletedName': 'Former member',
    });
    const deletes = vi
      .mocked(dynamodb.send)
      .mock.calls.map((call) => call[0] as unknown as { kind: string; input: Record<string, any> })
      .filter((command) => command.kind === 'Delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].input.Key).toEqual({ PK: 'HOUSEHOLD#hh', SK: 'VACATION#u2' });
  });

  it('deletes every page of the user partition, including notification markers', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    let queryPage = 0;
    vi.mocked(dynamodb.send).mockImplementation(async (raw) => {
      const command = raw as unknown as { kind: string };
      if (command.kind !== 'Query') return {} as never;
      queryPage += 1;
      return (
        queryPage === 1
          ? {
              Items: [
                { PK: 'USER#u1', SK: 'PREFS' },
                { PK: 'USER#u1', SK: 'WELCOME#FIRST_HOUSEHOLD' },
              ],
              LastEvaluatedKey: { PK: 'USER#u1', SK: 'WELCOME#FIRST_HOUSEHOLD' },
            }
          : {
              Items: [{ PK: 'USER#u1', SK: 'DIGEST#2026-W30#HOUSEHOLD#hh' }],
            }
      ) as never;
    });

    const { deleteUserScopedData } = await import('../../../src/services/accountCleanup.js');
    await deleteUserScopedData('u1');

    const commands = vi.mocked(dynamodb.send).mock.calls.map(
      ([command]) =>
        command as unknown as {
          kind: string;
          input: {
            ExclusiveStartKey?: Record<string, string>;
            Key?: Record<string, string>;
            ProjectionExpression?: string;
          };
        }
    );
    const queries = commands.filter((command) => command.kind === 'Query');
    expect(queries).toHaveLength(2);
    expect(queries[0].input.ProjectionExpression).toBe('PK, SK');
    expect(queries[1].input.ExclusiveStartKey).toEqual({
      PK: 'USER#u1',
      SK: 'WELCOME#FIRST_HOUSEHOLD',
    });
    expect(
      commands.filter((command) => command.kind === 'Delete').map((command) => command.input.Key)
    ).toEqual([
      { PK: 'USER#u1', SK: 'PREFS' },
      { PK: 'USER#u1', SK: 'WELCOME#FIRST_HOUSEHOLD' },
      { PK: 'USER#u1', SK: 'DIGEST#2026-W30#HOUSEHOLD#hh' },
    ]);
  });

  it('deletes sitter + kiosk credentials, plant tags, and every abandoned-household partition row', async () => {
    const { dynamodb } = await import('../../../src/utils/dynamodb.js');
    vi.mocked(dynamodb.send).mockImplementation(async (raw) => {
      const command = raw as unknown as {
        kind: string;
        input: { IndexName?: string; ExpressionAttributeValues?: Record<string, string> };
      };
      if (command.kind !== 'Query') return {} as never;
      const pk = command.input.ExpressionAttributeValues?.[':pk'];
      if (command.input.IndexName === 'GSI1') {
        // Every secret-token partition is swept: sitter links, the
        // never-expiring kiosk (wall display) link, and plant tags.
        return {
          Items:
            pk === 'HOUSEHOLD#hh#KIOSK'
              ? [{ PK: 'KIOSK#secret', SK: 'METADATA' }]
              : pk === 'HOUSEHOLD#hh#PLANTTAG'
                ? [{ PK: 'PLANTTAG#secret', SK: 'METADATA' }]
                : [{ PK: 'SITTER#secret', SK: 'METADATA' }],
        } as never;
      }
      if (pk === 'HOUSEHOLD#hh#ACTIVITY') {
        return {
          Items: [{ PK: 'HOUSEHOLD#hh#ACTIVITY', SK: 'EVENT#1' }],
        } as never;
      }
      return {
        Items: [
          { PK: 'HOUSEHOLD#hh', SK: 'METADATA' },
          { PK: 'HOUSEHOLD#hh', SK: 'SPACE#s1' },
          { PK: 'HOUSEHOLD#hh', SK: 'TASK#t1' },
          { PK: 'HOUSEHOLD#hh', SK: 'MEMBER#u1' },
        ],
      } as never;
    });

    const { deleteAbandonedHouseholdData } =
      await import('../../../src/services/accountCleanup.js');
    await deleteAbandonedHouseholdData('hh');

    const commands = vi.mocked(dynamodb.send).mock.calls.map(
      ([command]) =>
        command as unknown as {
          kind: string;
          input: {
            IndexName?: string;
            ProjectionExpression?: string;
            Key?: Record<string, string>;
          };
        }
    );
    // Five partitions: sitter links, the kiosk link, plant tags, activity, and
    // the base household partition. Credentials that live outside the
    // household's own partition are exactly the rows a partition-only sweep
    // would leave usable.
    expect(commands.filter((command) => command.kind === 'Query')).toHaveLength(5);
    expect(
      commands.filter((command) => command.kind === 'Delete').map((command) => command.input.Key)
    ).toEqual(
      expect.arrayContaining([
        { PK: 'SITTER#secret', SK: 'METADATA' },
        { PK: 'KIOSK#secret', SK: 'METADATA' },
        { PK: 'PLANTTAG#secret', SK: 'METADATA' },
        { PK: 'HOUSEHOLD#hh#ACTIVITY', SK: 'EVENT#1' },
        { PK: 'HOUSEHOLD#hh', SK: 'METADATA' },
        { PK: 'HOUSEHOLD#hh', SK: 'SPACE#s1' },
        { PK: 'HOUSEHOLD#hh', SK: 'TASK#t1' },
        { PK: 'HOUSEHOLD#hh', SK: 'MEMBER#u1' },
      ])
    );
    expect(commands.filter((command) => command.kind === 'Delete').at(-1)?.input.Key).toEqual({
      PK: 'HOUSEHOLD#hh',
      SK: 'MEMBER#u1',
    });
    expect(
      commands
        .filter((command) => command.kind === 'Query')
        .every((command) => command.input.ProjectionExpression === 'PK, SK')
    ).toBe(true);
  });
});

describe('cancelAbandonedHouseholdSubscription', () => {
  beforeEach(() => vi.clearAllMocks());

  function stripeError(message: string, code?: string): Error {
    return Object.assign(new Error(message), code ? { code, statusCode: 404 } : {});
  }

  async function arrange(subscription: HouseholdSubscription) {
    const billing = await import('../../../src/services/billing.js');
    const stripe = { subscriptions: { cancel: vi.fn(), retrieve: vi.fn() } };
    vi.mocked(billing.getHouseholdSubscription).mockResolvedValue(subscription);
    vi.mocked(billing.getStripe).mockResolvedValue(stripe as unknown as Stripe);
    const { cancelAbandonedHouseholdSubscription } =
      await import('../../../src/services/accountCleanup.js');
    return { billing, stripe, cancel: cancelAbandonedHouseholdSubscription };
  }

  it('does nothing when there is no subscription on file (free tier or lifetime purchase)', async () => {
    // A lifetime purchase clears stripeSubscriptionId by design: it is a
    // one-time charge, so there is nothing recurring to stop.
    const { billing, stripe, cancel } = await arrange({
      planId: 'garden',
      lifetimePlanId: 'garden',
    });

    await expect(cancel('hh')).resolves.toEqual({ outcome: 'no_subscription' });
    expect(billing.getStripe).not.toHaveBeenCalled();
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it('cancels a live subscription immediately under a stable idempotency key', async () => {
    const { stripe, cancel } = await arrange({
      planId: 'garden',
      stripeSubscriptionId: 'sub_1',
      status: 'active',
    });
    stripe.subscriptions.cancel.mockResolvedValue({ id: 'sub_1', status: 'canceled' });

    await expect(cancel('hh')).resolves.toEqual({ outcome: 'canceled', subscriptionId: 'sub_1' });
    // The key is derived from the household + subscription, not the request,
    // so a retried deletion replays Stripe's original result instead of
    // issuing a second cancellation.
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith(
      'sub_1',
      {},
      { idempotencyKey: 'account-deletion-cancel:hh:sub_1' }
    );
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('goes to Stripe even when the stored status already says canceled', async () => {
    // billing.ts documents a window in which a freshly checked-out
    // subscription id sits next to a stale `canceled` status until the
    // subscription.created webhook lands. Trusting the stored status there
    // would skip cancelling a live subscription — Stripe is the authority.
    const { stripe, cancel } = await arrange({
      planId: 'garden',
      stripeSubscriptionId: 'sub_new',
      status: 'canceled',
    });
    stripe.subscriptions.cancel.mockResolvedValue({});

    await expect(cancel('hh')).resolves.toEqual({
      outcome: 'canceled',
      subscriptionId: 'sub_new',
    });
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
  });

  it('treats an already-cancelled subscription as success (retry after a partial failure)', async () => {
    const { stripe, cancel } = await arrange({
      planId: 'garden',
      stripeSubscriptionId: 'sub_1',
      status: 'active',
    });
    stripe.subscriptions.cancel.mockRejectedValue(
      stripeError('No such subscription: sub_1', 'resource_missing')
    );
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', status: 'canceled' });

    await expect(cancel('hh')).resolves.toEqual({
      outcome: 'already_canceled',
      subscriptionId: 'sub_1',
    });
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_1');
  });

  it('treats a subscription Stripe no longer has as nothing left to bill', async () => {
    const { stripe, cancel } = await arrange({
      planId: 'garden',
      stripeSubscriptionId: 'sub_gone',
      status: 'active',
    });
    stripe.subscriptions.cancel.mockRejectedValue(
      stripeError('No such subscription: sub_gone', 'resource_missing')
    );
    stripe.subscriptions.retrieve.mockRejectedValue(
      stripeError('No such subscription: sub_gone', 'resource_missing')
    );

    await expect(cancel('hh')).resolves.toEqual({
      outcome: 'missing_in_stripe',
      subscriptionId: 'sub_gone',
    });
  });

  it('rethrows the original failure when Stripe still reports the subscription live', async () => {
    // Fail closed: the caller refuses the deletion rather than leaving a
    // user who can no longer log in on a subscription that still bills.
    const { stripe, cancel } = await arrange({
      planId: 'garden',
      stripeSubscriptionId: 'sub_1',
      status: 'active',
    });
    const failure = stripeError('Stripe is down');
    stripe.subscriptions.cancel.mockRejectedValue(failure);
    stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_1', status: 'active' });

    await expect(cancel('hh')).rejects.toBe(failure);
  });

  it('rethrows the original failure when the outcome cannot be confirmed either way', async () => {
    const { stripe, cancel } = await arrange({
      planId: 'garden',
      stripeSubscriptionId: 'sub_1',
      status: 'active',
    });
    const failure = stripeError('Stripe is down');
    stripe.subscriptions.cancel.mockRejectedValue(failure);
    stripe.subscriptions.retrieve.mockRejectedValue(stripeError('socket hang up'));

    await expect(cancel('hh')).rejects.toBe(failure);
  });
});
