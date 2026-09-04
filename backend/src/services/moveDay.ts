/**
 * Seasonal Move Day (ideation brief §4.9) — the I/O half. See
 * services/moveDayPlan.ts for the pure rules.
 *
 * "First frost is tonight. These 9 plants need to come inside — here's the
 * list, split between you two." The list is produced when the household's
 * ALREADY-CACHED climate snapshot crosses the same frost/heat line the
 * climate card's tips use. This module never calls the weather provider and
 * never touches the daily weather budget: it reads the cache row the
 * dashboard's climate card warmed moments earlier (`peekWeatherCached`) and,
 * when there is no live row, it does nothing and says nothing. A frost date
 * is never inferred, estimated, or made up.
 *
 * Marginal cost per household per month: $0 — a handful of DynamoDB reads on
 * dashboard loads and, at most twice a year, one write per moved plant.
 *
 * Firing is lazy (on dashboard load, via POST /households/:id/move-day)
 * rather than from the reminders cron, because the cron would find a cold
 * cache and would have to spend a weather call to do its job.
 *
 * Once per season: the record row `HOUSEHOLD#{id} / MOVEDAY#{season}` is
 * written with a conditional put, so two dashboards loading at the same
 * moment produce one list, and the same season cannot fire again for
 * MOVE_DAY_REFIRE_GAP_DAYS. A list stays "ready" (the card shows it) for
 * MOVE_DAY_CARD_DAYS, then goes quiet until the next season.
 */
import { PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamodb, TABLE_NAME } from '../utils/dynamodb.js';
import { logger } from '../utils/logger.js';
import * as climate from './climate.js';
import * as enrichment from './enrichment.js';
import * as householdService from './householdService.js';
import * as plantService from './plantService.js';
import * as spaceService from './spaceService.js';
import * as taskService from './taskService.js';
import {
  assignRoundRobin,
  isFrostTender,
  isMoveDayApplicable,
  moveTaskLabel,
  planMoves,
} from './moveDayPlan.js';
import type { MoveDayItem, MoveDayList, MoveDayTenderPlant } from './moveDayPlan.js';
import type { Household, Plant, PlantSpace, Task } from '../models/types.js';

/** A seasonal move recurs yearly; the next fire re-arms the same task. */
export const MOVE_DAY_TASK_FREQUENCY_DAYS = 365;
/** The same season cannot fire again inside this window. */
export const MOVE_DAY_REFIRE_GAP_DAYS = 180;
/** The opposite season cannot fire inside this window either — a 32 °C day a
 *  week after the first frost must not ask everyone to carry it all back. */
export const MOVE_DAY_MIN_SEASON_GAP_DAYS = 90;
/** How long a fired list stays on the dashboard. */
export const MOVE_DAY_CARD_DAYS = 14;
const RECORD_TTL_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

export type MoveDayResult =
  /** No outdoor space, or no plant with a seasonal home: silence, not a nag. */
  | { status: 'not_applicable' }
  /** No saved location, or no live cached snapshot: do nothing, say nothing. */
  | { status: 'unavailable' }
  /** Snapshot read; no line crossed, or this season already handled, or
   *  nothing needs moving. */
  | { status: 'quiet' }
  | { status: 'ready'; list: MoveDayList };

function recordKey(householdId: string, season: MoveDayList['season']) {
  return { PK: `HOUSEHOLD#${householdId}`, SK: `MOVEDAY#${season}` };
}

function withinDays(iso: string, now: Date, days: number): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && now.getTime() - t < days * DAY_MS;
}

function itemToList(item: Record<string, unknown>): MoveDayList {
  return {
    season: item.season as MoveDayList['season'],
    firedAt: item.firedAt as string,
    signal: item.signal as MoveDayList['signal'],
    items: (item.items as MoveDayItem[] | undefined) ?? [],
    tenderWithoutWinterHome:
      (item.tenderWithoutWinterHome as MoveDayTenderPlant[] | undefined) ?? [],
    // Rows written before #454 carry no count. They were produced by the code
    // that could not tell a failed check from a clear one, so "0 failures" is
    // not something we know about them — but it is the only reading that does
    // not invent a warning, and the 400-day record TTL retires them.
    tenderCheckFailures: Number(item.tenderCheckFailures ?? 0) || 0,
  };
}

