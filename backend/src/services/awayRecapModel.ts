/**
 * Away Kit return recap — the pure half (no AWS, no I/O). Picks which link
 * to recap, bounds its window, and folds sitter-attributed activity events
 * into the recap shape. Shared by the Lambda service (awayRecapService.ts,
 * which adds the DynamoDB read) and the mock dev server, so the two can't
 * drift on what a recap contains.
 */
import type { ActivityEvent } from './activity.js';
import type { SitterLink } from './sitterService.js';

export interface AwayRecapLink {
  id: string;
  label: string | null;
  startsAt: string;
  expiresAt: string;
  status: SitterLink['status'];
  /** True once the window has closed (expired) or the link was revoked. */
  ended: boolean;
}

export interface AwayRecapTask {
  taskId: string;
  plantId: string;
  plantName: string | null;
  taskType: string;
  occurredAt: string;
  /** Always the sitter's synthetic display name — a sitter has no account. */
  actorName: string;
  notes: string | null;
}

export interface AwayRecapPhoto {
  photoId: string;
  plantId: string;
  plantName: string | null;
  /** Null for a legacy row written before the URL rode on the event. */
  imageUrl: string | null;
  caption: string | null;
  occurredAt: string;
}

export interface AwayRecapNote {
  source: 'photo' | 'task';
  plantId: string;
  plantName: string | null;
  text: string;
  occurredAt: string;
}

export interface AwayRecap {
  link: AwayRecapLink;
  /** The slice of time the recap covers: link start → min(expiry, now). */
  window: { from: string; to: string };
  tasksCompleted: AwayRecapTask[];
  photos: AwayRecapPhoto[];
  notes: AwayRecapNote[];
  counts: { tasks: number; photos: number; notes: number };
  /** True when the activity scan hit its cap — the lists above are a prefix,
   *  not the whole story, and the UI must say so. */
  truncated: boolean;
  generatedAt: string;
}

function isoNow(now: Date): string {
  return now.toISOString();
}

export function linkHasEnded(link: SitterLink, now: Date): boolean {
  return link.status === 'revoked' || link.expiresAt <= isoNow(now);
}

/**
 * Choose which link to recap. An explicit id wins (any state — a household
 * may want to peek at an in-progress window). Otherwise the most recently
 * ENDED link: the one whose window closed last, revoked links counted as
 * ending at whichever came first of their expiry and now. Null when nothing
 * has ended yet — the handler turns that into an explicit 404, not an empty
 * recap.
 */
export function pickRecapLink(
  links: SitterLink[],
  linkId: string | undefined,
  now: Date
): SitterLink | null {
  if (linkId) return links.find((l) => l.id === linkId) ?? null;
  const nowIso = isoNow(now);
  const ended = links.filter((l) => linkHasEnded(l, now));
  if (ended.length === 0) return null;
  const endedAt = (l: SitterLink) => (l.expiresAt < nowIso ? l.expiresAt : nowIso);
  ended.sort((a, b) => {
    const byEnd = endedAt(b).localeCompare(endedAt(a));
    return byEnd !== 0 ? byEnd : b.createdAt.localeCompare(a.createdAt);
  });
  return ended[0];
}

export function recapWindow(link: SitterLink, now: Date): { from: string; to: string } {
  const nowIso = isoNow(now);
  return { from: link.startsAt, to: link.expiresAt < nowIso ? link.expiresAt : nowIso };
}

/**
 * A sitter completion lands on the activity partition twice: the durable
 * TaskCompletion row (folded into a `task.completed` envelope by
 * activity.itemToActivityEvent) and the typed ActivityEvent the route
 * records right after it. Keep one per (taskId, ~same moment): prefer the
 * typed event, which carries `viaSitter`, and fall back to the completion
 * row when the best-effort event write was lost.
 */
const DUPLICATE_WINDOW_MS = 10_000;

export function dedupeCompletions(events: ActivityEvent[]): ActivityEvent[] {
  const typed = events.filter(
    (e) => e.type === 'task.completed' && (e.payload as { viaSitter?: boolean }).viaSitter === true
  );
  return events.filter((e) => {
    if (e.type !== 'task.completed') return true;
    const payload = e.payload as { viaSitter?: boolean; taskId: string };
    if (payload.viaSitter === true) return true;
    const t = Date.parse(e.occurredAt);
    const twin = typed.find(
      (candidate) =>
        (candidate.payload as { taskId: string }).taskId === payload.taskId &&
        Math.abs(Date.parse(candidate.occurredAt) - t) <= DUPLICATE_WINDOW_MS
    );
    return twin === undefined;
  });
}

/** Assemble the recap from the link and its (already actor-filtered) events. */
export function buildAwayRecap(
  link: SitterLink,
  events: ActivityEvent[],
  truncated: boolean,
  now: Date
): AwayRecap {
  const tasksCompleted: AwayRecapTask[] = [];
  const photos: AwayRecapPhoto[] = [];
  const notes: AwayRecapNote[] = [];

  const ordered = [...dedupeCompletions(events)].sort((a, b) =>
    a.occurredAt.localeCompare(b.occurredAt)
  );

  for (const event of ordered) {
    if (event.type === 'task.completed') {
      const p = event.payload;
      const note = typeof p.notes === 'string' && p.notes.trim() ? p.notes.trim() : null;
      tasksCompleted.push({
        taskId: p.taskId,
        plantId: p.plantId,
        plantName: p.plantName ?? null,
        taskType: p.taskType,
        occurredAt: event.occurredAt,
        actorName: event.actorName,
        notes: note,
      });
      if (note) {
        notes.push({
          source: 'task',
          plantId: p.plantId,
          plantName: p.plantName ?? null,
          text: note,
          occurredAt: event.occurredAt,
        });
      }
    } else if (event.type === 'photo.uploaded') {
      const p = event.payload;
      const caption = typeof p.caption === 'string' && p.caption.trim() ? p.caption.trim() : null;
      photos.push({
        photoId: p.photoId,
        plantId: p.plantId,
        plantName: p.plantName ?? null,
        imageUrl: p.imageUrl ?? null,
        caption,
        occurredAt: event.occurredAt,
      });
      if (caption) {
        notes.push({
          source: 'photo',
          plantId: p.plantId,
          plantName: p.plantName ?? null,
          text: caption,
          occurredAt: event.occurredAt,
        });
      }
    }
  }

  return {
    link: {
      id: link.id,
      label: link.label,
      startsAt: link.startsAt,
      expiresAt: link.expiresAt,
      status: link.status,
      ended: linkHasEnded(link, now),
    },
    window: recapWindow(link, now),
    tasksCompleted,
    photos,
    notes,
    counts: { tasks: tasksCompleted.length, photos: photos.length, notes: notes.length },
    truncated,
    generatedAt: isoNow(now),
  };
}
