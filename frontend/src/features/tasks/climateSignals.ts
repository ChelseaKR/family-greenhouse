/**
 * Derives cheap, machine-readable signals from the household climate query
 * for the one-tap "skip this cycle" suggestions on task rows.
 *
 * The backend's ClimateTip list is prose (message strings), so instead of
 * sniffing tip text we re-derive the two signals we need from the raw
 * weather snapshot using the SAME thresholds as the backend's
 * deriveClimateTips (services/climate.ts): rain/storm in the current
 * condition, and a forecast low under 5°C. No new endpoints — this reads
 * the existing `['household', hh, 'climate']` query result.
 */
import type { ClimateResponse } from '@/services/climateService';
import type { SnoozeReason } from '@/services/taskService';

export interface ClimateSignals {
  /** Rain or storm in the current conditions — outdoor watering is free today. */
  rainSoon: boolean;
  /** Tonight's low is under 5°C — don't water outdoor plants before a freeze. */
  frostSoon: boolean;
}

export const NO_SIGNALS: ClimateSignals = { rainSoon: false, frostSoon: false };

export function deriveClimateSignals(climate: ClimateResponse | undefined): ClimateSignals {
  if (!climate?.weather) return NO_SIGNALS;
  const condition = climate.weather.condition?.toLowerCase() ?? '';
  const rainSoon = condition.includes('rain') || condition.includes('storm');
  // Mirror the backend: today's forecast low, falling back to the current temp.
  const todayLow = climate.weather.forecast?.[0]?.minC ?? climate.weather.tempC;
  return { rainSoon, frostSoon: todayLow < 5 };
}

/** Due (or overdue) within the next `hours`. Invalid dates never match. */
export function isDueWithinHours(nextDue: string, hours: number, now: Date = new Date()): boolean {
  const due = new Date(nextDue).getTime();
  if (Number.isNaN(due)) return false;
  return due <= now.getTime() + hours * 60 * 60 * 1000;
}

interface SkippableTask {
  type: string;
  nextDue: string;
}

/**
 * Which climate skip suggestion (if any) applies to a task:
 *   - 'rain'  — water task due within 48h while rain is expected
 *   - 'frost' — water task due within 48h on an *outdoor-tagged* plant
 *               while a freeze is expected (skipped entirely when the plant
 *               isn't tagged 'outdoor')
 */
export function climateSkipSuggestion(
  task: SkippableTask,
  plantTags: string[] | undefined,
  signals: ClimateSignals,
  now: Date = new Date()
): Extract<SnoozeReason, 'rain' | 'frost'> | null {
  if (task.type !== 'water' || !isDueWithinHours(task.nextDue, 48, now)) return null;
  if (signals.rainSoon) return 'rain';
  if (signals.frostSoon && plantTags?.includes('outdoor')) return 'frost';
  return null;
}