/** Both seasons' records (at most two rows), keyed by season. */
async function readRecords(householdId: string): Promise<Map<MoveDayList['season'], MoveDayList>> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `HOUSEHOLD#${householdId}`,
        ':sk': 'MOVEDAY#',
      },
    })
  );
  const map = new Map<MoveDayList['season'], MoveDayList>();
  for (const raw of (result.Items ?? []) as Record<string, unknown>[]) {
    const list = itemToList(raw);
    if (list.season === 'winter' || list.season === 'summer') map.set(list.season, list);
  }
  return map;
}

/**
 * Claim the season with a conditional put. Returns false when another
 * request already claimed it inside the re-fire window — the caller then
 * serves that request's list instead of creating a second set of tasks.
 */
async function claimSeason(householdId: string, list: MoveDayList, now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - MOVE_DAY_REFIRE_GAP_DAYS * DAY_MS).toISOString();
  try {
    await dynamodb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...recordKey(householdId, list.season),
          entityType: 'MoveDay',
          householdId,
          ...list,
          ttl: Math.floor((now.getTime() + RECORD_TTL_DAYS * DAY_MS) / 1000),
        },
        ConditionExpression: 'attribute_not_exists(SK) OR firedAt < :cutoff',
        ExpressionAttributeValues: { ':cutoff': cutoff },
      })
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/** Members present today, in a stable order, for the round-robin split. */
async function availableAssignees(
  householdId: string,
  now: Date
): Promise<Array<{ userId: string; name: string }>> {
  const [members, away] = await Promise.all([
    householdService.getHouseholdMembers(householdId),
    taskService.getActiveVacationMap(householdId, now),
  ]);
  return members
    .filter((m) => !away.has(m.userId))
    .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.userId.localeCompare(b.userId))
    .map((m) => ({ userId: m.userId, name: m.name }));
}

/**
 * Winter hint: outdoor plants with no winter home whose species the app has
 * ALREADY looked up (cache only — no Perenual call, no budget) are known to
 * be frost-tender. Presence-only by construction.
 *
 * The cache read is three-state on purpose. A plant whose species row could
 * not be READ is not the same as one that was checked and cleared, and this
 * function has no second chance to find out: it never calls Perenual, and the
 * answer it returns is frozen on the record for MOVE_DAY_CARD_DAYS. So a
 * failed read is counted and handed to the card, which says "we could not
 * check N of these" rather than quietly shortening the frost warning (#454).
 */
async function tenderWithoutWinterHome(
  plants: ReadonlyArray<Plant>,
  spaces: ReadonlyArray<PlantSpace>
): Promise<{ tender: MoveDayTenderPlant[]; failures: number }> {
  const outdoor = new Set(spaces.filter((s) => s.environment === 'outside').map((s) => s.id));
  const candidates = plants.filter(
    (p) => !p.winterSpaceId && !!p.spaceId && outdoor.has(p.spaceId) && !!p.perenualSpeciesId
  );
  const found: MoveDayTenderPlant[] = [];
  let failures = 0;
  for (const plant of candidates) {
    const species = await enrichment.peekSpeciesCached(plant.perenualSpeciesId as number);
    if (species.status === 'unavailable') {
      failures += 1;
      continue;
    }
    if (
      species.status === 'cached' &&
      species.value &&
      isFrostTender(species.value.hardinessZone)
    ) {
      found.push({
        plantId: plant.id,
        plantName: plant.name,
        hardinessZone: species.value.hardinessZone as string,
      });
    }
  }
  if (failures > 0) {
    logger.warn({ failures, candidates: candidates.length }, 'move_day.tender_check_incomplete');
  }
  return { tender: found.sort((a, b) => a.plantName.localeCompare(b.plantName)), failures };
}

/**
 * One claimable task per move, through the existing task path. A move is a
 * yearly recurrence, so a task with the same label from an earlier season is
 * re-armed (nextDue = now) instead of duplicated.
 *
 * `existing` is read by the CALLER, before the season is claimed, and a
 * failure there propagates: an unreadable task list is not an empty one, and
 * treating it as empty would recreate every move task the household already
 * has. Per-item write failures are different — they are logged and leave that
 * item's `taskId` null, so the card still shows who moves what.
 */
