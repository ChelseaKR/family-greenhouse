/**
 * Seasonal care cadences — the client mirror of
 * `backend/src/services/seasonalCadence.ts`.
 *
 * Mirrored rather than fetched, for the same reason
 * `features/plants/seasonalHomes.ts` computes the season in the browser: the
 * household's location is already in the client's cache, the answer is a pure
 * function of it and the clock, and a per-task server round-trip to be told
 * "winter" would be a request per row of the task list.
 *
 * The two copies are kept honest by their shared subject rather than by
 * codegen: both are driven by the same table, and `seasonalCadence.test.ts` on
 * each side asserts the same month→season mapping. If they ever disagree the
 * server wins — it is the one that advances the schedule; this file only
 * decides what the chip says.
 *
 * Absence is never rendered as a value here either. A household with no
 * location does not silently get northern seasons: `resolveCadence` reports
 * `season: null` with `reason: 'no_location'`, and the UI offers to set one.
 */

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;

export type Season = (typeof SEASONS)[number];

export type Hemisphere = 'north' | 'south';

export interface SeasonalCadence {
  season: Season;
  frequency: number;
}

export const MAX_SEASONAL_CADENCES = SEASONS.length;

/** Northern meteorological season by zero-based month index. */
const NORTHERN_SEASON_BY_MONTH: readonly Season[] = [
  'winter', // Jan
  'winter', // Feb
  'spring', // Mar
  'spring', // Apr
  'spring', // May
  'summer', // Jun
  'summer', // Jul
  'summer', // Aug
  'autumn', // Sep
  'autumn', // Oct
  'autumn', // Nov
  'winter', // Dec
];

const HEMISPHERE_MONTH_OFFSET = 6;

/** Latitude 0 reads north, matching `features/plants/seasonalHomes.ts`. */
export function hemisphereForLatitude(latitude: number | null | undefined): Hemisphere | null {
  if (typeof latitude !== 'number' || !Number.isFinite(latitude)) return null;
  return latitude < 0 ? 'south' : 'north';
}

export function seasonForMonth(hemisphere: Hemisphere, monthIndex: number): Season {
  const normalized = ((Math.trunc(monthIndex) % 12) + 12) % 12;
  const shifted = hemisphere === 'south' ? (normalized + HEMISPHERE_MONTH_OFFSET) % 12 : normalized;
  return NORTHERN_SEASON_BY_MONTH[shifted];
}

export type CadenceReason = 'no_profile' | 'no_location' | 'season_unset';

export interface CadenceResolution {
  frequency: number;
  source: 'seasonal' | 'base';
  season: Season | null;
  reason: CadenceReason | null;
}

export function resolveCadence(
  baseFrequency: number,
  cadences: readonly SeasonalCadence[] | null | undefined,
  hemisphere: Hemisphere | null,
  at: Date = new Date()
): CadenceResolution {
  if (!cadences || cadences.length === 0) {
    return { frequency: baseFrequency, source: 'base', season: null, reason: 'no_profile' };
  }
  if (hemisphere === null) {
    return { frequency: baseFrequency, source: 'base', season: null, reason: 'no_location' };
  }
  const season = seasonForMonth(hemisphere, at.getMonth());
  const match = cadences.find((c) => c.season === season);
  if (!match) {
    return { frequency: baseFrequency, source: 'base', season, reason: 'season_unset' };
  }
  return { frequency: match.frequency, source: 'seasonal', season, reason: null };
}

/**
 * The first day of the month on which the resolved cadence changes, or null.
 * Tracks the NUMBER, not the season — a 7/7/14/14 profile changes twice a
 * year, and telling the household otherwise would be noise.
 */
export function nextCadenceChange(
  baseFrequency: number,
  cadences: readonly SeasonalCadence[] | null | undefined,
  hemisphere: Hemisphere | null,
  at: Date = new Date()
): Date | null {
  if (hemisphere === null || !cadences || cadences.length === 0) return null;
  const current = resolveCadence(baseFrequency, cadences, hemisphere, at);
  for (let step = 1; step <= 12; step++) {
    const probe = new Date(at.getFullYear(), at.getMonth() + step, 1, 0, 0, 0, 0);
    if (
      resolveCadence(baseFrequency, cadences, hemisphere, probe).frequency !== current.frequency
    ) {
      return probe;
    }
  }
  return null;
}
