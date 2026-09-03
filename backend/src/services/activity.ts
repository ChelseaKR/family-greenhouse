/**
 * Household activity event log. Generalizes the existing TaskCompletion
 * partition (`HOUSEHOLD#{id}#ACTIVITY` on GSI1) to carry other event types
 * — plants added, members joined, photos uploaded — so the activity feed
 * reads as the household's full story, not just task completions.
 *
 * Event records share a common envelope with a discriminator (`type`) and
 * an event-specific `payload`. We deliberately don't normalize across
 * events (no shared "actor"/"target" columns); each renderer in the UI
 * pattern-matches on `type`.
 */
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';

export interface TaskCompletedActivityPayload {
  taskId: string;
  plantId: string;
  plantName?: string;
  taskType: string;
  notes?: string | null;
  viaSitter?: boolean;
  /** Completed by tapping a household wall display (`kiosk:{linkId}` actor).
   *  Distinct from viaSitter: nobody is named, and the household needs to be
   *  able to tell a kiosk tap from a person so an unexpected one is visible. */
  viaKiosk?: boolean;
}

export interface TaskSnoozedActivityPayload {
  taskId: string;
  plantId: string;
  plantName: string;
  taskType: string;
  days: number;
  reason: 'rain' | 'frost' | 'heat' | 'other' | null;
  note: string | null;
}

export interface TaskAssignmentActivityPayload {
  taskId: string;
  plantId: string;
  plantName: string;
  taskType: string;
}

/** One-tap "match the schedule to reality" from a schedule-drift suggestion. */
export interface TaskScheduleMatchedActivityPayload {
  taskId: string;
  plantId: string;
  plantName: string;
  taskType: string;
  previousFrequency: number;
  newFrequency: number;
  medianIntervalDays: number;
  completionsConsidered: number;
}

export interface PlantIdentityActivityPayload {
  plantId: string;
  plantName: string;
}

export interface PlantLifecycleActivityPayload extends PlantIdentityActivityPayload {
  previousStatus?: 'active' | 'died' | 'gave_away' | 'archived';
}

/** A sitter link opened or closed. Never carries the token — only the
 *  non-secret id, the friendly label and the window, so the feed can say
 *  WHO opened a door to the household and for how long. */
export interface SitterLinkActivityPayload {
  linkId: string;
  label: string | null;
  startsAt: string;
  expiresAt: string;
}

/**
 * Payload contract keyed by the durable event discriminator. Keeping this as
 * an explicit map lets both the event envelope and producer input be derived
 * as discriminated unions, so a type can no longer be paired with another
 * event's payload by accident.
 */
export interface ActivityPayloadByType {
  'task.completed': TaskCompletedActivityPayload;
  'task.snoozed': TaskSnoozedActivityPayload;
  'task.claimed': TaskAssignmentActivityPayload;
  'task.unclaimed': TaskAssignmentActivityPayload;
  'plant.created': PlantIdentityActivityPayload;
  'plants.imported': { count: number };
  'plant.deleted': PlantIdentityActivityPayload;
  'plant.died': PlantLifecycleActivityPayload;
  'plant.gave_away': PlantLifecycleActivityPayload;
  'plant.archived': PlantLifecycleActivityPayload;
  'plant.restored': PlantLifecycleActivityPayload;
  'plant.propagated': PlantIdentityActivityPayload & {
    parentPlantId: string;
    parentPlantName: string;
  };
  'plant.shared_accepted': PlantIdentityActivityPayload & { fromHouseholdName: string };
  'plant.health_checked': PlantIdentityActivityPayload & {
    overall: 'healthy' | 'monitor' | 'concern';
    demo: boolean;
  };
  'photo.uploaded': { plantId: string; photoId: string };
  'member.joined': { role: 'admin' | 'member' };
  'member.left': { role?: 'admin' | 'member' };
  'sitter_link.created': SitterLinkActivityPayload;
  'sitter_link.revoked': SitterLinkActivityPayload;
  'task.schedule_matched': TaskScheduleMatchedActivityPayload;
}

export type ActivityType = keyof ActivityPayloadByType;

