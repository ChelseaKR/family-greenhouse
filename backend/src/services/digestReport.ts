/**
 * What the weekly digest actually knows, and how it says it.
 *
 * Split from `services/digest.ts` (which keeps the scan, the dedupe markers
 * and the send loop) because the interesting part of the digest is no longer
 * the delivery machinery — it is deciding what is worth saying.
 *
 * ## The rule every section here obeys
 *
 * Each data source returns a DISCRIMINATED result, never a bare value. A
 * failed read is `{ status: 'unavailable' }` and renders as a sentence saying
 * we could not look. It is never an empty list, never a zero, and never a
 * silently missing section. This repo's named defect class is "absence
 * rendered as a value" (ADR 0010) and a care-reminder product is the worst
 * place for it: a household that gets a cheerful all-clear because a query
 * failed is exactly the household that needed the nudge.
 *
 * ## Tone
 *
 * The product's north star is "people share plant care without anyone feeling
 * like a nag" (docs/roadmap.md). A ranked guilt-list of overdue plants mailed
 * identically to five people is the failure mode — nobody is named, so nobody
 * moves. So: lead with what is fine, surface unclaimed work FIRST because it
 * is the work nobody has taken, name who last did each job (and say "you" when
 * that is the reader), and never route a plant to someone who is away.
 *
 * ## Cost
 *
 * Everything here is DynamoDB. The weather comes from the cached snapshot
 * only — `climate.peekCachedWeather`, which makes no upstream call and spends
 * nothing from the daily weather budget, because the digests Lambda has no
 * OpenWeatherMap key and a weekly summary is not worth giving it one.
 */
import { PET_TOXICITY, type PetToxicityEntry } from '../models/petToxicity.js';
import { getEntitledPlan, hasHouseholdToolkit } from '../models/plans.js';
import type { Plant, PlantSpace, Task } from '../models/types.js';
import { logger } from '../utils/logger.js';
import * as billing from './billing.js';
import * as climate from './climate.js';
import * as doubleCare from './doubleCare.js';
import * as householdService from './householdService.js';
import * as plantService from './plantService.js';
import * as spaceService from './spaceService.js';
import * as taskService from './taskService.js';
import { formatCount, formatDaysAgo, t, tn, type EmailLocale } from './email/catalog.js';
import { plantUrl, settingsUrl, taskUrl, tasksUrl } from './email/links.js';
import { renderEmail, type EmailBlock } from './email/template.js';

/** The digest LISTS at most this many plants — it's a nudge, not an inventory.
 *  It does not cap what the digest may COUNT: the subject states the real
 *  total, and getting that wrong under-reports exactly the households that
 *  most need the nudge. */
export const TOP_PLANTS = 5;
/** How many days of history the trend line compares. */
const TREND_DAYS = 30;
/** At most this many weather tips; the digest is a nudge, not a forecast. */
const MAX_WEATHER_TIPS = 2;
/** At most this many pet-safety lines. */
const MAX_PET_LINES = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AtRiskRow {
  plantId: string;
  plantName: string;
  taskId: string;
  taskType: Task['type'];
  /** The user's own label for a custom task, or null when they never set one.
   *  Null renders as a localized "Custom care" — never the literal word
   *  "custom", which used to appear as if it were the task's name. */
  customLabel: string | null;
  /** Whole days overdue, or NULL when `nextDue` could not be read. Null is
   *  load-bearing: the old code produced NaN here and rendered "waiting NaN
   *  days for some care". */
  daysOverdue: number | null;
  /** Most recent photo of this plant, on our own asset origin or null. */
  imageUrl: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  /** True when nobody has taken this task — the "up for grabs" case. */
  unclaimed: boolean;
  /** The task's scheduled interval in whole days. Carried so the drift
   *  section can read this row's rhythm without a second task read. */
  scheduledIntervalDays: number;
}

export type AtRiskResult =
  | {
      status: 'ok';
      /** EVERY at-risk plant, ranked. Uncapped — the cap is a display concern
       *  and lives in the composer. */
      rows: AtRiskRow[];
      /** Active plants with nothing overdue. Lead with this. */
      onTrack: number;
      /** Overdue tasks whose plant row does not exist at all. A genuine data
       *  inconsistency, distinct from a task on a plant that died. */
      orphanTasks: number;
      /**
       * The household's ACTIVE plants, exactly as `getPlants(id, 'active')`
       * would have returned them (#580).
       *
       * Carried, not re-read, because `getPlants` issues the SAME single
       * DynamoDB Query for every filter value and applies `filter` in memory
       * afterwards (`plantService.ts`) — so `'active'` is a strict subset of
       * the `'all'` rows `gatherAtRisk` already holds, computed from the
       * identical row set. `gatherPetWarnings` used to buy that subset with a
       * second Query of the same partition; now it is handed this.
       *
       * OPTIONAL on purpose, and the optionality is load-bearing. A consumer
       * holding an `AtRiskResult` from somewhere other than `gatherAtRisk`
       * (a synthetic one, or a future cache) has no plants to give, and the
       * read must then still happen: `undefined` means "go and read", never
       * "the household has no plants". `gatherPetWarnings` keeps its own read
       * as the fallback for exactly that reason.
       */
      activePlants?: Plant[];
    }
  | { status: 'unavailable' };

