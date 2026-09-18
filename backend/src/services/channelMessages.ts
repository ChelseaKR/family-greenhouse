/**
 * What the household chat channel says, and the three wire formats it says it
 * in (#674). Pure: no I/O, no environment, no clock.
 *
 * ## What a post may contain — the whole list
 *
 * Plant names, task names, and due dates. Nothing else about the household
 * ever reaches a channel:
 *
 *   - no plant `notes`, and not even the `careRule` a sitter link may show
 *     (`models/sitterBriefFields.resolveCareNote`) — a family chat can include
 *     people the household would never hand a sitter link to;
 *   - no person: no names, no emails, no phone numbers, not even who a task is
 *     assigned to. "Nobody has claimed it" is the only statement about people;
 *   - no links at all — so no sitter, kiosk, share, plant-tag or calendar URL
 *     or token can be pasted in by accident, and no deep link whose shape
 *     could change later to carry one.
 *
 * The composer's input types make the first two structural: a `ChannelRow` has
 * no field that could hold a note or a person. The row builders that turn a
 * `Task` into a `ChannelRow` (`householdChannelRun.ts`) copy four fields by
 * name, and `tests/unit/services/channelMessages.test.ts` asserts over a
 * fixture carrying every sensitive field the product stores that none of it
 * reaches any platform's payload.
 *
 * ## Escaping
 *
 * Plant and task names are typed by household members, so each renderer
 * neutralises its platform's markup and — the part that matters in a group
 * chat — its mentions. A plant called `@everyone` must not ping a Discord
 * server, `<!channel>` must not ping a Slack channel, and `@room` must not
 * ping a Matrix room.
 */
import type { ChannelLocale, ChannelPlatform, ChannelEvents } from '../models/householdChannel.js';
import { describeRow, type DueState } from './reminderEmail.js';

/** One task, reduced to what a channel may say about it. */
export interface ChannelRow {
  /** Null only when the plant's name could not be read. */
  plantName: string | null;
  /** Null only when a custom task has no label. */
  taskLabel: string | null;
  due: DueState;
  /** Nobody is assigned. The only statement a post makes about people. */
  unclaimed: boolean;
  /** The ISO instant the task is due, for the weekly post's dates. */
  nextDue: string;
}

export interface ComposedChannelMessage {
  heading: string;
  /** Each entry is one line. Contains household-typed text: always escaped. */
  items: string[];
  /** Rows the heading counts that are not listed. Stated, never dropped. */
  hidden: number;
  /** Our own closing line, when there is one. Never household text. */
  note: string | null;
}

/** How many rows a post names. The heading always states the real total. */
export const MAX_CHANNEL_ITEMS = 15;
/** Longest plant or task name a line carries before it is cut with "…". */
const MAX_SEGMENT_CHARS = 80;

interface Copy {
  dailyHeading: { one: string; other: string };
  upForGrabsHeading: { one: string; other: string };
  unclaimedSuffix: string;
  dueOn: (date: string) => string;
  overflow: { one: string; other: string };
  testHeading: string;
  testDaily: string;
  testUpForGrabs: string;
  testNothingOn: string;
  testPrivacy: string;
}

const COPY: Record<ChannelLocale, Copy> = {
  en: {
    dailyHeading: {
      one: '1 plant-care task is due today or overdue:',
      other: '{{count}} plant-care tasks are due today or overdue:',
    },
    upForGrabsHeading: {
      one: 'Up for grabs this week — 1 task nobody has claimed yet:',
      other: 'Up for grabs this week — {{count}} tasks nobody has claimed yet:',
    },
    unclaimedSuffix: ' (nobody has claimed it)',
    dueOn: (date) => `due ${date}`,
    overflow: {
      one: '…and 1 more. Open Family Greenhouse to see the full list.',
      other: '…and {{count}} more. Open Family Greenhouse to see the full list.',
    },
    testHeading: 'Family Greenhouse is connected to this channel.',
    testDaily: 'Each morning: the plant care that is due today or overdue.',
    testUpForGrabs: 'Once a week: upcoming tasks nobody has claimed.',
    testNothingOn: 'No posts are switched on yet — choose them in Family Greenhouse settings.',
    testPrivacy: 'Posts here carry plant names, task names and due dates only.',
  },
  es: {
    dailyHeading: {
      one: 'Hay 1 tarea de cuidado de plantas para hoy o atrasada:',
      other: 'Hay {{count}} tareas de cuidado de plantas para hoy o atrasadas:',
    },
    upForGrabsHeading: {
      one: 'Sin asignar esta semana: 1 tarea que nadie ha tomado todavía:',
      other: 'Sin asignar esta semana: {{count}} tareas que nadie ha tomado todavía:',
    },
    unclaimedSuffix: ' (nadie la ha tomado)',
    dueOn: (date) => `para el ${date}`,
    overflow: {
      one: '…y 1 más. Abre Family Greenhouse para ver la lista completa.',
      other: '…y {{count}} más. Abre Family Greenhouse para ver la lista completa.',
    },
    testHeading: 'Family Greenhouse está conectado a este canal.',
    testDaily: 'Cada mañana: el cuidado de plantas que toca hoy o que está atrasado.',
    testUpForGrabs: 'Una vez por semana: las próximas tareas que nadie ha tomado.',
    testNothingOn:
      'Todavía no hay publicaciones activadas; elígelas en los ajustes de Family Greenhouse.',
    testPrivacy:
      'Las publicaciones de este canal solo incluyen nombres de plantas, nombres de tareas y fechas.',
  },
};

