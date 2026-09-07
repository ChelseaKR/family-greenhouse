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
 *  - Titles and dates ONLY. The subscription URL is a capability URL (see
 *    services/calendarTokens.ts): whoever holds it can read the feed, so
 *    the feed carries nothing a leaked link should reveal. Task notes and
 *    the assignee's name are deliberately NOT emitted — a calendar needs
 *    "Water — Monstera, due Tuesday", not the household's private notes or
 *    which member is on the hook. Both are still visible in the app.
 */
import type { Task } from '../models/types.js';
import { resolveCadence, type Hemisphere } from './seasonalCadence.js';

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

/**
 * RFC 5545 line folding: lines over 75 octets must be broken with CRLF +
 * space. Folds on UTF-8 BYTE boundaries, never splitting a multi-byte code
 * point — the same requirement `smsNotifier.truncateToBytes` documents.
 * `String.length` counts UTF-16 code units, so a line that reads as "72
 * characters" in JS can still be well over 75 UTF-8 bytes once it contains
 * non-ASCII text (accented Spanish plant names/notes, CJK, emoji — all of
 * which this app's free-text fields accept), and a plain `.slice(0, 75)`
 * can bisect a surrogate pair. Both silently produced non-conformant VEVENT
 * output for exactly the content this app's EN/ES i18n exists to support;
 * iterating by code point and measuring each one's real UTF-8 byte length
 * avoids both failure modes.
 */
function fold(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const segments: string[] = [];
  let current = '';
  let currentBytes = 0;
  // The first physical line gets the full 75-octet budget; each
  // continuation line spends one octet on its mandatory leading space, so
  // its own content budget is 74.
  let budget = 75;
  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (currentBytes + chBytes > budget) {
      segments.push(current);
      current = '';
      currentBytes = 0;
      budget = 74;
    }
    current += ch;
    currentBytes += chBytes;
  }
  segments.push(current);
  return segments.map((seg, i) => (i === 0 ? seg : ' ' + seg)).join('\r\n');
}

/** Escape backslashes, semicolons, commas, and newlines per RFC 5545 §3.3.11. */
function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function eventLines(task: Task, now: Date, hemisphere: Hemisphere | null): string[] {
  const due = new Date(task.nextDue);
  // Legacy rows can have an empty `type`; `type[0].toUpperCase()` threw on
  // those and 500'd the whole feed. Fall back to a generic label.
  const typeLabel = task.type ? `${task.type[0].toUpperCase()}${task.type.slice(1)}` : 'Care task';
  const summary = task.customType
    ? `${task.customType} — ${task.plantName}`
    : `${typeLabel} — ${task.plantName}`;
  // Cadence only. `task.notes` and `task.assignedToName` are intentionally
  // left out — see the module doc: the feed URL is a bearer credential, so
  // the feed must not carry private notes or member names.
  //
  // A seasonally-scheduled task states the cadence actually in force and
  // names the season, because the alternative is a calendar that says "every
  // 7 days" all winter while the app schedules every 14 — the feed telling
  // the household a different story from the app it mirrors.
  const cadence = resolveCadence(task.frequency, task.seasonalCadences, hemisphere, now);
  const days = cadence.frequency;
  const description =
    cadence.source === 'seasonal' && cadence.season
      ? `Recurring every ${days} day${days === 1 ? '' : 's'} (${cadence.season} cadence).`
      : `Recurring every ${days} day${days === 1 ? '' : 's'}.`;

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
    `DESCRIPTION:${escapeText(description)}`,
    'END:VEVENT',
  ];
}

/**
 * Build a complete VCALENDAR document from a list of tasks. Caller is
 * responsible for restricting to tasks the requesting user is allowed
 * to see.
 */
export function buildIcs(
  tasks: Task[],
  now: Date = new Date(),
  /**
   * The household's hemisphere, for tasks carrying a seasonal profile. `null`
   * (a household with no location, or one whose row could not be read) keeps
   * every description on the task's base cadence — the same text the feed
   * emitted before seasonal profiles existed.
   */
  hemisphere: Hemisphere | null = null
): string {
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
    lines.push(...eventLines(task, now, hemisphere));
  }
  lines.push('END:VCALENDAR');
  // RFC 5545 mandates CRLF line endings + line folding for over-75 lines.
  return lines.map(fold).join('\r\n') + '\r\n';
}