export type LastCare =
  | { status: 'ok'; byUserId: string; byName: string | null; daysAgo: number }
  | { status: 'none' }
  | { status: 'unavailable' };

export type WeatherResult =
  { status: 'ok'; tips: string[] } | { status: 'none' } | { status: 'unavailable' };

export type TrendResult =
  { status: 'ok'; last7: number; prev7: number } | { status: 'unavailable' };

export interface PetWarning {
  plantId: string;
  plantName: string;
  pets: 'cats' | 'dogs' | 'both';
}

export type PetResult = { status: 'ok'; warnings: PetWarning[] } | { status: 'unavailable' };

/** The one schedule-drift reading the digest carries, already ranked. */
export interface DriftFinding {
  plantId: string;
  plantName: string;
  taskId: string;
  taskType: Task['type'];
  /** The user's own label for a custom task, or null — same rule as AtRiskRow. */
  customLabel: string | null;
  /** Whole-day interval the household actually keeps (the server's suggestion). */
  actualIntervalDays: number;
  /** Whole-day interval the task is scheduled at. */
  scheduledIntervalDays: number;
}

/**
 * Whether the digest has a schedule-drift reading worth a line.
 *
 * Four states kept apart, and only one of them renders anything:
 *
 *   - `ok` + a finding — the strongest reading over the threshold;
 *   - `ok` + `finding: null` — we looked and nothing drifted;
 *   - `not_in_plan` — the household is not on the Garden household toolkit,
 *     so we never looked;
 *   - `unavailable` — the plan read failed, or every history read did.
 *
 * ## Why the failed state renders NOTHING, unlike every other section here
 *
 * This is a deliberate exception to the module rule at the top of the file,
 * for two reasons that do not apply to the at-risk / pet / weather sections.
 *
 * First, absence here is not an all-clear. Those sections make a positive
 * claim when they are quiet ("nothing is overdue", "no pet risk"); this one
 * has no quiet claim at all — it either names a schedule worth changing or
 * says nothing, which is the same rule `ScheduleDriftHint` already states on
 * the plant page ("an absent suggestion is not a claim that the schedule is
 * right"). Second, `unavailable` fires when the BILLING read fails, and at
 * that point we do not know the tier. Rendering "we could not check your
 * schedules" would advertise a paid feature to free-tier households on the
 * strength of a failed read — worse than silence in both directions.
 *
 * The state is still discriminated rather than collapsed into a bare `null`,
 * because the log line has to be able to say WHICH of the four happened.
 */
export type DriftResult =
  | { status: 'ok'; finding: DriftFinding | null }
  | { status: 'not_in_plan' }
  | { status: 'unavailable' };

export interface CoverageInfo {
  coverName: string | null;
  awayName: string | null;
}

export interface DigestReport {
  householdId: string;
  householdName: string | null;
  atRisk: AtRiskResult;
  /** Keyed by plantId, only for the rows the digest will list. */
  lastCare: Map<string, LastCare>;
  weather: WeatherResult;
  trend: TrendResult;
  pets: PetResult;
  /** One schedule-drift reading, or an explicit reason there is none. */
  drift: DriftResult;
  /** Members with an active vacation window: they are away, so nothing is
   *  routed to them and they receive no digest. */
  awayUserIds: Set<string>;
  /** Away member -> who is covering, for the "Alex is covering for Sam" line. */
  coverage: Map<string, CoverageInfo>;
}

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

function wholeDaysOverdue(nextDue: string, now: Date): number | null {
  const due = new Date(nextDue).getTime();
  if (!Number.isFinite(due)) return null;
  return Math.floor((now.getTime() - due) / (24 * 60 * 60 * 1000));
}

/**
 * The household's plants most at risk: every ACTIVE plant with at least one
 * overdue task, ranked by the max days-overdue across its tasks.
 *
 * Deliberately uncapped (see TOP_PLANTS). Two failure shapes are separated
 * that the previous version collapsed:
 *
 *   - a thrown read is `unavailable`, so "we could not check" reaches the
 *     recipient as a sentence instead of as an empty all-clear;
 *   - an overdue task whose plant row is missing ENTIRELY is counted as
 *     `orphanTasks` and logged, distinct from a task on a plant that legitimately
 *     died or was given away. Reading plants with the `'all'` filter costs the
 *     same single query and is what makes the two distinguishable.
 *
 * Returns the active subset on `activePlants` so the rest of the report does
 * not pay for the same partition twice (#580).
 */
