/**
 * Seasonal care cadences — the PURE half. No I/O and no AWS imports, so both
 * `taskService` (which advances the schedule) and `doubleCare` (which measures
 * drift against it) can call it without an import cycle, and the frontend can
 * mirror it byte for byte (`frontend/src/features/tasks/seasonalCadence.ts`).
 *
 * ## The problem
 *
 * A task carries ONE `frequency`, so "every 7 days" is wrong for half the
 * year: most houseplants slow down in the dormant season and the same interval
 * that keeps a Monstera alive in July drowns it in January. Households
 * compensate by hand, which the schedule then reports as drift
 * (`doubleCareRules.computeScheduleDrift`) — the app calling a correct winter
 * interval a mistake.
 *
 * A seasonal profile is up to four cadences, one per season, and the schedule
 * advances by whichever is in force on the completion date.
 *
 * ## Seasons are named, not dated — and that is the whole hemisphere story
 *
 * A cadence names a SEASON (`winter`), never a month range. The month range is
 * derived, and the derivation is the only thing the hemisphere changes:
 *
 *   - north — meteorological seasons, the ordinary convention:
 *     Mar–May spring, Jun–Aug summer, Sep–Nov autumn, Dec–Feb winter.
 *   - south — the same table read six months out of phase.
 *
 * Storing the season rather than the months is what makes the household's
 * location a *read-time* input instead of a migration. A family that moves
 * from Berlin to Melbourne changes its household location and every seasonal
 * profile it has follows, with no row rewritten and no month re-entered. It
 * also removes the class of bug where a stored "Nov–Feb: every 14 days" means
 * the dormant season in one hemisphere and the growing season in the other,
 * with nothing in the row able to say which was meant.
 *
 * Meteorological (whole calendar months) rather than astronomical (equinox to
 * solstice) because a cadence changes on a date the household can read off a
 * calendar without an ephemeris, and because the boundary is stable year to
 * year. Both conventions put 15 Nov in the northern dormant half and 15 May in
 * the northern growing half, which is the behaviour the product needs.
 *
 * ## A profile never invents an answer
 *
 * `resolveCadence` always returns a real number of days, because a completion
 * must always advance the schedule. What it will not do is pretend to know
 * why. Every fall back to the task's base `frequency` carries a `reason` —
 * `no_profile`, `no_location`, `household_unavailable`, `season_unset` — and
 * `season` stays `null` rather than being guessed. ADR 0010's rule for reads
 * applies to this write: a household with no location is not a household in
 * the northern hemisphere, and a failed household read is not a household with
 * no location. The UI shows the difference (`seasons unavailable — set a
 * location`); the drift math needs it; and `household_unavailable` exists
 * precisely so a transient DynamoDB failure can never be recorded as a settled
 * fact about the household.
 */

/** Meteorological seasons, in calendar order from the northern spring. */
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;

export type Season = (typeof SEASONS)[number];

export type Hemisphere = 'north' | 'south';

/** One season's interval, in days. */
export interface SeasonalCadence {
  season: Season;
  /** Days between occurrences while this season is in force. 1–365. */
  frequency: number;
}

/** One per season and no more — the four seasons are the whole domain. */
export const MAX_SEASONAL_CADENCES = SEASONS.length;

/**
 * Northern-hemisphere meteorological season by zero-based month index, the
 * same indexing `Date.prototype.getMonth` uses.
 */
const NORTHERN_SEASON_BY_MONTH: readonly Season[] = [
  'winter', // 0  January
  'winter', // 1  February
  'spring', // 2  March
  'spring', // 3  April
  'spring', // 4  May
  'summer', // 5  June
  'summer', // 6  July
  'summer', // 7  August
  'autumn', // 8  September
  'autumn', // 9  October
  'autumn', // 10 November
  'winter', // 11 December
];

/** Half a year: the offset that turns the northern table into the southern one. */
const HEMISPHERE_MONTH_OFFSET = 6;

/**
 * The household's hemisphere from its stored location, or `null` when it has
 * none.
 *
 * Latitude exactly 0 reads as `north`, matching the shipped
 * `frontend/src/features/plants/seasonalHomes.ts` (`latitude < 0` inverts).
 * Two helpers disagreeing about the equator would be a worse bug than either
 * answer, and a household on the equator has no dormant season for a cadence
 * to describe in the first place.
 */
export function hemisphereForLocation(
  location: { lat?: unknown } | null | undefined
): Hemisphere | null {
  const lat = location?.lat;
  if (typeof lat !== 'number' || !Number.isFinite(lat)) return null;
  return lat < 0 ? 'south' : 'north';
}

