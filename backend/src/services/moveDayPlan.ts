/**
 * Pure planning half of Seasonal Move Day (ideation brief §4.9). No I/O:
 * services/moveDay.ts feeds it the household's plants, spaces and members
 * and persists what comes out; local-server.ts reuses it against the
 * in-memory store. Keeping the rules here means the dev server and the
 * Lambda cannot drift on *which* plants move or *who* gets asked.
 *
 * The feature activates `summerSpaceId` / `winterSpaceId` — stored and
 * validated on every plant, enforced against space deletion, and until now
 * read by nothing. A "move" is simply a plant whose current space is not the
 * home it was given for the season that is arriving.
 */
import type { SeasonalSignal } from './climate.js';
import type { Plant, PlantSpace } from '../models/types.js';

/** `customType` is capped at 50 chars (models/schemas.ts createTaskSchema). */
export const MOVE_TASK_LABEL_MAX = 50;

/**
 * USDA hardiness zone at or above which a species is treated as frost-tender.
 * Zone 10's average annual extreme minimum is −1 to 4 °C: no real frost. A
 * zone-9 plant tolerates a light frost, so it is deliberately NOT flagged —
 * the hint must never over-claim.
 */
export const FROST_TENDER_MIN_ZONE = 10;

export interface MoveDayItem {
  plantId: string;
  plantName: string;
  /** Where the plant is now. Null when the plant has no current space. */
  fromSpaceId: string | null;
  fromSpaceName: string | null;
  toSpaceId: string;
  toSpaceName: string;
  /** Round-robin pick; null when nobody was available (left up for grabs). */
  assigneeId: string | null;
  assigneeName: string | null;
  /** The task created or re-armed for this move; null if that write failed. */
  taskId: string | null;
}

export interface MoveDayTenderPlant {
  plantId: string;
  plantName: string;
  hardinessZone: string;
}

/** The measured numbers that fired the list, alongside the lines they crossed. */
export interface MoveDaySignal {
  tempC: number;
  lowC: number;
  frostLineC: number;
  heatLineC: number;
}

export interface MoveDayList {
  season: SeasonalSignal;
  firedAt: string;
  signal: MoveDaySignal;
  items: MoveDayItem[];
  /**
   * Winter only. Outdoor plants with NO winter space whose cached species
   * record says they cannot take a frost. Presence-only: a plant without a
   * cached species record is simply absent, never "fine".
   */
  tenderWithoutWinterHome: MoveDayTenderPlant[];
}

/** The plant's assigned home for `season`, or null when it has none. */
export function seasonalHome(
  plant: Pick<Plant, 'summerSpaceId' | 'winterSpaceId'>,
  season: SeasonalSignal
): string | null {
  return (season === 'winter' ? plant.winterSpaceId : plant.summerSpaceId) ?? null;
}

/**
 * Move Day is only meaningful for a household with somewhere outdoors AND at
 * least one plant that has been given a seasonal home in a space that still
 * exists. Anything else is silence, not an empty-state nag (§4.9's own
 * caveat: useless to a household with no outdoor space).
 */
export function isMoveDayApplicable(
  plants: ReadonlyArray<Pick<Plant, 'summerSpaceId' | 'winterSpaceId'>>,
  spaces: ReadonlyArray<Pick<PlantSpace, 'id' | 'environment'>>
): boolean {
  if (!spaces.some((s) => s.environment === 'outside')) return false;
  const known = new Set(spaces.map((s) => s.id));
  return plants.some(
    (p) =>
      (!!p.summerSpaceId && known.has(p.summerSpaceId)) ||
      (!!p.winterSpaceId && known.has(p.winterSpaceId))
  );
}

/**
 * Every plant whose current space is not its home for the arriving season.
 * Plants with no home for that season, or whose home no longer exists, are
 * skipped — a move to nowhere is not a task. Sorted by plant name so the
 * round-robin split is stable across retries.
 */
export function planMoves(
  plants: ReadonlyArray<Pick<Plant, 'id' | 'name' | 'spaceId' | 'summerSpaceId' | 'winterSpaceId'>>,
  spaces: ReadonlyArray<Pick<PlantSpace, 'id' | 'name'>>,
  season: SeasonalSignal
): MoveDayItem[] {
  const spacesById = new Map(spaces.map((s) => [s.id, s]));
  const items: MoveDayItem[] = [];
  for (const plant of plants) {
    const toSpaceId = seasonalHome(plant, season);
    if (!toSpaceId) continue;
    const to = spacesById.get(toSpaceId);
    if (!to) continue;
    const fromSpaceId = plant.spaceId ?? null;
    if (fromSpaceId === toSpaceId) continue;
    items.push({
      plantId: plant.id,
      plantName: plant.name,
      fromSpaceId,
      fromSpaceName: fromSpaceId ? (spacesById.get(fromSpaceId)?.name ?? null) : null,
      toSpaceId,
      toSpaceName: to.name,
      assigneeId: null,
      assigneeName: null,
      taskId: null,
    });
  }
  return items.sort(
    (a, b) => a.plantName.localeCompare(b.plantName) || a.plantId.localeCompare(b.plantId)
  );
}

/**
 * Split the moves across `assignees` in order, one each, wrapping around.
 * Callers pass members already filtered to "here and not on vacation" and
 * ordered deterministically. An empty roster leaves every item unassigned,
 * which the task layer renders as "up for grabs".
 */
export function assignRoundRobin(
  items: MoveDayItem[],
  assignees: ReadonlyArray<{ userId: string; name: string }>
): void {
  if (assignees.length === 0) return;
  items.forEach((item, i) => {
    const pick = assignees[i % assignees.length];
    item.assigneeId = pick.userId;
    item.assigneeName = pick.name;
  });
}

/**
 * The task's `customType`. Language-neutral on purpose: task rows are stored
 * data rendered verbatim in every locale, so the label is the destination
 * behind an arrow rather than an English verb. Truncated to the schema cap.
 */
export function moveTaskLabel(toSpaceName: string): string {
  const label = `→ ${toSpaceName.trim()}`;
  if (label.length <= MOVE_TASK_LABEL_MAX) return label;
  return `${label.slice(0, MOVE_TASK_LABEL_MAX - 1)}…`;
}

/**
 * True when a Perenual hardiness range ("10-12", "9-11", "10") starts at or
 * above the frost-tender line. Unparseable or missing data is `false`:
 * "we don't know" must never become "this plant is at risk".
 */
export function isFrostTender(hardinessZone: string | null | undefined): boolean {
  if (!hardinessZone) return false;
  const match = /^\s*(\d{1,2})/.exec(hardinessZone);
  if (!match) return false;
  return Number.parseInt(match[1], 10) >= FROST_TENDER_MIN_ZONE;
}
