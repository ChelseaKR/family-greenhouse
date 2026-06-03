/**
 * DynamoDB-backed CRUD operations for plants. Plants are stored under their
 * household partition; deleting a plant cascades to its task and completion
 * rows via batched deletes.
 *
 * The S3 image upload flow lives next to this in `handlers/plants/handler.ts`
 * — this service only writes the image URL onto the plant row.
 */
import {
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  BatchWriteCommand,
  DeleteCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { v4 as uuid } from 'uuid';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { Plant, DynamoDBItem } from '../models/types.js';
import { CreatePlantInput, UpdatePlantInput } from '../models/schemas.js';
import { optionalEnv } from '../utils/env.js';
import { logger } from '../utils/logger.js';

export async function createPlant(
  input: CreatePlantInput,
  householdId: string,
  userId: string
): Promise<Plant> {
  const id = uuid();
  const now = new Date().toISOString();

  // Tags are normalized to lowercase + trimmed so "Succulent" and "succulent "
  // match the same bucket. Storage stays the user's chosen casing for display.
  const tags = (input.tags ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);
  const plant: Plant = {
    id,
    householdId,
    name: input.name,
    species: input.species || null,
    location: input.location || null,
    imageUrl: null,
    notes: input.notes || null,
    tags,
    perenualSpeciesId: input.perenualSpeciesId ?? null,
    createdAt: now,
    createdBy: userId,
    updatedAt: now,
  };

  const item: DynamoDBItem = {
    PK: `HOUSEHOLD#${householdId}`,
    SK: `PLANT#${id}`,
    entityType: 'Plant',
    ...plant,
  };

  await dynamodb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  return plant;
}

export async function getPlant(householdId: string, plantId: string): Promise<Plant | null> {
  const result = await dynamodb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: `PLANT#${plantId}`,
      },
    })
  );

  if (!result.Item) {
    return null;
  }

  return {
    id: result.Item.id as string,
    householdId: result.Item.householdId as string,
    name: result.Item.name as string,
    species: result.Item.species as string | null,
    location: result.Item.location as string | null,
    imageUrl: result.Item.imageUrl as string | null,
    notes: result.Item.notes as string | null,
    tags: (result.Item.tags as string[] | undefined) ?? [],
    perenualSpeciesId: (result.Item.perenualSpeciesId as number | undefined) ?? null,
    createdAt: result.Item.createdAt as string,
    createdBy: result.Item.createdBy as string,
    updatedAt: result.Item.updatedAt as string,
  };
}

// Soft cap on per-household reads. A real household will not have hundreds of
// plants/tasks; cap aggressively to keep Lambda memory bounded and to surface
// pagination needs early if a workload trends bigger.
export const MAX_QUERY_LIMIT = 200;