/** Runtime vocabulary used by parity tests and persistence-boundary guards. */
export const ACTIVITY_TYPES = [
  'task.completed',
  'task.snoozed',
  'task.claimed',
  'task.unclaimed',
  'plant.created',
  'plants.imported',
  'plant.deleted',
  'plant.died',
  'plant.gave_away',
  'plant.archived',
  'plant.restored',
  'plant.propagated',
  'plant.shared_accepted',
  'plant.health_checked',
  'photo.uploaded',
  'member.joined',
  'member.left',
  'sitter_link.created',
  'sitter_link.revoked',
  'task.schedule_matched',
] as const satisfies readonly ActivityType[];

type AssertNever<T extends never> = T;
export type ActivityTypeListIsComplete = AssertNever<
  Exclude<ActivityType, (typeof ACTIVITY_TYPES)[number]>
>;

interface ActivityEventEnvelope {
  id: string;
  householdId: string;
  actorId: string;
  actorName: string;
  occurredAt: string;
}

export type ActivityEventByType<T extends ActivityType> = ActivityEventEnvelope & {
  type: T;
  payload: ActivityPayloadByType[T];
};

export type ActivityEvent = {
  [T in ActivityType]: ActivityEventByType<T>;
}[ActivityType];

export type RecordActivityInput = {
  [T in ActivityType]: Omit<ActivityEventByType<T>, 'id' | 'occurredAt'>;
}[ActivityType];

const MAX_LIMIT = 200;

/**
 * Record an event to the household activity log. Best-effort — the caller
 * should not block its main work on a failure here. (We log and continue
 * rather than reject; the user-visible side effect is "the activity feed
 * is missing one row," which is far better than a write that succeeded
 * partially.)
 */
export async function recordActivity(input: RecordActivityInput): Promise<void> {
  const id = uuid();
  const now = new Date().toISOString();
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `HOUSEHOLD#${input.householdId}#ACTIVITY`,
          SK: `EVENT#${now}#${id}`,
          GSI1PK: `HOUSEHOLD#${input.householdId}#ACTIVITY`,
          GSI1SK: now,
          entityType: 'ActivityEvent',
          id,
          type: input.type,
          householdId: input.householdId,
          actorId: input.actorId,
          actorName: input.actorName,
          occurredAt: now,
          payload: input.payload,
        },
      })
    );
  } catch (err) {
    // Actually best-effort, as the docstring promises: a DDB failure here
    // logs and returns instead of rejecting, so the caller's main write
    // (which already succeeded) doesn't turn into a user-visible error.
    logger.warn(
      { err: (err as Error).message, householdId: input.householdId, type: input.type },
      'activity.record_failed'
    );
  }
}

/**
 * Newest-first activity for a household. Includes both legacy TaskCompletion
 * rows (already on this GSI partition) and ActivityEvent rows; the response
 * shape is the unified envelope so the frontend renders them uniformly.
 */
export async function listActivity(householdId: string, limit = 50): Promise<ActivityEvent[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}#ACTIVITY`,
      },
      ScanIndexForward: false,
      Limit: Math.min(limit, MAX_LIMIT),
    })
  );

  return (result.Items ?? []).map((item) => {
    if (item.entityType === 'ActivityEvent') {
      // DynamoDB is a persistence boundary: historical rows predate the
      // compile-time payload map, so preserve them verbatim. Producers are
      // checked by RecordActivityInput; the frontend keeps runtime fallbacks
      // for older/newer rows.
      return {
        id: item.id as string,
        type: item.type as ActivityType,
        householdId: item.householdId as string,
        actorId: item.actorId as string,
        actorName: item.actorName as string,
        occurredAt: item.occurredAt as string,
        payload: item.payload as unknown,
      } as ActivityEvent;
    }
    // TaskCompletion legacy shape — fold into the envelope.
    return {
      id: item.id as string,
      type: 'task.completed',
      householdId: item.householdId as string,
      actorId: item.completedBy as string,
      actorName: (item.completedByName as string) ?? '',
      occurredAt: (item.completedAt as string) ?? '',
      payload: {
        plantId: item.plantId as string,
        taskId: item.taskId as string,
        taskType: item.taskType as string,
        notes: (item.notes as string | null) ?? null,
      },
    };
  });
}
