/**
 * Maps Perenual's coarse watering bands to integer day frequencies that the
 * task scheduler understands. The mapping lives here (not inline in the
 * handler) so we can tune it from telemetry — e.g. if users override the
 * suggested cadence >40% of the time, this is the dial to turn first.
 *
 * The bands are intentionally generous; the goal is "not obviously wrong",
 * not "perfect cadence for your humidity / pot / season". Users can edit
 * the resulting task; we treat the suggestion as a starting point.
 */
import type { PerenualSpeciesDetail } from './perenual.js';

export interface CareSuggestion {
  wateringDays: number | null;
  sunlight: string[];
  summary: string;
}

const WATERING_DAYS: Record<NonNullable<PerenualSpeciesDetail['watering']>, number | null> = {
  frequent: 3,
  average: 7,
  minimum: 14,
  none: null,
};

export function deriveCareSuggestion(detail: PerenualSpeciesDetail): CareSuggestion {
  const wateringDays = detail.watering ? WATERING_DAYS[detail.watering] : null;
  const sunlight = detail.sunlight.slice(0, 3);

  const parts: string[] = [];
  if (wateringDays === null) {
    parts.push('No regular watering needed.');
  } else if (wateringDays <= 4) {
    parts.push(`Water roughly every ${wateringDays} days.`);
  } else {
    parts.push(`Water about every ${wateringDays} days.`);
  }
  if (sunlight.length > 0) {
    parts.push(`Light: ${sunlight.join(', ')}.`);
  }
  if (detail.poisonousToPets) {
    parts.push('Toxic to pets — keep out of reach.');
  }

  return {
    wateringDays,
    sunlight,
    summary: parts.join(' '),
  };
}