export async function gatherAtRisk(householdId: string, now: Date): Promise<AtRiskResult> {
  let overdue: Task[];
  let allPlants: Plant[];
  try {
    overdue = await taskService.getTasksDueBy(householdId, now.toISOString());
    allPlants = await plantService.getPlants(householdId, 'all');
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId, msg: 'digest.at_risk_read_failed' },
      'digest.at_risk_read_failed'
    );
    return { status: 'unavailable' };
  }

  const byId = new Map(allPlants.map((p) => [p.id, p]));
  const active = allPlants.filter((p) => p.status === 'active');
  const activeIds = new Set(active.map((p) => p.id));

  const rows = new Map<string, AtRiskRow>();
  let orphanTasks = 0;
  for (const task of overdue) {
    if (!byId.has(task.plantId)) {
      orphanTasks += 1;
      continue;
    }
    if (!activeIds.has(task.plantId)) continue; // died / gave away / archived
    const plant = byId.get(task.plantId) as Plant;
    const days = wholeDaysOverdue(task.nextDue, now);
    const current = rows.get(task.plantId);
    // Rank by the most-overdue task. An unreadable due date sorts last rather
    // than winning the comparison against a real number.
    const beats = !current || (days ?? -1) > (current.daysOverdue ?? -1);
    if (!beats) continue;
    rows.set(task.plantId, {
      plantId: plant.id,
      plantName: plant.name,
      taskId: task.id,
      taskType: task.type,
      customLabel: task.customType,
      daysOverdue: days,
      imageUrl: plant.imageUrl,
      assignedTo: task.assignedTo,
      assignedToName: task.assignedToName,
      unclaimed: task.assignedTo === null,
      scheduledIntervalDays: task.frequency,
    });
  }

  if (orphanTasks > 0) {
    // Visible in CloudWatch so a mass-drop cannot pass as a quiet week.
    logger.warn(
      {
        householdId,
        orphanTasks,
        overdueTasks: overdue.length,
        plants: allPlants.length,
        msg: 'digest.orphan_overdue_tasks',
      },
      'digest.orphan_overdue_tasks'
    );
  }

  const ranked = [...rows.values()].sort((a, b) => {
    // Unclaimed first: it is the work nobody has taken, and the whole point of
    // the digest is to get it taken.
    if (a.unclaimed !== b.unclaimed) return a.unclaimed ? -1 : 1;
    return (b.daysOverdue ?? -1) - (a.daysOverdue ?? -1);
  });

  return {
    status: 'ok',
    rows: ranked,
    onTrack: Math.max(0, active.length - ranked.length),
    orphanTasks,
    // Handed on rather than re-queried by `gatherPetWarnings` (#580). This is
    // the same array `onTrack` is counted from, so the two can never disagree
    // about which plants are active — the pair of Queries could, if a write
    // landed between them.
    activePlants: active,
  };
}

/**
 * Who last cared for each listed plant, and when. One point query per listed
 * row (at most `TOP_PLANTS`), because the household-wide activity feed is a
 * recency window: a plant whose last care fell outside it would read as "never
 * cared for", which is a different claim.
 */
export async function gatherLastCare(
  householdId: string,
  rows: AtRiskRow[],
  now: Date
): Promise<Map<string, LastCare>> {
  const out = new Map<string, LastCare>();
  await Promise.all(
    rows.map(async (row) => {
      try {
        const completions = await taskService.getTaskCompletions(householdId, row.plantId, 1);
        const latest = completions[0];
        if (!latest) {
          out.set(row.plantId, { status: 'none' });
          return;
        }
        const at = new Date(latest.completedAt).getTime();
        if (!Number.isFinite(at)) {
          out.set(row.plantId, { status: 'unavailable' });
          return;
        }
        out.set(row.plantId, {
          status: 'ok',
          byUserId: latest.completedBy,
          byName: latest.completedByName || null,
          daysAgo: Math.max(0, Math.floor((now.getTime() - at) / (24 * 60 * 60 * 1000))),
        });
      } catch (err) {
        logger.warn(
          {
            err: (err as Error).message,
            householdId,
            plantId: row.plantId,
            msg: 'digest.history_read_failed',
          },
          'digest.history_read_failed'
        );
        out.set(row.plantId, { status: 'unavailable' });
      }
    })
  );
  return out;
}