function plural(form: { one: string; other: string }, count: number, locale: ChannelLocale) {
  return (count === 1 ? form.one : form.other).replace(
    '{{count}}',
    new Intl.NumberFormat(locale).format(count)
  );
}

function clip(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SEGMENT_CHARS ? `${flat.slice(0, MAX_SEGMENT_CHARS - 1)}…` : flat;
}

function formatDueDate(nextDue: string, locale: ChannelLocale, timeZone: string): string | null {
  const ms = Date.parse(nextDue);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone,
    }).format(new Date(ms));
  } catch {
    // A zone Intl no longer knows. The date is still real; say it in UTC
    // rather than drop it.
    return new Intl.DateTimeFormat(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    }).format(new Date(ms));
  }
}

function withOverflow(heading: string, lines: string[]): ComposedChannelMessage {
  const listed = lines.slice(0, MAX_CHANNEL_ITEMS);
  return { heading, items: listed, hidden: lines.length - listed.length, note: null };
}

/** The closing lines: the overflow count (our copy, the real number) and the
 *  message's own note. */
export function footerLines(message: ComposedChannelMessage, locale: ChannelLocale): string[] {
  const lines: string[] = [];
  if (message.hidden > 0) lines.push(plural(COPY[locale].overflow, message.hidden, locale));
  if (message.note) lines.push(message.note);
  return lines;
}

/** The morning post: everything due today or overdue, most urgent first. */
export function composeDailyDue(
  rows: ChannelRow[],
  locale: ChannelLocale
): ComposedChannelMessage | null {
  if (rows.length === 0) return null;
  const copy = COPY[locale];
  const lines = rows.map((row) => {
    const parts = describeRow(row, locale);
    const suffix = row.unclaimed ? copy.unclaimedSuffix : '';
    return `${clip(parts.plant)} — ${clip(parts.task)}, ${parts.due}${suffix}`;
  });
  return withOverflow(plural(copy.dailyHeading, rows.length, locale), lines);
}

/** The weekly post: upcoming work nobody has claimed, soonest first. */
export function composeUpForGrabs(
  rows: ChannelRow[],
  locale: ChannelLocale,
  timeZone: string
): ComposedChannelMessage | null {
  if (rows.length === 0) return null;
  const copy = COPY[locale];
  const lines = rows.map((row) => {
    const parts = describeRow(row, locale);
    const date = formatDueDate(row.nextDue, locale, timeZone);
    // An unreadable date says so in the reminder's own words, never a blank.
    const when = date ? copy.dueOn(date) : parts.due;
    return `${clip(parts.plant)} — ${clip(parts.task)}, ${when}`;
  });
  return withOverflow(plural(copy.upForGrabsHeading, rows.length, locale), lines);
}

/** The admin's "send a test message". Names no plant at all. */
export function composeTest(events: ChannelEvents, locale: ChannelLocale): ComposedChannelMessage {
  const copy = COPY[locale];
  const items: string[] = [];
  if (events.dailyDue) items.push(copy.testDaily);
  if (events.upForGrabs) items.push(copy.testUpForGrabs);
  if (items.length === 0) items.push(copy.testNothingOn);
  return { heading: copy.testHeading, items, hidden: 0, note: copy.testPrivacy };
}

// ---------------------------------------------------------------------------
// Wire formats
// ---------------------------------------------------------------------------

/** Discord's hard limit on `content`. */
export const DISCORD_CONTENT_LIMIT = 2000;
/** Slack truncates `text` far above this; staying under it keeps a post one
 *  readable block instead of a "show more". */