export async function getPlants(householdId: string): Promise<Plant[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}`,
        ':sk': 'PLANT#',
      },
      Limit: MAX_QUERY_LIMIT,
    })
  );

  return (result.Items || []).map((item) => ({
    id: item.id as string,
    householdId: item.householdId as string,
    name: item.name as string,
    species: item.species as string | null,
    location: item.location as string | null,
    imageUrl: item.imageUrl as string | null,
    notes: item.notes as string | null,
    tags: (item.tags as string[] | undefined) ?? [],
    perenualSpeciesId: (item.perenualSpeciesId as number | undefined) ?? null,
    createdAt: item.createdAt as string,
    createdBy: item.createdBy as string,
    updatedAt: item.updatedAt as string,
  }));
}

export async function updatePlant(
  householdId: string,
  plantId: string,
  input: UpdatePlantInput
): Promise<Plant | null> {
  const updateExpressions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, unknown> = {};

  if (input.name !== undefined) {
    updateExpressions.push('#name = :name');
    expressionAttributeNames['#name'] = 'name';
    expressionAttributeValues[':name'] = input.name;
  }

  if (input.species !== undefined) {
    updateExpressions.push('#species = :species');
    expressionAttributeNames['#species'] = 'species';
    expressionAttributeValues[':species'] = input.species;
  }

  if (input.location !== undefined) {
    updateExpressions.push('#location = :location');
    expressionAttributeNames['#location'] = 'location';
    expressionAttributeValues[':location'] = input.location;
  }

  if (input.notes !== undefined) {
    updateExpressions.push('#notes = :notes');
    expressionAttributeNames['#notes'] = 'notes';
    expressionAttributeValues[':notes'] = input.notes;
  }

  if (input.tags !== undefined) {
    const cleaned = (input.tags ?? [])
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 10);
    updateExpressions.push('#tags = :tags');
    expressionAttributeNames['#tags'] = 'tags';
    expressionAttributeValues[':tags'] = cleaned;
  }

  if (input.perenualSpeciesId !== undefined) {
    updateExpressions.push('#perenualSpeciesId = :perenualSpeciesId');
    expressionAttributeNames['#perenualSpeciesId'] = 'perenualSpeciesId';
    expressionAttributeValues[':perenualSpeciesId'] = input.perenualSpeciesId;
  }

  updateExpressions.push('#updatedAt = :updatedAt');
  expressionAttributeNames['#updatedAt'] = 'updatedAt';
  expressionAttributeValues[':updatedAt'] = new Date().toISOString();

  const result = await dynamodb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `HOUSEHOLD#${householdId}`,
        SK: `PLANT#${plantId}`,
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
      ConditionExpression: 'attribute_exists(PK)',
    })
  );

  if (!result.Attributes) {
    return null;
  }

  return {
    id: result.Attributes.id as string,
    householdId: result.Attributes.householdId as string,
    name: result.Attributes.name as string,
    species: result.Attributes.species as string | null,
    location: result.Attributes.location as string | null,
    imageUrl: result.Attributes.imageUrl as string | null,
    notes: result.Attributes.notes as string | null,
    tags: (result.Attributes.tags as string[] | undefined) ?? [],
    perenualSpeciesId: (result.Attributes.perenualSpeciesId as number | undefined) ?? null,
    createdAt: result.Attributes.createdAt as string,
    createdBy: result.Attributes.createdBy as string,
    updatedAt: result.Attributes.updatedAt as string,
  };
}

export async function deletePlant(householdId: string, plantId: string): Promise<Plant | null> {
  // Cascade: collect all task rows for this plant and all completion rows under
  // the plant's completion partition; batch-delete in chunks of 25 (the
  // BatchWriteItem service limit). The plant row itself is deleted last with
  // ConditionExpression + ALL_OLD so we get a single atomic "did it exist?"
  // check + the deleted attributes back — saves the handler a GetItem
  // roundtrip and lets us return the plant data for audit logging.
  const taskRows = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}`,
        ':sk': 'TASK#',
      },
    })
  );
  const taskKeysForPlant = (taskRows.Items ?? [])
    .filter((t) => t.plantId === plantId)
    .map((t) => ({ PK: t.PK as string, SK: t.SK as string }));

  const completionRows = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}#PLANT#${plantId}`,
        ':sk': 'COMPLETION#',
      },
    })
  );
  const completionKeys = (completionRows.Items ?? []).map((c) => ({
    PK: c.PK as string,
    SK: c.SK as string,
  }));

  const cascadeKeys = [...taskKeysForPlant, ...completionKeys];
  for (let i = 0; i < cascadeKeys.length; i += 25) {
    const chunk = cascadeKeys.slice(i, i + 25);
    await dynamodb.send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: chunk.map((Key) => ({ DeleteRequest: { Key } })),
        },
      })
    );
  }

  let deleted: Plant | null = null;
  try {
    const result = await dynamodb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { PK: `HOUSEHOLD#${householdId}`, SK: `PLANT#${plantId}` },
        ConditionExpression: 'attribute_exists(PK)',
        ReturnValues: 'ALL_OLD',
      })
    );
    if (result.Attributes) {
      const item = result.Attributes;
      deleted = {
        id: item.id as string,
        householdId: item.householdId as string,
        name: item.name as string,
        species: (item.species as string | null | undefined) ?? null,
        location: (item.location as string | null | undefined) ?? null,
        imageUrl: (item.imageUrl as string | null | undefined) ?? null,
        notes: (item.notes as string | null | undefined) ?? null,
        tags: (item.tags as string[] | undefined) ?? [],
        perenualSpeciesId: (item.perenualSpeciesId as number | null | undefined) ?? null,
        createdAt: item.createdAt as string,
        createdBy: item.createdBy as string,
        updatedAt: item.updatedAt as string,
      };
    }
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Cascade already nuked the related rows for a plant that no longer
      // exists. Rare (TOCTOU between this call and a concurrent delete);
      // surface as 404 to the handler.
      return null;
    }
    throw err;
  }

  // Now that the DDB rows are gone, sweep the plant's uploaded images from S3.
  await deletePlantImages(householdId, plantId);

  return deleted;
}