async function materializeTasks(
  householdId: string,
  actorUserId: string,
  list: MoveDayList,
  now: Date,
  existing: ReadonlyArray<Task>
): Promise<void> {
  const nowIso = now.toISOString();

  for (const item of list.items) {
    const label = moveTaskLabel(item.toSpaceName);
    try {
      const match = existing.find(
        (t) => t.plantId === item.plantId && t.type === 'custom' && t.customType === label
      );
      if (match) {
        await taskService.updateTask(householdId, match.id, { nextDue: nowIso });
        item.taskId = match.id;
        // The earlier task's owner keeps it; an unassigned one stays up for grabs.
        item.assigneeId = match.assignedTo;
        item.assigneeName = match.assignedToName;
        continue;
      }
      const task = await taskService.createTask(
        {
          plantId: item.plantId,
          type: 'custom',
          customType: label,
          frequency: MOVE_DAY_TASK_FREQUENCY_DAYS,
          nextDue: nowIso,
        },
        householdId,
        actorUserId,
        item.plantName,
        {
          defaultAssigneeId: item.assigneeId ?? undefined,
          defaultAssignmentSource: 'move_day',
        }
      );
      item.taskId = task.id;
      // createTask drops a stale assignee rather than failing; mirror it.
      item.assigneeId = task.assignedTo;
      item.assigneeName = task.assignedToName;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, householdId, plantId: item.plantId },
        'move_day.task_write_failed'
      );
    }
  }

  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: recordKey(householdId, list.season),
        UpdateExpression: 'SET #items = :items',
        ExpressionAttributeNames: { '#items': 'items' },
        ExpressionAttributeValues: { ':items': list.items },
      })
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message, householdId }, 'move_day.record_update_failed');
  }
}

/**
 * Evaluate Move Day for a household. Idempotent per season: the first call
 * after the line is crossed creates the tasks; every later call inside the
 * card window returns the same list; after that the season is quiet.
 */
export async function evaluateMoveDay(
  household: Household,
  actorUserId: string,
  now: Date = new Date()
): Promise<MoveDayResult> {
  const [plants, spaces] = await Promise.all([
    plantService.getPlants(household.id),
    spaceService.getSpaces(household.id),
  ]);
  if (!isMoveDayApplicable(plants, spaces)) return { status: 'not_applicable' };

  const records = await readRecords(household.id);
  const recent = [...records.values()]
    .filter((r) => withinDays(r.firedAt, now, MOVE_DAY_CARD_DAYS))
    .sort((a, b) => b.firedAt.localeCompare(a.firedAt))[0];
  if (recent) return { status: 'ready', list: recent };

  if (!household.location) return { status: 'unavailable' };
  const snapshot = await climate.peekWeatherCached(household.location.lat, household.location.lon);
  if (!snapshot) return { status: 'unavailable' };

  const season = climate.seasonalSignal(snapshot);
  if (!season) return { status: 'quiet' };

  const same = records.get(season);
  if (same && withinDays(same.firedAt, now, MOVE_DAY_REFIRE_GAP_DAYS)) return { status: 'quiet' };
  const other = records.get(season === 'winter' ? 'summer' : 'winter');
  if (other && withinDays(other.firedAt, now, MOVE_DAY_MIN_SEASON_GAP_DAYS)) {
    return { status: 'quiet' };
  }

  const items = planMoves(plants, spaces, season);
  // Nothing out of place: do not consume the season, so a plant moved back
  // out before the next cold night still gets its list.
  if (items.length === 0) return { status: 'quiet' };

  assignRoundRobin(items, await availableAssignees(household.id, now));

  // Read the current tasks BEFORE claiming the season. A failed read must not
  // look like "this household has no move tasks yet" — that would duplicate
  // last year's. Letting it throw leaves the season unclaimed and nothing
  // written, so the next dashboard load retries cleanly.
  const existingTasks = await taskService.getTasks(household.id);

  const tender =
    season === 'winter'
      ? await tenderWithoutWinterHome(plants, spaces)
      : { tender: [], failures: 0 };

  const list: MoveDayList = {
    season,
    firedAt: now.toISOString(),
    signal: {
      tempC: snapshot.tempC,
      lowC: snapshot.forecast[0]?.minC ?? snapshot.tempC,
      frostLineC: climate.FROST_LOW_C,
      heatLineC: climate.HEAT_HIGH_C,
    },
    items,
    tenderWithoutWinterHome: tender.tender,
    tenderCheckFailures: tender.failures,
  };

  if (!(await claimSeason(household.id, list, now))) {
    // Lost the race to a concurrent dashboard load: serve its list.
    const theirs = (await readRecords(household.id)).get(season);
    return theirs ? { status: 'ready', list: theirs } : { status: 'quiet' };
  }

  await materializeTasks(household.id, actorUserId, list, now, existingTasks);
  logger.info({ householdId: household.id, season, moves: items.length }, 'move_day.fired');
  return { status: 'ready', list };
}