export const SLACK_TEXT_LIMIT = 3000;
export const MATRIX_BODY_LIMIT = 4000;

/**
 * Discord markdown and mention syntax. Every character that can start
 * formatting, a masked link, a mention or an autolink (`:` in `https://`) is
 * backslash-escaped; `allowed_mentions: { parse: [] }` below is the second
 * lock on pings. Line-start syntax (`-`, `1.`) needs nothing: household text
 * never starts a line, every item line begins with our own bullet.
 */
export function escapeDiscord(value: string): string {
  return value.replace(/[\\*_~`|>#[\]()<:@]/g, '\\$&');
}

/** Slack's three control characters. With these escaped, `<!channel>`,
 *  `<@U123>` and `<https://…|label>` are inert text. */
export function escapeSlack(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Matrix's legacy push rule pings the whole room on the literal `@room`; a
 *  word joiner after the `@` keeps it readable and inert. */
function defuseMatrixMentions(value: string): string {
  return value.replace(/@room/gi, (match) => `@⁠${match.slice(1)}`);
}

/** Drop listed items from the end until `render` fits `limit`, counting each
 *  one into `hidden` so the real total is never lost. */
function fitTo<T>(
  message: ComposedChannelMessage,
  render: (message: ComposedChannelMessage) => { size: number; value: T },
  limit: number
): T {
  let current = message;
  let rendered = render(current);
  while (rendered.size > limit && current.items.length > 1) {
    current = { ...current, items: current.items.slice(0, -1), hidden: current.hidden + 1 };
    rendered = render(current);
  }
  return rendered.value;
}

export function renderDiscord(
  message: ComposedChannelMessage,
  locale: ChannelLocale
): Record<string, unknown> {
  const render = (m: ComposedChannelMessage) => {
    const lines = [
      `**${escapeDiscord(m.heading)}**`,
      ...m.items.map((i) => `• ${escapeDiscord(i)}`),
      ...footerLines(m, locale).map(escapeDiscord),
    ];
    const content = lines.join('\n');
    return { size: content.length, value: content };
  };
  const content = fitTo(message, render, DISCORD_CONTENT_LIMIT);
  return {
    content,
    // Nothing a household typed may ping anyone: no @everyone, no roles, no
    // users, whatever the escaping above missed.
    allowed_mentions: { parse: [] },
    // SUPPRESS_EMBEDS: no link previews, even for text that looks like a URL.
    flags: 4,
  };
}

export function renderSlack(
  message: ComposedChannelMessage,
  locale: ChannelLocale
): Record<string, unknown> {
  const render = (m: ComposedChannelMessage) => {
    const lines = [
      escapeSlack(m.heading),
      ...m.items.map((i) => `• ${escapeSlack(i)}`),
      ...footerLines(m, locale).map(escapeSlack),
    ];
    const text = lines.join('\n');
    return { size: text.length, value: text };
  };
  const text = fitTo(message, render, SLACK_TEXT_LIMIT);
  return {
    text,
    // Plain text: `*bold*` in a plant name stays literal asterisks.
    mrkdwn: false,
    unfurl_links: false,
    unfurl_media: false,
  };
}

/**
 * matrix-hookshot's generic-webhook body: `text` is the plain body and `html`
 * the formatted one. Supplying `html` stops hookshot from running `text`
 * through its Markdown converter, so nothing a household typed is ever
 * interpreted as markup.
 */
export function renderMatrix(
  message: ComposedChannelMessage,
  locale: ChannelLocale
): Record<string, unknown> {
  const render = (m: ComposedChannelMessage) => {
    const heading = defuseMatrixMentions(m.heading);
    const items = m.items.map(defuseMatrixMentions);
    const footer = footerLines(m, locale).map(defuseMatrixMentions);
    const text = [heading, ...items.map((i) => `• ${i}`), ...footer].join('\n');
    const html =
      `<p><strong>${escapeHtml(heading)}</strong></p>` +
      `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` +
      footer.map((line) => `<p>${escapeHtml(line)}</p>`).join('');
    return { size: Math.max(text.length, html.length), value: { text, html } };
  };
  return fitTo(message, render, MATRIX_BODY_LIMIT);
}

export function renderForPlatform(
  platform: ChannelPlatform,
  message: ComposedChannelMessage,
  locale: ChannelLocale
): Record<string, unknown> {
  switch (platform) {
    case 'discord':
      return renderDiscord(message, locale);
    case 'slack':
      return renderSlack(message, locale);
    case 'matrix':
      return renderMatrix(message, locale);
  }
}

export const __testing = { COPY, MAX_SEGMENT_CHARS };