/**
 * Cached weather only. `none` means there is no recent snapshot (or the
 * household has not set a location) and the digest simply says nothing about
 * the weather; `unavailable` means the cache read failed and the digest says
 * so. Collapsing the two would publish a DynamoDB blip as "no weather worth
 * mentioning".
 */
export async function gatherWeather(householdId: string): Promise<WeatherResult> {
  let location: { lat: number; lon: number } | null | undefined;
  try {
    location = (await householdService.getHousehold(householdId))?.location;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId, msg: 'digest.household_read_failed' },
      'digest.household_read_failed'
    );
    return { status: 'unavailable' };
  }
  if (!location) return { status: 'none' };

  const cached = await climate.peekCachedWeather(location.lat, location.lon);
  if (cached.status === 'unavailable') return { status: 'unavailable' };
  if (cached.status === 'miss') return { status: 'none' };

  const tips = climate.deriveClimateTips(cached.snapshot);
  if (tips.length === 0) return { status: 'none' };
  // KNOWN GAP: the tip prose itself comes from services/climate.ts, which is
  // English-only and is also rendered on the dashboard. The digest's framing
  // around it is localized; the sentence is not. Localizing the tips belongs
  // with whoever next touches climate.ts, so both surfaces move together.
  return { status: 'ok', tips: tips.slice(0, MAX_WEATHER_TIPS).map((tip) => tip.message) };
}

/**
 * One honest line on whether the household is keeping up: completions in the
 * last seven days against the seven before them, from the same 30-day series
 * the analytics page uses.
 */
export async function gatherTrend(householdId: string): Promise<TrendResult> {
  try {
    const series = await taskService.getDailyCompletionCounts(householdId, TREND_DAYS);
    const tail = series.slice(-14);
    const prev7 = tail.slice(0, Math.max(0, tail.length - 7)).reduce((n, d) => n + d.count, 0);
    const last7 = tail.slice(-7).reduce((n, d) => n + d.count, 0);
    return { status: 'ok', last7, prev7 };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId, msg: 'digest.trend_read_failed' },
      'digest.trend_read_failed'
    );
    return { status: 'unavailable' };
  }
}

