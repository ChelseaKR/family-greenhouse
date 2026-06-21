/**
 * DynamoDB-backed operations for households, members, and invites.
 *
 * Household creation is wrapped in a TransactWrite so the household row + the
 * admin-member row land atomically — without that, a partial failure would
 * leave a household with no admin and lock everyone out.
 *
 * Invites carry a `ttl` attribute so DynamoDB TTL eventually sweeps expired
 * rows; the read path also filters expired rows defensively.
 */
import {
  PutCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  DeleteCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { invalidateMembership } from '../utils/membershipCache.js';
import { Household, HouseholdMember, HouseholdInvite, DynamoDBItem } from '../models/types.js';
import { CreateHouseholdInput } from '../models/schemas.js';

/**
 * Raised when a write would exceed the household's plan cap. Handlers map
 * this to the existing 402 upgrade response. Call sites check `err.name ===
 * 'PlanLimitError'` (not instanceof) so test automocks of this module stay
 * compatible.
 */
export class PlanLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanLimitError';
  }
}

/**
 * Raised when a role change or removal would leave a multi-member household
 * with no admin (the lone admin demoting/removing themselves). The handlers
 * already enforce this on the self-demotion / account-deletion paths, but
 * keeping the invariant in the service layer too means a future handler that
 * forgets the check can't lock a household out of admin. Call sites check
 * `err.name === 'LastAdminError'` (not instanceof) — same convention as
 * PlanLimitError.
 */
export class LastAdminError extends Error {
  constructor(message = 'Cannot remove the last admin of a household with other members') {
    super(message);
    this.name = 'LastAdminError';
  }
}

/**
 * Resolve the last-admin guard for demoting/removing `userId`.
 *
 * Throws LastAdminError if `userId` is the sole admin of a multi-member
 * household (a single-member household is exempt — that's the account-deletion
 * / leave path). Otherwise returns the userId of ANOTHER admin to PIN via a
 * transaction ConditionCheck (`guardAdminId`), or null when no guard is needed
 * (solo household, or the target isn't an admin so the operation can't reduce
 * the admin count).
 *
 * The read-only check alone is a TOCTOU: two admins demoting/removing each
 * other concurrently both pass the read, then both writes land and the
 * household drops to zero admins. Pinning a surviving admin's role='admin'
 * inside the write transaction closes that — the second to commit is cancelled
 * (→ LastAdminError) instead of leaving the household admin-less. For 3+ admins
 * a concurrent multi-demote can spuriously fail the pin; that is the safe
 * direction (a retry re-reads and picks another surviving admin).
 */
async function resolveLastAdminGuard(
  householdId: string,
  userId: string
): Promise<{ members: HouseholdMember[]; guardAdminId: string | null }> {
  const members = await getHouseholdMembers(householdId);
  if (members.length <= 1) return { members, guardAdminId: null };
  const admins = members.filter((m) => m.role === 'admin');
  if (!admins.some((m) => m.userId === userId)) return { members, guardAdminId: null };
  const otherAdmins = admins.filter((m) => m.userId !== userId);
  if (otherAdmins.length === 0) throw new LastAdminError();
  return { members, guardAdminId: otherAdmins[0].userId };
}

/** Transaction item that asserts `guardAdminId` is still an admin at commit. */
function survivingAdminConditionCheck(householdId: string, guardAdminId: string) {
  return {
    ConditionCheck: {
      TableName: TABLE_NAME,
      Key: { PK: `HOUSEHOLD#${householdId}`, SK: `MEMBER#${guardAdminId}` },
      ConditionExpression: '#role = :admin',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':admin': 'admin' },
    },
  };
}

/**
 * Pull the per-item CancellationReasons off a TransactWriteCommand failure.
 * Returns [] for anything that isn't a TransactionCanceledException, so
 * callers can index into it safely.
 */