/** The season a zero-based month index falls in, for one hemisphere. */
export function seasonForMonth(hemisphere: Hemisphere, monthIndex: number): Season {
  const normalized = ((Math.trunc(monthIndex) % 12) + 12) % 12;
  const shifted = hemisphere === 'south' ? (normalized + HEMISPHERE_MONTH_OFFSET) % 12 : normalized;
  return NORTHERN_SEASON_BY_MONTH[shifted];
}

/** Why `resolveCadence` used the task's base frequency instead of a cadence. */
export type CadenceReason =
  /** The task carries no seasonal profile. Every task today. */
  | 'no_profile'
  /** The task has a profile but the household has no location to season it by. */
  | 'no_location'
  /** The household row could not be read. NOT the same as having no location. */
  | 'household_unavailable'
  /** Hemisphere known, but the profile has no entry for the current season. */
  | 'season_unset';

export interface CadenceResolution {
  /** Days to add on completion. Always a real number — a schedule must advance. */
  frequency: number;
  /** Whether `frequency` came from the profile or from the task's own field. */
  source: 'seasonal' | 'base';
  /** The season in force, or `null` when it could not be determined. */
  season: Season | null;
  /** Null exactly when `source === 'seasonal'`. Never a silent fallback. */
  reason: CadenceReason | null;
}

/**
 * The cadence in force for a task at an instant.
 *
 * `baseFrequency` is the task's own `frequency`, used whenever the profile
 * cannot answer. `hemisphere` is `null` for a household with no location, and
 * callers pass `'household_unavailable'` through `unavailableReason` when the
 * household could not be READ — the two produce different `reason`s and the
 * UI says different things about them.
 */
export function resolveCadence(
  baseFrequency: number,
  cadences: readonly SeasonalCadence[] | null | undefined,
  hemisphere: Hemisphere | null,
  at: Date,
  unavailableReason: 'no_location' | 'household_unavailable' = 'no_location'
): CadenceResolution {
  if (!cadences || cadences.length === 0) {
    return { frequency: baseFrequency, source: 'base', season: null, reason: 'no_profile' };
  }
  if (hemisphere === null) {
    return { frequency: baseFrequency, source: 'base', season: null, reason: unavailableReason };
  }

  const season = seasonForMonth(hemisphere, at.getMonth());
  const match = cadences.find((c) => c.season === season);
  if (!match) {
    // The season IS known — report it, so the UI can say "no autumn cadence
    // set" rather than the vaguer "seasons unavailable".
    return { frequency: baseFrequency, source: 'base', season, reason: 'season_unset' };
  }

  return { frequency: match.frequency, source: 'seasonal', season, reason: null };
}

/**
 * The first instant at which `resolveCadence` would return a different
 * `frequency`, or `null` if it never would within a year.
 *
 * This is what the task's chip counts down to ("every 14 days · winter cadence
 * until 1 Mar"), and it deliberately tracks the CADENCE rather than the
 * season: a profile of 7/7/14/14 changes twice a year, not four times, and
 * telling the household its cadence changes on 1 Jun when the number does not
 * move would be noise. Returned as the first day of the month the change lands
 * in, at local midnight — the same granularity the seasons themselves have.
 */
export function nextCadenceChange(
  baseFrequency: number,
  cadences: readonly SeasonalCadence[] | null | undefined,
  hemisphere: Hemisphere | null,
  at: Date
): Date | null {
  const current = resolveCadence(baseFrequency, cadences, hemisphere, at);
  if (hemisphere === null || !cadences || cadences.length === 0) return null;

  // Walk month starts for a full year. Twelve steps is the whole domain: the
  // season table repeats annually, so a frequency that has not moved in twelve
  // months never moves.
  for (let step = 1; step <= 12; step++) {
    const probe = new Date(at.getFullYear(), at.getMonth() + step, 1, 0, 0, 0, 0);
    const next = resolveCadence(baseFrequency, cadences, hemisphere, probe);
    if (next.frequency !== current.frequency) return probe;
  }
  return null;
}

/**
 * Validation shared by the API schema and the importer: at most one cadence
 * per season. Returns the duplicate season names, empty when the list is fine.
 */
export function duplicateSeasons(cadences: readonly SeasonalCadence[]): Season[] {
  const seen = new Set<Season>();
  const dupes = new Set<Season>();
  for (const cadence of cadences) {
    if (seen.has(cadence.season)) dupes.add(cadence.season);
    seen.add(cadence.season);
  }
  return [...dupes];
}
