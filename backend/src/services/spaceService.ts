/** Household-scoped CRUD for the simple places plants currently live. */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';
import type { PlantSpace, SpaceRotation } from '../models/types.js';
import type { CreateSpaceInput, SpaceRotationInput, UpdateSpaceInput } from '../models/schemas.js';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { getMemberByUserId } from './householdService.js';
import { resolveInheritedAssignee, type AssignmentContext } from './assignmentResolver.js';

/**
 * Page size for the space listing. A transport detail, NOT a cap: `getSpaces`
 * follows `LastEvaluatedKey` to exhaustion, so this only decides how many
 * round trips a household's rooms take.
 *
 * It was previously spelled `MAX_SPACES` and used as a bare `Limit` with no
 * paging, which read as a cap and behaved as a silent truncation — nothing
 * anywhere enforced it on create. Past 100 spaces the consequences compounded
 * quietly: `assertUniqueName` reads through this function, so duplicate names
 * became creatable; `sitterBrief` builds its `spaceNames` map from it, so a
 * plant in an unseen room told the sitter it had no location; and `moveDay`
 * builds its `outdoor` set from it, dropping frost-tender plants by a second
 * independent route. None of those is a failed read — the read succeeded and
 * returned part of the answer as though it were all of it.
 */
const SPACE_PAGE_SIZE = 100;

function itemToSpace(item: Record<string, unknown>): PlantSpace {
  const environment = item.environment as PlantSpace['environment'];
  return {
    id: item.id as string,
    householdId: item.householdId as string,
    name: item.name as string,
    environment,
    rainExposure:
      (item.rainExposure as PlantSpace['rainExposure'] | undefined) ??
      (environment === 'outside' ? 'exposed' : 'sheltered'),
    lightLevel: (item.lightLevel as PlantSpace['lightLevel'] | undefined) ?? null,
    petAccess: (item.petAccess as boolean | undefined) ?? null,
    defaultCaregiverId: (item.defaultCaregiverId as string | undefined) ?? null,
    rotation: itemToRotation(item.rotation),
    createdAt: item.createdAt as string,
    createdBy: item.createdBy as string,
    updatedAt: item.updatedAt as string,
  };
}

/**
 * Persistence boundary: a stored rotation is only honoured when it still has
 * the shape the resolver needs. A half-written or legacy row reads as "no
 * rotation" rather than as a rotation with one member (which would silently
 * pin every task on one person and still be labelled a rotation).
 */
function itemToRotation(raw: unknown): SpaceRotation | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<SpaceRotation>;
  const memberIds = Array.isArray(value.memberIds)
    ? value.memberIds.filter((id): id is string => typeof id === 'string')
    : [];
  if (memberIds.length < 2) return null;
  if (value.cadence !== 'weekly' && value.cadence !== 'monthly') return null;
  if (typeof value.anchor !== 'string' || Number.isNaN(Date.parse(value.anchor))) return null;
  return { memberIds, cadence: value.cadence, anchor: value.anchor };
}

export class DuplicateSpaceNameError extends Error {
  constructor() {
    super('A space with that name already exists');
    this.name = 'DuplicateSpaceNameError';
  }
}

export class DefaultCaregiverNotMemberError extends Error {
  constructor() {
    super('defaultCaregiverId must be a current household member');
    this.name = 'DefaultCaregiverNotMemberError';
  }
}

async function assertDefaultCaregiver(
  householdId: string,
  defaultCaregiverId: string | null | undefined
): Promise<void> {
  if (!defaultCaregiverId) return;
  if (!(await getMemberByUserId(householdId, defaultCaregiverId))) {
    throw new DefaultCaregiverNotMemberError();
  }
}

export class RotationMemberNotMemberError extends Error {
  constructor() {
    super('rotation.memberIds must all be current household members');
    this.name = 'RotationMemberNotMemberError';
  }
}

/**
 * Validate a submitted rotation and stamp its anchor. Every member must be a
 * current member: a rotation containing someone who has left would silently
 * skip a turn forever, which reads as a bug in the rotation rather than as
 * stale configuration.
 */
async function resolveRotation(
  householdId: string,
  input: SpaceRotationInput | null | undefined,
  existing: SpaceRotation | null
): Promise<SpaceRotation | null | undefined> {
  if (input === undefined) return undefined; // field not being changed
  if (input === null) return null; // rotation cleared
  const members = await Promise.all(
    input.memberIds.map((id) => getMemberByUserId(householdId, id))
  );
  if (members.some((member) => !member)) throw new RotationMemberNotMemberError();
  return {
    memberIds: input.memberIds,
    cadence: input.cadence,
    // Keep the existing anchor when the cadence is unchanged, so editing the
    // member list does not silently restart the cycle at whoever is first.
    anchor:
      input.anchor ??
      (existing && existing.cadence === input.cadence ? existing.anchor : new Date().toISOString()),
  };
}

async function assertUniqueName(
  householdId: string,
  name: string,
  exceptId?: string
): Promise<void> {
  const normalized = name.trim().toLocaleLowerCase();
  const spaces = await getSpaces(householdId);
  if (
    spaces.some((space) => space.id !== exceptId && space.name.toLocaleLowerCase() === normalized)
  ) {
    throw new DuplicateSpaceNameError();
  }
}

