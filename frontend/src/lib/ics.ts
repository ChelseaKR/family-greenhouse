/**
 * A one-event iCalendar (RFC 5545) file, built entirely in the browser.
 *
 * Used by the care guides' "your next watering" tool: the visitor's answer
 * becomes a recurring all-day "check the soil" event that they save into
 * their own calendar. Nothing about the visitor goes to a server; the file is
 * a Blob made on the device and handed straight to the download.
 *
 * Kept to the parts every major calendar reads: an all-day `DTSTART`, a
 * `DAILY` rule with an `INTERVAL`, a summary, a description, a link and a
 * morning alert. Text is escaped and long lines are folded at 75 octets as
 * the RFC requires.
 */

export interface RecurringAllDayEvent {
  /** Stable id: re-adding the same plant's event replaces it, not duplicates it. */
  uid: string;
  /** First day, as the visitor's own local calendar date. */
  start: { year: number; month: number; day: number };
  /** Repeat every this many days. A whole number of 1 or more. */
  intervalDays: number;
  summary: string;
  description: string;
  /** An https link back to the page the event came from. */
  url: string;
  /** When the file was made; only used for `DTSTAMP`. */
  now: Date;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function dateValue({ year, month, day }: { year: number; month: number; day: number }): string {
  return `${pad(year, 4)}${pad(month)}${pad(day)}`;
}

function utcStamp(date: Date): string {
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma and line breaks. */
export function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold one content line at 75 octets (UTF-8), continuing with CRLF and a
 * space. Never splits a character.
 */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  // Continuation lines start with a space, which counts toward their 75.
  let limit = 75;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (octets + size > limit) {
      parts.push(current);
      current = '';
      octets = 0;
      limit = 74;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/** The whole file, CRLF line endings, ending with a CRLF. */
export function buildRecurringAllDayIcs(event: RecurringAllDayEvent): string {
  if (!Number.isInteger(event.intervalDays) || event.intervalDays < 1) {
    throw new RangeError('intervalDays must be a whole number of 1 or more');
  }
  const { year, month, day } = event.start;
  // The day after, for DTEND: an all-day event ends at the start of the next day.
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const end = {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Family Greenhouse//Care guide//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${utcStamp(event.now)}`,
    `DTSTART;VALUE=DATE:${dateValue(event.start)}`,
    `DTEND;VALUE=DATE:${dateValue(end)}`,
    `RRULE:FREQ=DAILY;INTERVAL=${event.intervalDays}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
    `DESCRIPTION:${escapeIcsText(event.description)}`,
    `URL:${event.url}`,
    'TRANSP:TRANSPARENT',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    // 9 a.m. on the day: an all-day event starts at midnight.
    'TRIGGER:PT9H',
    `DESCRIPTION:${escapeIcsText(event.summary)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}