function transactCancellationReasons(err: unknown): Array<{ Code?: string }> {
  if (err instanceof Error && err.name === 'TransactionCanceledException') {
    return (err as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
  }
  return [];
}

export async function createHousehold(
  input: CreateHouseholdInput,
  userId: string,
  userName: string,
  userEmail: string
): Promise<Household> {
  const id = uuid();
  const now = new Date().toISOString();

  const household: Household = {
    id,
    name: input.name,
    createdAt: now,
    createdBy: userId,
  };

  const householdItem: DynamoDBItem = {
    PK: `HOUSEHOLD#${id}`,
    SK: 'METADATA',
    entityType: 'Household',
    ...household,
    // Atomic plan-cap counters (see addMember / plantService.createPlant).
    // The creator is the first member; no plants yet. Legacy rows created
    // before these existed are backfilled lazily via if_not_exists().
    memberCount: 1,
    plantCount: 0,
  };

  const memberItem: DynamoDBItem = {
    PK: `HOUSEHOLD#${id}`,
    SK: `MEMBER#${userId}`,
    GSI1PK: `USER#${userId}`,
    GSI1SK: `HOUSEHOLD#${id}`,
    entityType: 'HouseholdMember',
    householdId: id,
    userId,
    name: userName,
    email: userEmail,
    role: 'admin',
    joinedAt: now,
  };

  await dynamodb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE_NAME, Item: householdItem } },
        { Put: { TableName: TABLE_NAME, Item: memberItem } },
      ],
    })
  );

  return household;
}

export async function setMemberRole(
  householdId: string,
  userId: string,
  role: 'admin' | 'member'
): Promise<HouseholdMember | null> {
  // Service-layer last-admin guard (L1): demoting the lone admin of a
  // multi-member household would lock it out of admin entirely. Only a
  // demotion can reduce the admin count.
  const guard = role === 'member' ? await resolveLastAdminGuard(householdId, userId) : null;

  const updateTarget = {
    TableName: TABLE_NAME,
    Key: { PK: `HOUSEHOLD#${householdId}`, SK: `MEMBER#${userId}` },
    UpdateExpression: 'SET #role = :role',
    ExpressionAttributeNames: { '#role': 'role' },
    ExpressionAttributeValues: { ':role': role },
    ConditionExpression: 'attribute_exists(PK)',
  };

  if (guard?.guardAdminId) {
    // Atomic demote: pin a surviving admin so a concurrent demote of THAT
    // admin can't slip the household to zero admins (TransactWrite has no
    // ReturnValues, so the updated member is rebuilt from the pre-read).
    try {
      await dynamodb.send(
        new TransactWriteCommand({
          TransactItems: [
            { Update: updateTarget },
            survivingAdminConditionCheck(householdId, guard.guardAdminId),
          ],
        })
      );
    } catch (err) {
      if (transactCancellationReasons(err).some((r) => r?.Code === 'ConditionalCheckFailed')) {
        throw new LastAdminError();
      }
      throw err;
    }
    invalidateMembership(userId, householdId);
    const target = guard.members.find((m) => m.userId === userId);
    return target ? { ...target, role } : null;
  }

  const result = await dynamodb.send(
    new UpdateCommand({ ...updateTarget, ReturnValues: 'ALL_NEW' })
  );

  if (!result.Attributes) return null;
  // Drop the cached membership so authMiddleware re-reads the new role on
  // the next request from this user instead of waiting out the TTL.
  invalidateMembership(userId, householdId);
  return {
    householdId: result.Attributes.householdId as string,
    userId: result.Attributes.userId as string,
    name: result.Attributes.name as string,
    email: result.Attributes.email as string,
    role: result.Attributes.role as 'admin' | 'member',
    joinedAt: result.Attributes.joinedAt as string,
  };
}

export async function getHousehold(householdId: string): Promise<Household | null> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: 'METADATA',
      },
    })
  );

  if (!result.Item) {
    return null;
  }

  return {
    id: result.Item.id as string,
    name: result.Item.name as string,
    location: (result.Item.location as Household['location']) ?? null,
    createdAt: result.Item.createdAt as string,
    createdBy: result.Item.createdBy as string,
  };
}