function toxicityFor(plant: { name: string; species: string | null }): PetToxicityEntry | null {
  // Exact matches against the curated table only — the fuzzy tiers in
  // `lookupToxicity` exist for a search box where a human reads the result and
  // can see it is about a different species. An email asserts. ADR 0011: a
  // toxicity claim comes from the verified table or is not made.
  const candidates = [plant.species, plant.name]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => value.trim().toLowerCase().replace(/[’']/g, ''));
  for (const candidate of candidates) {
    for (const entry of PET_TOXICITY) {
      const names = [entry.commonName, entry.scientificName, ...entry.aliases].map((n) =>
        n.toLowerCase().replace(/[’']/g, '')
      );
      if (names.includes(candidate)) return entry;
    }
  }
  return null;
}

/**
 * Plants that are toxic per the curated ASPCA-grounded table AND sit in a
 * space the household has marked as pet-accessible.
 *
 * `petAccess === true` only. Null means "we have not been told", and a
 * pet-safety warning is not a place to guess in either direction.
 *
 * A failed spaces read is `unavailable`, not silence: dropping a pet-safety
 * line because a query failed is an unsafe absence, which is exactly what ADR
 * 0011 exists to prevent.
 *
 * @param activePlants The household's active plants, when the caller already
 *   holds them — `gatherAtRisk` does, on `AtRiskResult.activePlants`, and
 *   passing them here removes the second Query of the same partition (#580).
 *
 *   Supplying them removes ONLY the plants read. The spaces read is still
 *   issued, still inside the try, and still turns a failure into
 *   `unavailable`: the saving must not be able to convert a failed spaces read
 *   into a clean empty warning list, which is the same unsafe absence in a
 *   quieter costume. Omit the argument and the plants read happens exactly as
 *   before, so a caller with nothing to give loses nothing but the saving.
 */
export async function gatherPetWarnings(
  householdId: string,
  rows: AtRiskRow[],
  activePlants?: Plant[]
): Promise<PetResult> {
  if (rows.length === 0) return { status: 'ok', warnings: [] };
  let spaces: PlantSpace[];
  let plants: Plant[];
  try {
    spaces = await spaceService.getSpaces(householdId);
    plants = activePlants ?? (await plantService.getPlants(householdId, 'active'));
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId, msg: 'digest.pet_read_failed' },
      'digest.pet_read_failed'
    );
    return { status: 'unavailable' };
  }

  const petAccessible = new Set(spaces.filter((s) => s.petAccess === true).map((s) => s.id));
  const byId = new Map(plants.map((p) => [p.id, p]));

  const warnings: PetWarning[] = [];
  for (const row of rows) {
    const plant = byId.get(row.plantId);
    if (!plant?.spaceId || !petAccessible.has(plant.spaceId)) continue;
    const entry = toxicityFor(plant);
    if (!entry) continue;
    const cats = entry.cats === 'toxic';
    const dogs = entry.dogs === 'toxic';
    if (!cats && !dogs) continue;
    warnings.push({
      plantId: plant.id,
      plantName: plant.name,
      pets: cats && dogs ? 'both' : cats ? 'cats' : 'dogs',
    });
    if (warnings.length >= MAX_PET_LINES) break;
  }
  return { status: 'ok', warnings };
}

/**
 * The strongest schedule-drift reading among the plants this digest is
 * already listing — "you water this about every 11 days; it's scheduled every
 * 7" — so the household toolkit's best insight reaches someone who did not go
 * looking for it.
 *
 * ## Why this exists at all
 *
 * `computeScheduleDrift` has shipped and worked for a while, and its only
 * render site is `ScheduleDriftHint` on ONE plant's detail page, which only
 * appears for a plant that has already drifted. Nobody browses plant detail
 * pages hoping to find schedule advice they do not know exists, so the
 * feature was effectively unreachable (#481). This is the push.
 *
 * ## Cost, and the blind spot the cost buys
 *
 * One billing read plus at most one completion-partition query per LISTED
 * at-risk row (`TOP_PLANTS`, so ≤5) — the same per-plant query shape
 * `GET /plants/{id}/schedule-drift` already serves, and no new index.
 *
 * The consequence, stated rather than hidden: scanning the at-risk rows sees
 * only the UNDER-care direction. A task done LESS often than scheduled runs
 * chronically overdue, so it is exactly what the at-risk list holds; a task
 * done MORE often than scheduled pushes its own `nextDue` forward every time
 * and is never overdue, so it never appears here and its drift stays as
 * invisible as before. Covering that direction needs a candidate set the
 * digest does not have (every task in the household, not just the late ones)
 * and a household-wide completion scan to go with it. Deliberately left for a
 * decision about what that scan is worth, rather than silently half-done.
 *
 * The reading itself comes from `getScheduleDriftForPlant` — the same call
 * the plant page and the one-tap `matchTaskSchedule` use — so the number in
 * the email is computed from the same sample as the number on the page the
 * link lands on. This section never computes its own arithmetic.
 */
export async function gatherScheduleDrift(
  householdId: string,
  rows: AtRiskRow[]
): Promise<DriftResult> {
  if (rows.length === 0) return { status: 'ok', finding: null };

  let plan;
  try {
    plan = getEntitledPlan(await billing.getHouseholdSubscription(householdId));
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId, msg: 'digest.drift_plan_read_failed' },
      'digest.drift_plan_read_failed'
    );
    return { status: 'unavailable' };
  }
  // ENTITLEMENT, not the plan row (#476): a past_due household is not being
  // granted the toolkit, so it does not get the toolkit's insight by email.
  if (!hasHouseholdToolkit(plan)) return { status: 'not_in_plan' };

  const readings = await Promise.all(
    rows.map(async (row) => ({
      row,
      reading: (
        await doubleCare.getScheduleDriftForPlant(householdId, row.plantId, [
          { id: row.taskId, frequency: row.scheduledIntervalDays },
        ])
      )[0],
    }))
  );

  let unreadable = 0;
  let best: { row: AtRiskRow; suggested: number; driftPct: number } | null = null;
  for (const { row, reading } of readings) {
    if (!reading || reading.reason === 'history_unavailable') {
      unreadable += 1;
      continue;
    }
    const drift = reading.drift;
    if (!drift || !drift.exceedsThreshold) continue;
    if (!best || Math.abs(drift.driftPct) > Math.abs(best.driftPct)) {
      best = { row, suggested: drift.suggestedFrequency, driftPct: drift.driftPct };
    }
  }

  if (!best) {
    // Every history read failed: we did not look, and saying "nothing drifted"
    // would be the absence-as-a-value defect this file exists to avoid.
    if (unreadable === readings.length) {
      logger.warn(
        { householdId, plants: readings.length, msg: 'digest.drift_history_unreadable' },
        'digest.drift_history_unreadable'
      );
      return { status: 'unavailable' };
    }
    return { status: 'ok', finding: null };
  }

  return {
    status: 'ok',
    finding: {
      plantId: best.row.plantId,
      plantName: best.row.plantName,
      taskId: best.row.taskId,
      taskType: best.row.taskType,
      customLabel: best.row.customLabel,
      actualIntervalDays: best.suggested,
      scheduledIntervalDays: best.row.scheduledIntervalDays,
    },
  };
}

export type HouseholdNameResult =
  { status: 'ok'; name: string } | { status: 'unnamed' } | { status: 'unavailable' };

