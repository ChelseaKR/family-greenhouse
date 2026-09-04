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
import type { Plant, PlantSpace, Task } from '../models/types.js';
import { logger } from '../utils/logger.js';
import * as climate from './climate.js';
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
 */
export async function gatherPetWarnings(
  householdId: string,
  rows: AtRiskRow[]
): Promise<PetResult> {
  if (rows.length === 0) return { status: 'ok', warnings: [] };
  let spaces: PlantSpace[];
  let plants: Plant[];
  try {
    spaces = await spaceService.getSpaces(householdId);
    plants = await plantService.getPlants(householdId, 'active');
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
  now: Date = new Date()
): Promise<DigestReport> {
  const atRisk = await gatherAtRisk(householdId, now);
  const listed = atRisk.status === 'ok' ? atRisk.rows.slice(0, TOP_PLANTS) : [];

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

  const [lastCare, weather, trend, pets] = await Promise.all([
    gatherLastCare(householdId, listed, now),
    gatherWeather(householdId),
    gatherTrend(householdId),
    gatherPetWarnings(householdId, listed),
  ]);

  return {
    householdId,
    householdName,
    atRisk,
    lastCare,
    weather,
    trend,
    pets,
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
  if (report.atRisk.status !== 'ok') return true;
  if (report.atRisk.rows.length > 0) return true;
  return report.pets.status === 'unavailable';
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

function taskLabel(locale: EmailLocale, row: AtRiskRow): string {
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