export async function setHouseholdLocation(
  householdId: string,
  location: NonNullable<Household['location']> | null
): Promise<Household | null> {
  const result = await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
      UpdateExpression: 'SET #location = :location',
      ExpressionAttributeNames: { '#location': 'location' },
      ExpressionAttributeValues: { ':location': location },
      ReturnValues: 'ALL_NEW',
      ConditionExpression: 'attribute_exists(PK)',
    })
  );
  if (!result.Attributes) return null;
  return {
    id: result.Attributes.id as string,
    name: result.Attributes.name as string,
    location: (result.Attributes.location as Household['location']) ?? null,
    createdAt: result.Attributes.createdAt as string,
    createdBy: result.Attributes.createdBy as string,
  };
}

/**
 * Enumerate every household id. Used by the hourly reminder scan
 * (`services/reminders.ts`), which has no single household to scope to.
 *
 * Implemented as a paginated full-table scan filtered to household-metadata
 * rows. That's fine at beta scale; the documented "what does this cost at
 * 1,000 households?" answer is "one scan/hour" — cheap. If household counts
 * grow into the tens of thousands, the scale fix is a sparse-GSI directory:
 * write a constant GSI partition key (e.g. GSI1PK = 'HOUSEHOLD_DIRECTORY')
 * onto Household metadata rows only, so this becomes one bounded Query
 * instead of a full-table Scan. Deliberately not done in this pass — it's a
 * schema change requiring a backfill.
 */
export async function listAllHouseholdIds(): Promise<string[]> {
  const ids: string[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamodb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'entityType = :t',
        ExpressionAttributeValues: { ':t': 'Household' },
        ProjectionExpression: 'id',
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    for (const item of result.Items ?? []) {
      if (typeof item.id === 'string') ids.push(item.id);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return ids;
}

export async function getHouseholdMembers(householdId: string): Promise<HouseholdMember[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}`,
        ':sk': 'MEMBER#',
      },
      Limit: 100,
    })
  );

  return (result.Items || []).map((item) => ({
    householdId: item.householdId as string,
    userId: item.userId as string,
    name: item.name as string,
    email: item.email as string,
    role: item.role as 'admin' | 'member',
    joinedAt: item.joinedAt as string,
  }));
}

export async function createInvite(householdId: string, userId: string): Promise<HouseholdInvite> {
  // 32 hex chars (128 bits). Pre-2026-05-31 this was 12 chars (~48 bits),
  // brute-forceable from a leaked DDB dump or log line. UUIDv4 collisions
  // at this length are cosmologically unlikely; the partition key collision
  // probability stays well below DDB's birthday-paradox threshold.
  const code = uuid().replace(/-/g, '');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const invite: HouseholdInvite = {
    code,
    householdId,
    createdBy: userId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  const item: DynamoDBItem = {
    PK: `INVITE#${code}`,
    SK: 'METADATA',
    entityType: 'HouseholdInvite',
    ...invite,
    ttl: Math.floor(expiresAt.getTime() / 1000),
  };

  await dynamodb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  return invite;
}

export async function getInvite(code: string): Promise<HouseholdInvite | null> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `INVITE#${code}`,
        SK: 'METADATA',
      },
    })
  );

  if (!result.Item) {
    return null;
  }

  const invite: HouseholdInvite = {
    code: result.Item.code as string,
    householdId: result.Item.householdId as string,
    createdBy: result.Item.createdBy as string,
    createdAt: result.Item.createdAt as string,
    expiresAt: result.Item.expiresAt as string,
  };

  // Check if expired
  if (new Date(invite.expiresAt) < new Date()) {
    return null;
  }

  return invite;
}