/**
 * The household's display name for the footer's "why am I getting this" line.
 *
 * Three states, kept apart on purpose: a name we read, a household row with no
 * name, and a read that failed. All three render a footer — the last two use a
 * phrasing that does not name the household — but only one of them is a fact,
 * and collapsing them would hide a failing read behind ordinary-looking copy.
 */
export async function readHouseholdName(householdId: string): Promise<HouseholdNameResult> {
  try {
    const household = await householdService.getHousehold(householdId);
    return household?.name ? { status: 'ok', name: household.name } : { status: 'unnamed' };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, householdId, msg: 'digest.household_name_read_failed' },
      'digest.household_name_read_failed'
    );
    return { status: 'unavailable' };
  }
}

/**
 * Assemble everything one household's digest needs. Called once per
 * household, then rendered once per recipient.
 */
export async function gatherDigestReport(
  householdId: string,
  now: Date = new Date(),
  /**
   * The at-risk result, when the caller already has one.
   *
   * `digestHousehold` reads it first and on its own (#459): it is two queries
   * and it decides whether the household has anything worth mailing at all,
   * so paying for it once instead of twice is the whole point of gating on it
   * early. Omitted, this reads it here exactly as before.
   *
   * Since #580 it also carries the household's active plants, so the saving
   * survives the hoist: handing this in removes the plants Query from the pet
   * section too, rather than moving it. An `AtRiskResult` without them still
   * works — the pet section reads for itself.
   */
  precomputedAtRisk?: AtRiskResult
): Promise<DigestReport> {
  const atRisk = precomputedAtRisk ?? (await gatherAtRisk(householdId, now));
  const listed = atRisk.status === 'ok' ? atRisk.rows.slice(0, TOP_PLANTS) : [];
  // The active plants the at-risk read already paid for, handed to the pet
  // section instead of it querying the same partition again (#580). Undefined
  // when the caller supplied an `AtRiskResult` that carries none — the pet
  // section then reads for itself, exactly as before.
  const activePlants = atRisk.status === 'ok' ? atRisk.activePlants : undefined;

  const name = await readHouseholdName(householdId);
  const householdName = name.status === 'ok' ? name.name : null;

  const awayUserIds = new Set<string>();
  const coverage = new Map<string, CoverageInfo>();
  try {
    const vacations = await taskService.getActiveVacationMap(householdId, now);
    for (const [userId, window] of vacations) {
      awayUserIds.add(userId);
      coverage.set(userId, {
        coverName: window.coveredByName,
        awayName: null,
      });
    }
  } catch (err) {
    // Nothing renders from an empty coverage map beyond an omitted
    // parenthetical, and the away set only ever REMOVES recipients — failing
    // to read it cannot silence anyone who should have been mailed.
    logger.warn(
      { err: (err as Error).message, householdId, msg: 'digest.vacation_read_failed' },
      'digest.vacation_read_failed'
    );
  }

  const [lastCare, weather, trend, pets, drift] = await Promise.all([
    gatherLastCare(householdId, listed, now),
    gatherWeather(householdId),
    gatherTrend(householdId),
    gatherPetWarnings(householdId, listed, activePlants),
    gatherScheduleDrift(householdId, listed),
  ]);

  return {
    householdId,
    householdName,
    atRisk,
    lastCare,
    weather,
    trend,
    pets,
    drift,
    awayUserIds,
    coverage,
  };
}

/**
 * True when this report is worth an email at all.
 *
 * Two ways to earn a send: there is something to DO (an at-risk plant), or a
 * read failed and the recipient deserves to know their silence is not an
 * all-clear. A trend line and a weather tip on their own are not worth
 * anyone's Monday. Everything else is skipped, and the caller logs why —
 * a cheerful nothing is worse than no email.
 */
export function digestIsWorthSending(report: DigestReport): boolean {
  if (atRiskIsWorthSending(report.atRisk)) return true;
  return report.pets.status === 'unavailable';
}

/**
 * The half of `digestIsWorthSending` that can be answered from the at-risk
 * read alone — two DynamoDB queries, against the ~13 a whole report costs.
 *
 * `digestHousehold` gates on this BEFORE gathering anything else (#459), which
 * is what makes a household with nothing at risk cost two reads a run instead
 * of thirteen. The `pets` clause left behind in `digestIsWorthSending` cannot
 * change the answer for a household this rejects: `gatherPetWarnings` returns
 * `{ status: 'ok' }` without reading anything when there are no listed rows,
 * and there are no listed rows exactly when this returns false.
 */
