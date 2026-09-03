/**
 * Double-care detection — client-side helpers (brief §4.7). The server
 * decides whether a completion duplicates another member's; the client only
 * recognises that answer and words it. Pure functions, unit-tested.
 */
import axios from 'axios';

export interface DuplicateCare {
  completionId: string;
  completedAt: string;
  completedBy: string;
  completedByName: string;
  taskId: string;
  taskType: string;
  /** true = the very same task; false = same plant + same care type, another task. */
  sameTask: boolean;
  windowHours: number;
}

export interface DuplicateCareDetails {
  code: 'DUPLICATE_CARE';
  plantName: string;
  duplicate: DuplicateCare;
}

/**
 * The structured 409 DUPLICATE_CARE body from `POST /tasks/:id/complete`, or
 * null for any other error. Strict on shape: a 409 that is not this contract
 * stays an ordinary error and is toasted as one.
 */
export function readDuplicateCare(error: unknown): DuplicateCareDetails | null {
  if (!axios.isAxiosError(error) || error.response?.status !== 409) return null;
  const details = (error.response.data as { details?: unknown } | undefined)?.details;
  if (!details || typeof details !== 'object') return null;
  const d = details as Partial<DuplicateCareDetails>;
  if (d.code !== 'DUPLICATE_CARE' || !d.duplicate || typeof d.duplicate !== 'object') return null;
  const dup = d.duplicate as Partial<DuplicateCare>;
  if (
    typeof dup.completionId !== 'string' ||
    typeof dup.completedAt !== 'string' ||
    typeof dup.completedByName !== 'string' ||
    typeof dup.taskType !== 'string'
  ) {
    return null;
  }
  return {
    code: 'DUPLICATE_CARE',
    plantName: typeof d.plantName === 'string' ? d.plantName : '',
    duplicate: {
      completionId: dup.completionId,
      completedAt: dup.completedAt,
      completedBy: typeof dup.completedBy === 'string' ? dup.completedBy : '',
      completedByName: dup.completedByName,
      taskId: typeof dup.taskId === 'string' ? dup.taskId : '',
      taskType: dup.taskType,
      sameTask: dup.sameTask === true,
      windowHours: typeof dup.windowHours === 'number' ? dup.windowHours : 0,
    },
  };
}

export type Elapsed = { unit: 'now' } | { unit: 'minutes' | 'hours' | 'days'; count: number };

/**
 * Coarse "how long ago" for the notice ("4 hours ago"). Null when the instant
 * is unparseable — the caller then omits the time rather than inventing one.
 */
export function describeElapsed(fromIso: string, now: Date = new Date()): Elapsed | null {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return null;
  const minutes = Math.round(Math.max(0, now.getTime() - from) / 60_000);
  if (minutes < 1) return { unit: 'now' };
  if (minutes < 60) return { unit: 'minutes', count: minutes };
  const hours = Math.round(minutes / 60);
  if (hours < 48) return { unit: 'hours', count: hours };
  return { unit: 'days', count: Math.round(hours / 24) };
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Words the server's answer: who, which care, which plant, how long ago. */
export function describeDuplicate(details: DuplicateCareDetails, t: Translate): string {
  const { duplicate } = details;
  const elapsed = describeElapsed(duplicate.completedAt);
  const when =
    elapsed === null
      ? ''
      : elapsed.unit === 'now'
        ? t('doubleCare.justNow')
        : t(`doubleCare.${elapsed.unit}Ago`, { count: elapsed.count });
  return t('doubleCare.message', {
    name: duplicate.completedByName,
    task: t(`tasks.types.${duplicate.taskType}`, { defaultValue: duplicate.taskType }),
    plant: details.plantName || t('activity.aPlant'),
    when,
  }).replace(/\s{2,}/g, ' ');
}