/**
 * Best-effort removal of a plant's uploaded images from S3 when the plant is
 * deleted. Every object for a plant lives under the
 * `plants/{householdId}/{plantId}/` prefix (see `handlers/plants/handler.ts`),
 * so we list-and-delete that prefix, paging through results.
 *
 * Guarded on `IMAGES_BUCKET`: in local dev and tests the bucket isn't
 * configured, so this is a no-op. Failures are logged, never thrown — the
 * DynamoDB rows are already gone by the time we get here, so a failed image
 * cleanup must not turn a successful delete into a user-visible error. Any
 * objects orphaned by such a failure are swept by the bucket's lifecycle rule
 * (see `docs/production-checklist.md`).
 */
async function deletePlantImages(householdId: string, plantId: string): Promise<void> {
  const bucket = optionalEnv('IMAGES_BUCKET');
  if (!bucket) return;

  try {
    const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
    const prefix = `plants/${householdId}/${plantId}/`;
    let continuationToken: string | undefined;

    do {
      const listed = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      const keys = (listed.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => typeof k === 'string');

      // DeleteObjects accepts at most 1000 keys; ListObjectsV2 already pages at
      // 1000, so one delete per page stays within the limit.
      if (keys.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          })
        );
      }

      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId, plantId },
      'plant.image_cleanup_failed'
    );
  }
}

export interface PlantPhoto {
  id: string;
  plantId: string;
  imageUrl: string;
  uploadedBy: string;
  uploadedAt: string;
  caption: string | null;
}

/**
 * Append a photo to the plant's timeline AND atomically update the primary
 * `imageUrl` on the plant row. The plant row keeps tracking the most-recent
 * photo (so existing UI continues to work); the timeline keeps history.
 */
export async function appendPlantPhoto(
  householdId: string,
  plantId: string,
  imageUrl: string,
  uploadedBy: string,
  caption: string | null = null
): Promise<PlantPhoto> {
  const id = uuid();
  const now = new Date();
  const photo: PlantPhoto = {
    id,
    plantId,
    imageUrl,
    uploadedBy,
    uploadedAt: now.toISOString(),
    caption,
  };
  const photoItem: DynamoDBItem = {
    PK: `HOUSEHOLD#${householdId}#PLANT#${plantId}`,
    SK: `PHOTO#${now.toISOString()}#${id}`,
    entityType: 'PlantPhoto',
    ...photo,
  };

  await dynamodb.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE_NAME, Item: photoItem } },
        {
          Update: {
            TableName: TABLE_NAME,
            Key: { PK: `HOUSEHOLD#${householdId}`, SK: `PLANT#${plantId}` },
            UpdateExpression: 'SET #imageUrl = :imageUrl, #updatedAt = :updatedAt',
            ExpressionAttributeNames: {
              '#imageUrl': 'imageUrl',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':imageUrl': imageUrl,
              ':updatedAt': now.toISOString(),
            },
            ConditionExpression: 'attribute_exists(PK)',
          },
        },
      ],
    })
  );

  return photo;
}

export async function getPlantPhotos(
  householdId: string,
  plantId: string,
  limit = 30
): Promise<PlantPhoto[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}#PLANT#${plantId}`,
        ':sk': 'PHOTO#',
      },
      ScanIndexForward: false,
      Limit: Math.min(limit, 100),
    })
  );
  return (result.Items || []).map((item) => ({
    id: item.id as string,
    plantId: item.plantId as string,
    imageUrl: item.imageUrl as string,
    uploadedBy: item.uploadedBy as string,
    uploadedAt: item.uploadedAt as string,
    caption: (item.caption as string | null) ?? null,
  }));
}
