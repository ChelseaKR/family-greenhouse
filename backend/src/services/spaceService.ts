/** Household-scoped CRUD for the simple places plants currently live. */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';
import type { PlantSpace } from '../models/types.js';
import type { CreateSpaceInput, UpdateSpaceInput } from '../models/schemas.js';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';

const MAX_SPACES = 100;

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
    createdAt: item.createdAt as string,
    createdBy: item.createdBy as string,
    updatedAt: item.updatedAt as string,
  };
}

export class DuplicateSpaceNameError extends Error {
  constructor() {
    super('A space with that name already exists');
    this.name = 'DuplicateSpaceNameError';
  }
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
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}`,
        ':sk': 'SPACE#',
      },
      Limit: MAX_SPACES,
    })
  );
  return (result.Items ?? [])
    .map((item) => itemToSpace(item as Record<string, unknown>))
    .sort((a, b) => a.name.localeCompare(b.name));
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