export async function getSpaces(householdId: string): Promise<PlantSpace[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `HOUSEHOLD#${householdId}`,
          ':sk': 'SPACE#',
        },
        Limit: SPACE_PAGE_SIZE,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return items.map((item) => itemToSpace(item)).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSpace(householdId: string, id: string): Promise<PlantSpace | null> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `HOUSEHOLD#${householdId}`, SK: `SPACE#${id}` },
    })
  );
  return result.Item ? itemToSpace(result.Item as Record<string, unknown>) : null;
}

export async function createSpace(
  input: CreateSpaceInput,
  householdId: string,
  userId: string
): Promise<PlantSpace> {
  await assertDefaultCaregiver(householdId, input.defaultCaregiverId);
  const rotation = (await resolveRotation(householdId, input.rotation, null)) ?? null;
  await assertUniqueName(householdId, input.name);
  const now = new Date().toISOString();
  const space: PlantSpace = {
    id: uuid(),
    householdId,
    name: input.name.trim(),
    environment: input.environment,
    rainExposure: input.environment === 'outside' ? (input.rainExposure ?? 'exposed') : 'sheltered',
    lightLevel: input.lightLevel ?? null,
    petAccess: input.petAccess ?? null,
    defaultCaregiverId: input.defaultCaregiverId ?? null,
    rotation,
    createdAt: now,
    createdBy: userId,
    updatedAt: now,
  };
  await dynamodb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: `SPACE#${space.id}`,
        entityType: 'PlantSpace',
        ...space,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    })
  );
  return space;
}

export async function updateSpace(
  householdId: string,
  id: string,
  input: UpdateSpaceInput
): Promise<PlantSpace | null> {
  await assertDefaultCaregiver(householdId, input.defaultCaregiverId);
  const rotation = await resolveRotation(
    householdId,
    input.rotation,
    input.rotation ? ((await getSpace(householdId, id))?.rotation ?? null) : null
  );
  if (input.name !== undefined) await assertUniqueName(householdId, input.name, id);
  const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':updatedAt': new Date().toISOString() };
  const updates = ['#updatedAt = :updatedAt'];
  if (input.name !== undefined) {
    names['#name'] = 'name';
    values[':name'] = input.name.trim();
    updates.push('#name = :name');
  }
  if (input.environment !== undefined) {
    names['#environment'] = 'environment';
    values[':environment'] = input.environment;
    updates.push('#environment = :environment');
  }
  const rainExposure =
    input.environment === 'inside'
      ? 'sheltered'
      : (input.rainExposure ?? (input.environment === 'outside' ? 'exposed' : undefined));
  if (rainExposure !== undefined) {
    names['#rainExposure'] = 'rainExposure';
    values[':rainExposure'] = rainExposure;
    updates.push('#rainExposure = :rainExposure');
  }
  if (input.lightLevel !== undefined) {
    names['#lightLevel'] = 'lightLevel';
    values[':lightLevel'] = input.lightLevel;
    updates.push('#lightLevel = :lightLevel');
  }
  if (input.petAccess !== undefined) {
    names['#petAccess'] = 'petAccess';
    values[':petAccess'] = input.petAccess;
    updates.push('#petAccess = :petAccess');
  }
  if (input.defaultCaregiverId !== undefined) {
    names['#defaultCaregiverId'] = 'defaultCaregiverId';
    values[':defaultCaregiverId'] = input.defaultCaregiverId;
    updates.push('#defaultCaregiverId = :defaultCaregiverId');
  }
  if (rotation !== undefined) {
    names['#rotation'] = 'rotation';
    values[':rotation'] = rotation;
    updates.push('#rotation = :rotation');
  }
  try {
    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${householdId}`, SK: `SPACE#${id}` },
        UpdateExpression: `SET ${updates.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(PK)',
        ReturnValues: 'ALL_NEW',
      })
    );
    return result.Attributes ? itemToSpace(result.Attributes as Record<string, unknown>) : null;
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

export async function deleteSpace(householdId: string, id: string): Promise<boolean> {
  const existing = await getSpace(householdId, id);
  if (!existing) return false;
  await dynamodb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { PK: `HOUSEHOLD#${householdId}`, SK: `SPACE#${id}` },
    })
  );
  return true;
}

/**
 * "Whose turn" for every space that has a rotation, derived server-side so the
 * UI never re-implements the period maths (and cannot disagree with what the
 * next occurrence will actually be assigned to).
 *
 * `turnUserId: null` on a space that HAS a rotation is a real answer —
 * everyone in the rotation is away — and is rendered as such, not as "no
 * rotation". Spaces without a rotation are simply absent from the map.
 */
export function rotationTurns(
  spaces: readonly PlantSpace[],
  ctx: AssignmentContext,
  now: Date = new Date()
): Map<string, { turnUserId: string | null; turnName: string | null }> {
  const turns = new Map<string, { turnUserId: string | null; turnName: string | null }>();
  for (const space of spaces) {
    if (!space.rotation) continue;
    const inherited = resolveInheritedAssignee(space, ctx, now);
    turns.set(space.id, { turnUserId: inherited.userId, turnName: inherited.name });
  }
  return turns;
}
