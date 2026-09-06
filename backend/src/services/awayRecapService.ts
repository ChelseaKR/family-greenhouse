/**
 * Away Kit return recap — "what happened while you were away".
 *
 * Replays the activity a sitter link produced inside its window: tasks the
 * sitter checked off, photos they sent back, and any notes (photo captions
 * today; completion notes if a future sitter flow adds them). Everything is
 * read from the household's existing activity partition — no new table, no
 * new index, no inference — filtered to the link's synthetic actor
 * (`sitter:{linkId}`), which both the completion route and the photo route
 * stamp on what they write.
 *
 * Read discipline (ADR 0010): the query is paged to completion inside the
 * window and any failure propagates. A recap is never assembled from a
 * partial read and presented as "this is all that happened"; when the scan
 * cap is hit the response says so (`truncated: true`) instead of quietly
 * ending the story early.
 *
 * The pure parts (link selection, window, folding) live in
 * ./awayRecapModel.ts so the mock dev server can share them without
 * importing DynamoDB.
 */
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { itemToActivityEvent, type ActivityEvent } from './activity.js';
import type { SitterLink } from './sitterService.js';
import { sitterActorId } from './sitterPhotoPolicy.js';
import { recapWindow } from './awayRecapModel.js';

export {
  buildAwayRecap,
  dedupeCompletions,
  linkHasEnded,
  pickRecapLink,
  recapWindow,
  type AwayRecap,
  type AwayRecapLink,
  type AwayRecapNote,
  type AwayRecapPhoto,
  type AwayRecapTask,
} from './awayRecapModel.js';

/** Rows examined per recap before we stop and flag `truncated`. A 90-day
 *  window in a busy household is a few hundred rows; this is a safety rail
 *  against a pathological partition, not a working limit. */
export const AWAY_RECAP_MAX_SCANNED = 2_000;
const PAGE_SIZE = 200;

/**
 * Every activity row on the household partition inside the window that the
 * link's synthetic actor produced, oldest first. Pages through GSI1 with a
 * BETWEEN on the ISO timestamp key; stops at AWAY_RECAP_MAX_SCANNED rows
 * examined and reports it. Throws on any read failure — the caller answers
 * 5xx rather than an empty recap.
 */
export async function listSitterWindowActivity(
  householdId: string,
  link: SitterLink,
  now: Date
): Promise<{ events: ActivityEvent[]; truncated: boolean }> {
  const { from, to } = recapWindow(link, now);
  const actor = sitterActorId(link.id);
  const events: ActivityEvent[] = [];
  let scanned = 0;
  let truncated = false;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': `HOUSEHOLD#${householdId}#ACTIVITY`,
          ':from': from,
          ':to': to,
        },
        ScanIndexForward: true,
        Limit: PAGE_SIZE,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );
    const items = result.Items ?? [];
    scanned += items.length;
    for (const item of items) {
      const event = itemToActivityEvent(item);
      if (event.actorId === actor) events.push(event);
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (exclusiveStartKey && scanned >= AWAY_RECAP_MAX_SCANNED) {
      truncated = true;
      break;
    }
  } while (exclusiveStartKey);

  return { events, truncated };
}
