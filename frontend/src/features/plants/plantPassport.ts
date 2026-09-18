/**
 * The pure half of the plant passport (#676): what a printed hand-off page is
 * allowed to say about a plant, derived only from the household's own record.
 *
 * Every privacy rule the page follows lives here, as a plain function a test
 * can call without rendering anything, so the rule and its test cannot drift
 * apart behind a component:
 *
 *   - The care words are the HOUSE RULE and nothing else. `passportHouseRule`
 *     is the client twin of `resolveCareNote` in
 *     `backend/src/models/sitterBriefFields.ts`: the trimmed `careRule`, or
 *     null. It never falls back to `notes` — that fallback is exactly what
 *     leaked a plant's private notes through three public surfaces on
 *     2026-09-13 (#732, #739, #741), and a sheet of paper handed to someone
 *     outside the household is the same kind of surface.
 *   - The plant's private `notes` reach the page only through
 *     `passportNotes`, which returns them only when the person printing is an
 *     admin of the household AND ticked "include my notes" on this visit. Both,
 *     every time; the choice is never stored.
 *   - A completion's own free-text `notes`, a task's `notes` and the
 *     placement note are never read at all. `PassportCareEntry` has no field
 *     that could carry them.
 *   - Who did the care is initials unless the person printing asks for full
 *     names on this visit.
 *
 * Nothing here is generated. An absence is stated as an absence: a plant with
 * no house rule says it has none, and a care history that could not be read
 * says so instead of claiming nobody cared for the plant (ADR 0010).
 */
import type { Plant, PlantWithTasks, TaskCompletion } from '@/services/plantService';

/** How far back the passport's care history reaches, in days. */
export const PASSPORT_HISTORY_DAYS = 90;

/**
 * The most entries `GET /plants/{plantId}/history` returns: the default
 * `limit` of `getTaskCompletions` in `backend/src/services/taskService.ts`,
 * newest first. `plantPassport.test.ts` reads that default out of the backend
 * source, so the two cannot drift apart silently.
 *
 * When a read comes back this full, the list may have been cut short, and the
 * passport says so rather than presenting a ceiling as a count.
 */
export const PASSPORT_HISTORY_LIMIT = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The house rule, exactly as `resolveCareNote` resolves it on the server: the
 * trimmed `careRule`, or null. Never `notes`.
 */
export function passportHouseRule(plant: Pick<Plant, 'careRule'>): string | null {
  const rule = plant.careRule?.trim();
  return rule ? rule : null;
}

/**
 * The plant's private notes, or null. Null unless BOTH the person printing is
 * an admin of this household AND they asked for the notes on this visit —
 * either one alone is not enough. Blank notes are null too, so the page never
 * prints an empty "Notes" heading.
 */
export function passportNotes(
  plant: Pick<Plant, 'notes'>,
  consent: { includeNotes: boolean; isAdmin: boolean }
): string | null {
  if (!consent.isAdmin || !consent.includeNotes) return null;
  const notes = plant.notes?.trim();
  return notes ? notes : null;
}

/**
 * Initials for a member's display name: the first letter of the first and
 * last words, upper-cased ("Chelsea Kelly-Reif" → "CK", "Joyce" → "J").
 * Letters are taken by code point, so an accented or non-Latin initial stays
 * whole. Null for a blank name — the page states "a household member" rather
 * than printing an empty cell.
 */
export function initialsOf(name: string | null | undefined): string | null {
  const words = (name ?? '').trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return null;
  const first = Array.from(words[0])[0];
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : '';
  return `${first}${last}`.toLocaleUpperCase();
}

/** One line of the printed care history. Deliberately no `notes` field. */
export interface PassportCareEntry {
  id: string;
  completedAt: string;
  /** `water` / `fertilize` / `prune` / `repot`, or the household's own
   *  custom task name, as the completion recorded it. */
  taskType: string;
  /** Initials by default; the full display name only when asked for. Null
   *  when the completion carries no name at all. */
  who: string | null;
}

/**
 * The care history as the passport presents it. `unavailable` is its own
 * outcome: a failed read is never an empty history (ADR 0010).
 */
