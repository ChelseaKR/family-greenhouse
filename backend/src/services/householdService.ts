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
import { Household, HouseholdMember, HouseholdInvite, DynamoDBItem } from '../models/types.js';
import { CreateHouseholdInput } from '../models/schemas.js';

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
  const result = await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: `MEMBER#${userId}`,
      },
      UpdateExpression: 'SET #role = :role',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':role': role },
      ReturnValues: 'ALL_NEW',
      ConditionExpression: 'attribute_exists(PK)',
    })
  );

  if (!result.Attributes) return null;
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
 * grow into the tens of thousands, move this to a dedicated GSI keyed on a
 * constant partition + householdId so it becomes a bounded Query.
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

export async function addMember(
  householdId: string,
  userId: string,
  userName: string,
  userEmail: string,
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

  await dynamodb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  return member;
}

export async function removeMember(householdId: string, userId: string): Promise<void> {
  await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: `MEMBER#${userId}`,
      },
    })
  );
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
