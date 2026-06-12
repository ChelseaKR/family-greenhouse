/**
 * iCalendar (RFC 5545) feed builder for plant care tasks.
 *
 * Why we build this by hand instead of using a library: the spec is small
 * for our needs (VEVENT with summary + description + dtstart + RRULE),
 * the deps for the popular libraries are heavyweight, and our output
 * format is stable enough that hand-rolling stays in scope.
 *
 * Key decisions:
 *  - All-day events. Tasks don't have a clock time on them; landing them
 *    on a specific hour would be misleading.
 *  - ONE single-occurrence VEVENT per task at its current nextDue — no
 *    RRULE. The app re-anchors nextDue on every completion/snooze, so an
 *    RRULE anchored at export-time DTSTART drifts from the real schedule
 *    almost immediately. Subscribed calendars re-fetch the feed and pick
 *    up the new date after each completion.
 *  - Stable UID per task (`<taskId>@familygreenhouse.app`) so updates
 *    on our side replace the existing calendar event rather than
 *    duplicating.
 */
import type { Task } from '../models/types.js';

const PROD_ID = '-//Family Greenhouse//Plant care tasks//EN';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Format a Date as a DTSTART;VALUE=DATE — the all-day form per RFC 5545
 * §3.3.4. Local timezone of the user's calendar app handles display.
 */
function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function formatDateTime(d: Date): string {
  return `${formatDate(d)}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** RFC 5545 line folding: lines over 75 octets must be broken with CRLF + space. */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  let remaining = line;
  while (remaining.length > 75) {
    out.push(remaining.slice(0, 75));
    remaining = ' ' + remaining.slice(75);
  }
  out.push(remaining);
  return out.join('\r\n');
}

/** Escape backslashes, semicolons, commas, and newlines per RFC 5545 §3.3.11. */
function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function eventLines(task: Task, now: Date): string[] {
  const due = new Date(task.nextDue);
  // Legacy rows can have an empty `type`; `type[0].toUpperCase()` threw on
  // those and 500'd the whole feed. Fall back to a generic label.
  const typeLabel = task.type ? `${task.type[0].toUpperCase()}${task.type.slice(1)}` : 'Care task';
  const summary = task.customType
    ? `${task.customType} — ${task.plantName}`
    : `${typeLabel} — ${task.plantName}`;
  const descriptionParts = [
    `Recurring every ${task.frequency} day${task.frequency === 1 ? '' : 's'}.`,
  ];
  if (task.notes) descriptionParts.push(task.notes);
  if (task.assignedToName) descriptionParts.push(`Assigned to ${task.assignedToName}.`);

  // Deliberately NO RRULE here: completing/snoozing a task re-anchors its
  // nextDue server-side, so a client-extrapolated recurrence anchored at
  // export-time DTSTART diverges from the app's real schedule after the
  // first completion. A single occurrence at the current nextDue is always
  // accurate; subscription refresh moves the event forward over time.
  return [
    'BEGIN:VEVENT',
    `UID:${task.id}@familygreenhouse.app`,
    `DTSTAMP:${formatDateTime(now)}`,
    `DTSTART;VALUE=DATE:${formatDate(due)}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(descriptionParts.join(' '))}`,
    'END:VEVENT',
  ];
}

/**
 * Build a complete VCALENDAR document from a list of tasks. Caller is
 * responsible for restricting to tasks the requesting user is allowed
 * to see.
 */
export function buildIcs(tasks: Task[], now: Date = new Date()): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PROD_ID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    // The X-WR-* properties aren't standard but every major calendar
    // client honors them for the subscription's display name + color.
    'X-WR-CALNAME:Family Greenhouse — Plant care',
    'X-WR-CALDESC:Recurring plant care tasks from Family Greenhouse',
  ];
  for (const task of tasks) {
    lines.push(...eventLines(task, now));
  }
  lines.push('END:VCALENDAR');
  // RFC 5545 mandates CRLF line endings + line folding for over-75 lines.
  return lines.map(fold).join('\r\n') + '\r\n';
}