/**
 * Insert a member row, atomically enforcing the plan's member cap.
 *
 * The member Put stays conditioned on the row not existing (an unconditional
 * Put let a racing double-join silently overwrite an existing row, e.g.
 * resetting an admin back to 'member' and clobbering joinedAt). It now rides
 * in a TransactWriteCommand with a conditional increment of `memberCount` on
 * the household METADATA row, so two concurrent joins can never both slip
 * under `maxMembers` (the old check-then-write race).
 *
 * Backfill: legacy METADATA rows predate the counter. We read METADATA once;
 * when `memberCount` is absent we count the member rows and seed the counter
 * via `if_not_exists(memberCount, :base)` inside the same transaction (same
 * design as plantService.createPlant — see the comment there).
 *
 * Failure mapping (via per-item CancellationReasons):
 *   - item 0 (member Put) failed   → rethrown with name
 *     'ConditionalCheckFailedException' so existing callers keep mapping it
 *     to the friendly "already a member" 400.
 *   - item 1 (counter) failed      → PlanLimitError (callers map to 402).
 */
export async function addMember(
  householdId: string,
  userId: string,
  userName: string,
  userEmail: string,
  maxMembers: number,
  role: 'admin' | 'member' = 'member'
): Promise<HouseholdMember> {
  const now = new Date().toISOString();

  const member: HouseholdMember = {
    householdId,
    userId,
    name: userName,
    email: userEmail,
    role,
    joinedAt: now,
  };

  const item: DynamoDBItem = {
    PK: `HOUSEHOLD#${householdId}`,
    SK: `MEMBER#${userId}`,
    GSI1PK: `USER#${userId}`,
    GSI1SK: `HOUSEHOLD#${householdId}`,
    entityType: 'HouseholdMember',
    ...member,
  };

  const meta = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
    })
  );
  if (!meta.Item) {
    throw new Error(`Household ${householdId} not found`);
  }
  let base = 0;
  if (typeof meta.Item.memberCount !== 'number') {
    const members = await getHouseholdMembers(householdId);
    base = members.length;
    if (base >= maxMembers) {
      throw new PlanLimitError(`Member limit of ${maxMembers} reached`);
    }
  }

  try {
    await dynamodb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE_NAME,
              Item: item,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
              UpdateExpression: 'SET memberCount = if_not_exists(memberCount, :base) + :one',
              ConditionExpression:
                'attribute_exists(PK) AND (attribute_not_exists(memberCount) OR memberCount < :max)',
              ExpressionAttributeValues: { ':base': base, ':one': 1, ':max': maxMembers },
            },
          },
        ],
      })
    );
  } catch (err) {
    const reasons = transactCancellationReasons(err);
    if (reasons[0]?.Code === 'ConditionalCheckFailed') {
      // Duplicate join lost the race on the member row. Checked BEFORE the
      // cap reason so "already a member" (400) wins over the cap 402 when
      // both conditions fail.
      throw Object.assign(new Error('Member already exists'), {
        name: 'ConditionalCheckFailedException',
      });
    }
    if (reasons[1]?.Code === 'ConditionalCheckFailed') {
      throw new PlanLimitError(`Member limit of ${maxMembers} reached`);
    }
    throw err;
  }

  return member;
}

/**
 * Delete a member row and decrement `memberCount` (floored at 0) in one
 * transaction. Failure handling preserves the old idempotent semantics:
 *   - member row already gone → resolve without touching the counter.
 *   - counter already at 0 / METADATA row missing → fall back to a plain
 *     unconditional delete (the member must still be removed; the counter
 *     is already at its floor).
 */