export type PassportHistory =
  | { status: 'unavailable' }
  | {
      status: 'ok';
      /** Entries inside the window, newest first. */
      entries: PassportCareEntry[];
      /** The read came back full and its oldest entry is still inside the
       *  window, so there may be earlier entries in the window it left out. */
      capped: boolean;
      /** The plant was added inside the window, so an empty list means "not
       *  cared for YET", not "not cared for in 90 days". */
      addedWithinWindow: boolean;
      /** Newest logged care from before the window, when the read reached
       *  that far — so an empty window can still say when care last happened. */
      lastLoggedBeforeWindow: string | null;
    };

/**
 * Shape a history read for the page. `completions` is `undefined` when the
 * read failed. Each completion is copied field by field, never spread, so a
 * completion's `notes` cannot ride along into the printed entry.
 */
export function passportHistory(
  completions: TaskCompletion[] | undefined,
  plant: Pick<Plant, 'createdAt'>,
  options: { fullNames: boolean; now: Date }
): PassportHistory {
  if (completions === undefined) return { status: 'unavailable' };

  const windowStart = options.now.getTime() - PASSPORT_HISTORY_DAYS * DAY_MS;
  const newestFirst = [...completions].sort((a, b) =>
    a.completedAt < b.completedAt ? 1 : a.completedAt > b.completedAt ? -1 : 0
  );
  // The server returns at most PASSPORT_HISTORY_LIMIT; a local dev server
  // that returns more is trimmed to the same ceiling so the page behaves the
  // same against both.
  const read = newestFirst.slice(0, PASSPORT_HISTORY_LIMIT);
  const inWindow = read.filter((c) => new Date(c.completedAt).getTime() >= windowStart);
  const beforeWindow = read.find((c) => new Date(c.completedAt).getTime() < windowStart);

  const oldestRead = read.at(-1);
  const capped =
    completions.length >= PASSPORT_HISTORY_LIMIT &&
    oldestRead !== undefined &&
    new Date(oldestRead.completedAt).getTime() >= windowStart;

  const created = new Date(plant.createdAt).getTime();

  return {
    status: 'ok',
    entries: inWindow.map((c) => ({
      id: c.id,
      completedAt: c.completedAt,
      taskType: c.taskType,
      who: options.fullNames ? c.completedByName?.trim() || null : initialsOf(c.completedByName),
    })),
    capped,
    addedWithinWindow: Number.isFinite(created) && created >= windowStart,
    lastLoggedBeforeWindow: beforeWindow?.completedAt ?? null,
  };
}

/**
 * Look the plant up in the curated, ASPCA-grounded pet-toxicity table the
 * same way `resolvePetSafety` does for the sitter brief: the species first
 * (the botanical name the table indexes), then the display name, taking the
 * best match of the first query that has one. `matchedOn` is what matched, so
 * the page can show it and a reader can judge the match for themselves.
 *
 * `lookup` is `petToxicityService.lookup` — the table's own endpoint, never
 * the Perenual species detail, whose single boolean cannot say which animal
 * or carry the ASPCA's caveat. Null means the table has no entry: the page
 * then makes no pet-safety claim in either direction.
 */
export async function passportPetSafety<M>(
  plant: Pick<Plant, 'name' | 'species'>,
  lookup: (query: string) => Promise<M[]>
): Promise<{ match: M; matchedOn: string } | null> {
  for (const query of [plant.species, plant.name]) {
    const trimmed = query?.trim();
    if (!trimmed || trimmed.length < 2) continue;
    const [match] = await lookup(trimmed);
    if (match) return { match, matchedOn: trimmed };
  }
  return null;
}

/** One task on the printed schedule: its interval, and any seasonal ones. */
export interface PassportScheduleItem {
  id: string;
  type: PlantWithTasks['upcomingTasks'][number]['type'];
  /** The household's own name for a custom task, shown as written. */
  customType: string | null;
  frequency: number;
  seasonal: Array<{ season: string; frequency: number }>;
}

/**
 * The care schedule as it stands: each task's base interval plus any seasonal
 * intervals, named by season rather than resolved to "now" — the person
 * receiving the plant may live in another hemisphere. No due dates: they
 * belong to this household's calendar, not to the plant.
 */
export function passportSchedule(plant: Pick<PlantWithTasks, 'upcomingTasks'>) {
  return plant.upcomingTasks.map((task): PassportScheduleItem => ({
    id: task.id,
    type: task.type,
    customType: task.type === 'custom' ? task.customType?.trim() || null : null,
    frequency: task.frequency,
    seasonal: (task.seasonalCadences ?? []).map((c) => ({
      season: c.season,
      frequency: c.frequency,
    })),
  }));
}