export function atRiskIsWorthSending(atRisk: AtRiskResult): boolean {
  if (atRisk.status !== 'ok') return true;
  return atRisk.rows.length > 0;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface DigestRecipient {
  userId: string;
  name: string | null;
  locale: EmailLocale;
  /** One-click unsubscribe capability URL, or null when unavailable. */
  unsubscribeUrl: string | null;
}

function taskLabel(locale: EmailLocale, row: Pick<AtRiskRow, 'taskType' | 'customLabel'>): string {
  if (row.taskType === 'custom') {
    // A custom task with no label used to render the literal string "custom"
    // as if it were the task's name.
    return row.customLabel?.trim() || t(locale, 'taskType.custom');
  }
  return t(locale, `taskType.${row.taskType}`);
}

function overdueLine(locale: EmailLocale, row: AtRiskRow): string {
  const task = taskLabel(locale, row);
  if (row.daysOverdue === null) return t(locale, 'digest.dueUnknown', { task });
  if (row.daysOverdue <= 0) return t(locale, 'digest.dueToday', { task });
  return tn(locale, 'digest.overdue', row.daysOverdue, { task });
}

function lastCareLine(
  locale: EmailLocale,
  care: LastCare | undefined,
  recipientUserId: string
): string | null {
  if (!care) return null;
  if (care.status === 'unavailable') return t(locale, 'digest.lastCare.unavailable');
  if (care.status === 'none') return t(locale, 'digest.lastCare.never');
  const when = formatDaysAgo(locale, care.daysAgo);
  if (care.byUserId === recipientUserId) return t(locale, 'digest.lastCare.byYou', { when });
  if (!care.byName) return null;
  return t(locale, 'digest.lastCare.by', { name: care.byName, when });
}

function assignmentLine(locale: EmailLocale, report: DigestReport, row: AtRiskRow): string | null {
  if (row.unclaimed) return t(locale, 'digest.assigned.nobody');
  if (!row.assignedTo) return null;
  const cover = report.coverage.get(row.assignedTo);
  if (cover?.coverName && row.assignedToName) {
    // Never point a plant at someone who is away when a cover is set.
    return t(locale, 'digest.assigned.covering', {
      cover: cover.coverName,
      away: row.assignedToName,
    });
  }
  if (!row.assignedToName) return null;
  return t(locale, 'digest.assigned.to', { name: row.assignedToName });
}

/**
 * The schedule-drift section: a heading and one row naming the plant, the two
 * intervals, and where to change it. Returns `[]` for every state except a
 * real finding — see `DriftResult` for why the failure states say nothing.
 *
 * The link is `taskUrl`, so the tap lands on the plant page carrying the task
 * id, which is where the one-tap "match schedule to reality" already lives.
 * The email deliberately does not carry the action itself: changing a
 * household's schedule from an unauthenticated email click would need a
 * capability token, and this is a suggestion, not a chore.
 */
function driftBlocks(locale: EmailLocale, drift: DriftResult): EmailBlock[] {
  if (drift.status !== 'ok' || !drift.finding) return [];
  const finding = drift.finding;
  return [
    { kind: 'heading', text: t(locale, 'digest.driftHeading') },
    {
      kind: 'row',
      title: finding.plantName,
      href: taskUrl(finding.plantId, finding.taskId),
      lines: [
        t(locale, 'digest.drift.line', {
          task: taskLabel(locale, finding),
          actual: tn(locale, 'digest.drift.everyDays', finding.actualIntervalDays),
          scheduled: tn(locale, 'digest.drift.everyDays', finding.scheduledIntervalDays),
        }),
        t(locale, 'digest.drift.cta'),
      ],
    },
  ];
}

function trendBlock(locale: EmailLocale, trend: TrendResult): EmailBlock | null {
  if (trend.status === 'unavailable') {
    return { kind: 'notice', text: t(locale, 'digest.trend.unavailable') };
  }
  // Two zeroes is real data and says nothing useful; a line about it would be
  // guilt, not information. This is not an absent read being hidden — the read
  // succeeded, and its own failure path is the notice above.
  if (trend.last7 === 0 && trend.prev7 === 0) return null;
  const vars = {
    now: formatCount(locale, trend.last7),
    before: formatCount(locale, trend.prev7),
  };
  const key =
    trend.last7 > trend.prev7
      ? 'digest.trend.up'
      : trend.last7 < trend.prev7
        ? 'digest.trend.down'
        : 'digest.trend.steady';
  return { kind: 'text', text: t(locale, key, vars), tone: 'muted' };
}

/**
 * Render one household's report for one recipient.
 *
 * The subject reports the TRUE at-risk total, not the number of rows listed.
 * That property is preserved from the previous implementation and must stay:
 * counting the listed rows under-reported every household with more than five
 * neglected plants, and under-reporting is the dangerous direction for a care
 * product — it reassures precisely the households that most need the nudge.
 */
export function composeDigestEmail(
  report: DigestReport,
  recipient: DigestRecipient
): { subject: string; text: string; html: string; headers?: Record<string, string> } {
  const locale = recipient.locale;
  const atRisk = report.atRisk;
  const atRiskOk = atRisk.status === 'ok';
  const rows: AtRiskRow[] = atRisk.status === 'ok' ? atRisk.rows : [];
  const total = rows.length;
  const listed = rows.slice(0, TOP_PLANTS);
  const unclaimed = rows.filter((row) => row.unclaimed).length;

  const subject = atRiskOk
    ? tn(locale, 'digest.subject', total)
    : t(locale, 'digest.subject.unknown');

  const preheader = !atRiskOk
    ? t(locale, 'digest.preheader.unknown')
    : unclaimed > 0
      ? tn(locale, 'digest.preheader.grabs', unclaimed)
      : t(locale, 'digest.preheader.default');

  const blocks: EmailBlock[] = [
    {
      kind: 'text',
      text: recipient.name?.trim()
        ? t(locale, 'digest.greeting', { name: recipient.name.trim() })
        : t(locale, 'digest.greetingGeneric'),
    },
  ];

  // Lead with what is fine.
  if (atRisk.status === 'ok' && atRisk.onTrack > 0) {
    blocks.push({
      kind: 'text',
      text:
        total === 0 ? t(locale, 'digest.onTrackAll') : tn(locale, 'digest.onTrack', atRisk.onTrack),
    });
  }

  const trend = trendBlock(locale, report.trend);
  if (trend) blocks.push(trend);

  if (!atRiskOk) {
    blocks.push({ kind: 'notice', text: t(locale, 'digest.atRisk.unavailable') });
  } else if (listed.length > 0) {
    blocks.push({ kind: 'heading', text: t(locale, 'digest.needHandHeading') });
    for (const row of listed) {
      const lines = [
        overdueLine(locale, row),
        lastCareLine(locale, report.lastCare.get(row.plantId), recipient.userId),
        assignmentLine(locale, report, row),
      ].filter((line): line is string => line !== null);
      blocks.push({
        kind: 'row',
        title: row.plantName,
        href: taskUrl(row.plantId, row.taskId),
        lines,
        imageUrl: row.imageUrl,
        badge: row.unclaimed ? t(locale, 'digest.upForGrabs') : null,
      });
    }
    if (total > listed.length) {
      blocks.push({
        kind: 'text',
        text: tn(locale, 'digest.moreWaiting', total - listed.length),
        tone: 'muted',
      });
    }
  }

  // After the list, before the CTA: the reading explains the rows above it.
  blocks.push(...driftBlocks(locale, report.drift));

  blocks.push({ kind: 'button', label: t(locale, 'digest.cta'), href: tasksUrl() });

  if (report.weather.status === 'unavailable') {
    blocks.push({ kind: 'notice', text: t(locale, 'digest.weather.unavailable') });
  } else if (report.weather.status === 'ok') {
    blocks.push({ kind: 'heading', text: t(locale, 'digest.weatherHeading') });
    for (const tip of report.weather.tips) {
      blocks.push({ kind: 'text', text: tip, tone: 'muted' });
    }
  }

  if (report.pets.status === 'unavailable') {
    blocks.push({ kind: 'notice', text: t(locale, 'digest.pet.unavailable') });
  } else if (report.pets.warnings.length > 0) {
    blocks.push({ kind: 'heading', text: t(locale, 'digest.petHeading') });
    for (const warning of report.pets.warnings) {
      blocks.push({
        kind: 'row',
        title: warning.plantName,
        href: plantUrl(warning.plantId),
        lines: [
          t(locale, 'digest.pet.line', {
            plant: warning.plantName,
            pets: t(locale, `digest.pet.${warning.pets}`),
          }),
        ],
      });
    }
  }

  blocks.push({ kind: 'text', text: t(locale, 'digest.closing'), tone: 'muted' });

  const links = [{ label: t(locale, 'footer.manage'), href: settingsUrl() }];
  if (recipient.unsubscribeUrl) {
    links.push({ label: t(locale, 'footer.unsubscribe'), href: recipient.unsubscribeUrl });
  }

  const { html, text } = renderEmail({
    locale,
    title: t(locale, 'digest.title'),
    preheader,
    blocks,
    footer: {
      reason: report.householdName
        ? t(locale, 'footer.reason.household', { household: report.householdName })
        : t(locale, 'footer.reason.householdGeneric'),
      safety: t(locale, 'footer.safety'),
      links,
    },
  });

  const headers = recipient.unsubscribeUrl
    ? {
        'List-Unsubscribe': `<${recipient.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      }
    : undefined;

  return { subject, text, html, headers };
}