export async function removeMember(householdId: string, userId: string): Promise<void> {
  // Service-layer last-admin guard (L1): removing the lone admin of a
  // multi-member household would lock it out of admin entirely. Solo-member
  // households are exempt (the leave / account-deletion path).
  const guard = await resolveLastAdminGuard(householdId, userId);

  const memberKey = {
    PK: `HOUSEHOLD#${householdId}`,
    SK: `MEMBER#${userId}`,
  };
  const transactItems: object[] = [
    {
      Delete: {
        TableName: TABLE_NAME,
        Key: memberKey,
        ConditionExpression: 'attribute_exists(PK)',
      },
    },
    {
      Update: {
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${householdId}`, SK: 'METADATA' },
        UpdateExpression: 'SET memberCount = if_not_exists(memberCount, :one) - :one',
        ConditionExpression:
          'attribute_exists(PK) AND (attribute_not_exists(memberCount) OR memberCount > :zero)',
        ExpressionAttributeValues: { ':one': 1, ':zero': 0 },
      },
    },
  ];
  // Removing an admin: pin a surviving admin (last item) so a concurrent
  // demote of THAT admin can't drop the household to zero admins.
  const guardIndex = guard.guardAdminId ? transactItems.length : -1;
  if (guard.guardAdminId) {
    transactItems.push(survivingAdminConditionCheck(householdId, guard.guardAdminId));
  }
  try {
    await dynamodb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    const reasons = transactCancellationReasons(err);
    if (reasons.length === 0) {
      throw err; // not a cancellation — propagate
    }
    // The surviving-admin pin failed → removing this admin would leave zero.
    if (guardIndex >= 0 && reasons[guardIndex]?.Code === 'ConditionalCheckFailed') {
      throw new LastAdminError();
    }
    if (reasons[0]?.Code !== 'ConditionalCheckFailed') {
      // Only the counter floor blocked the transaction; the member row still
      // exists and must go.
      await dynamodb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: memberKey }));
    }
    // else: member row already gone — idempotent no-op, counter untouched.
  }
  // Drop the cached membership so the removed user loses access on their
  // very next request instead of at the 60s TTL.
  invalidateMembership(userId, householdId);
}

/**
 * All households the user is a member of. Queries GSI1 with PK = USER#{id};
 * each membership row has GSI1SK = HOUSEHOLD#{householdId}, so the result is
 * a list of (householdId, role) pairs from the user's perspective.
 *
 * This enables multi-household per user: today every user has at most one
 * household via Cognito custom attributes, but the schema has always
 * supported many. The migration story (drop the custom attribute, query
 * here at request time) is documented in architecture.md.
 */
export async function getMembershipsByUser(
  userId: string
): Promise<
  Array<{ householdId: string; role: 'admin' | 'member'; name: string; joinedAt: string }>
> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `USER#${userId}`,
        ':sk': 'HOUSEHOLD#',
      },
      Limit: 25,
    })
  );
  return (result.Items ?? []).map((item) => ({
    householdId: item.householdId as string,
    role: item.role as 'admin' | 'member',
    name: (item.name as string) ?? '',
    joinedAt: (item.joinedAt as string) ?? '',
  }));
}

/**
 * Propagates a name change across every household the user is a member of.
 * Cognito holds the canonical user identity, but each HouseholdMember row
 * stores a denormalized copy so member listings don't need a fan-out read.
 * On rename, those copies have to follow.
 *
 * Activity events and historical task completions intentionally are NOT
 * rewritten — they're snapshots of who-did-what and should reflect the
 * name as it stood at the time.
 */
export async function updateMemberNameAcrossHouseholds(
  userId: string,
  newName: string
): Promise<void> {
  const memberships = await getMembershipsByUser(userId);
  await Promise.all(
    memberships.map((m) =>
      dynamodb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: `HOUSEHOLD#${m.householdId}`,
            SK: `MEMBER#${userId}`,
          },
          UpdateExpression: 'SET #name = :name',
          ExpressionAttributeNames: { '#name': 'name' },
          ExpressionAttributeValues: { ':name': newName },
          ConditionExpression: 'attribute_exists(PK)',
        })
      )
    )
  );
}

export async function getMemberByUserId(
  householdId: string,
  userId: string
): Promise<HouseholdMember | null> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: `MEMBER#${userId}`,
      },
    })
  );

  if (!result.Item) {
    return null;
  }

  return {
    householdId: result.Item.householdId as string,
    userId: result.Item.userId as string,
    name: result.Item.name as string,
    email: result.Item.email as string,
    role: result.Item.role as 'admin' | 'member',
    joinedAt: result.Item.joinedAt as string,
  };
}
