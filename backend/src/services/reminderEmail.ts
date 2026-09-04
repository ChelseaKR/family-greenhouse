/**
 * Copy + layout for the daily plant-care reminder.
 *
 * Split out of `services/reminders.ts` so the fan-out keeps doing delivery
 * (markers, leases, channel plans) and this file does nothing but turn already-
 * read data into words. Everything here is pure: no DynamoDB, no clock beyond
 * the `now` it is handed, no environment. That is what makes the honesty rules
 * below testable.
 *
 * ## The rules this file exists to hold
 *
 * 1. **Name the thing.** The reminder used to be two integers and a link to a
 *    filtered list. It had `Task[]` in scope and threw it away. Every row now
 *    names its plant, its task, how overdue it is, and links to that plant.
 *
 * 2. **A subset always states the true total.** Same rule, and the same
 *    reasoning, as `digest.composeDigestEmail`: under-reporting is the
 *    dangerous direction for a care product, because it reassures precisely
 *    the households that most need the nudge. `rows` is the member's COMPLETE
 *    list; the caps below are a display concern and the counts stay true.
 *
 * 3. **Never print a zero as information.** `5 ready for some catch-up care,
 *    0 coming up soon` told the reader nothing and cost a clause. A count of
 *    zero is simply omitted from the summary.
 *
 * 4. **A failed read is never rendered as a value.** This is the repo's named
 *    defect class (ADR 0010). Four places it could bite here, all handled by
 *    the types rather than by care:
 *      - `ReminderTaskRow.plantName: string | null` — null renders as an
 *        explicit "we could not load this plant's name", never as a name.
 *      - `ReminderTaskRow.taskLabel: string | null` — null renders as
 *        "unnamed care task", never as the literal enum value `custom` (the
 *        bug `digest.taskTypeLabel` still has).
 *      - `CoverageNote.name: string | null` — null renders as "a household
 *        member whose name we could not load". The old code did
 *        `members.find(...)?.name ?? t.assignedToName ?? 'a housemate'`, which
 *        turned a failed member lookup into a person apparently named "a
 *        housemate".
 *      - `DueState` has an explicit `unknown` member, so an unparseable
 *        `nextDue` can never become `NaN days overdue`.
 *
 * 5. **Localised.** Every string is in both catalogs below and selected by
 *    `locale`. `reminders.ts` resolves that per recipient from the
 *    `emailLocale` preference through `services/email/locale.ts`, falling back
 *    to English when nobody has chosen; the push and SMS bodies fanned out
 *    from `notifier.sendToUser` inherit the same language.
 */
import type { HouseholdMember } from '../models/types.js';

export type ReminderLocale = 'en' | 'es';

export const REMINDER_LOCALES: readonly ReminderLocale[] = ['en', 'es'];

/** How many of the member's own tasks the body lists. The rest are counted. */
export const MAX_LISTED_ASSIGNED = 6;
/** How many unclaimed tasks the body lists. The rest are counted. */
export const MAX_LISTED_UNCLAIMED = 4;

/**
 * How overdue one task is. `unknown` is a real, distinct state: the row's
 * `nextDue` did not parse, so we know there is a task and do not know when it
 * was due. Collapsing that into `overdue: 0` — or into `NaN days`, which is
 * what the digest's arithmetic does — would be the defect class again.
 */
export type DueState =
  | { kind: 'overdue'; days: number }
  | { kind: 'today' }
  | { kind: 'upcoming' }
  | { kind: 'unknown' };

export interface ReminderTaskRow {
  /** Null ONLY when the plant's name could not be resolved. Never a fallback. */
  plantName: string | null;
  /** Null ONLY when a custom task carries no `customType`. Never `'custom'`. */
  taskLabel: string | null;
  due: DueState;
  /** Nobody is assigned, so any member may claim it. */
  upForGrabs: boolean;
  /** Deep link to this row's own plant. */
  url: string;
}

export interface CoverageNote {
  /** Resolved member name, or null when the lookup FAILED. */
  name: string | null;
  /** ISO end of their vacation window, or null when it is not known. */
  awayUntil: string | null;
}

/**
 * What the reminder knows about today's weather.
 *
 * `unavailable` is a first-class member because the `reminders` Lambda does
 * not receive `OPENWEATHER_API_KEY` until the Terraform change in this PR is
 * applied — and even afterwards a household may have no saved location, or the
 * provider may be down. An unread forecast renders NOTHING. It must never
 * become "no rain expected", which is a claim we cannot make.
 */
export type ReminderClimate =
  { status: 'unavailable' } | { status: 'read'; rain: boolean; frostLowC: number | null };

export interface ReminderEmailInput {
  /**
   * The member's COMPLETE row list, most urgent first. The composer lists a
   * capped subset and reports this array's real length.
   */
  rows: ReminderTaskRow[];
  /** Who this member is covering for, and why. Empty when nobody. */
  covering: CoverageNote[];
  climate: ReminderClimate;
  locale: ReminderLocale;
  /** IANA zone the recipient's dates are rendered in. */
  timeZone: string;
}

export interface ReminderComposition {
  subject: string;
  /** Full email body. `notifier` appends the payload URL as the footer. */
  body: string;
  /** One line for space-constrained channels (SMS is one 140-byte segment). */
  shortBody: string;
}

interface Counts {
  /** Past due by a whole day or more. */
  overdue: number;
  /** Past due, but less than a day — the digest's "ready for a little care today". */
  today: number;
  /** Not yet due, inside the 24h window. */
  upcoming: number;
  /** `nextDue` did not parse. Counted, never guessed at. */
  unknown: number;
  /** Unassigned, and therefore claimable. A SUBSET of the four above. */
  unclaimed: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Copy catalogs. Both locales carry every key; `localeParity` in the unit tests
// fails if one gains a key the other lacks.
// ---------------------------------------------------------------------------

interface Copy {
  subjectPrefix: string;
  /** Summary fragments. `one` / `other` are separate entries because Spanish
   *  agreement differs from English pluralisation and a ternary cannot say so. */
  overdueFragment: { one: string; other: string };
  todayFragment: { one: string; other: string };
  upcomingFragment: { one: string; other: string };
  unknownFragment: { one: string; other: string };
  /** Appended to the summary. Unclaimed tasks are ALSO counted in the
   *  fragments above — they are a subset, not a fourth bucket — so the wording
   *  has to say "including" or the reader adds them twice. */
  unclaimedSuffix: (count: string, one: boolean) => string;
  /** Joins the summary fragments, e.g. "a, b and c". */
  fragmentJoin: string;
  fragmentLastJoin: string;
  summarySentence: (summary: string) => string;
  assignedHeading: string;
  unclaimedHeading: string;
  showingSubset: (listed: number, total: number) => string;
  overdueDays: (days: number) => string;
  dueToday: string;
  dueUpcoming: string;
  dueUnknown: string;
  unnamedPlant: string;
  unnamedTask: string;
  taskTypes: Record<'water' | 'fertilize' | 'prune' | 'repot', string>;
  coveringNamedUntil: (name: string, date: string) => string;
  coveringNamed: (name: string) => string;
  coveringUnresolved: string;
  climateRain: string;
  climateFrost: (lowC: string) => string;
  footerHint: string;
}

const COPY: Record<ReminderLocale, Copy> = {
  en: {
    subjectPrefix: 'Plant care reminder',
    overdueFragment: { one: '1 overdue', other: '{{count}} overdue' },
    todayFragment: { one: '1 due today', other: '{{count}} due today' },
    upcomingFragment: { one: '1 coming up', other: '{{count}} coming up' },
    unknownFragment: {
      one: '1 with no readable due date',
      other: '{{count}} with no readable due date',
    },
    unclaimedSuffix: (count, one) =>
      one ? ', including 1 nobody has claimed' : `, including ${count} nobody has claimed`,
    fragmentJoin: ', ',
    fragmentLastJoin: ' and ',
    summarySentence: (summary) => `Here is where your household's plant care stands: ${summary}.`,
    assignedHeading: 'Yours, most urgent first:',
    unclaimedHeading: 'Up for grabs — nobody has claimed these, so anyone can:',
    showingSubset: (listed, total) =>
      `Showing ${listed} of ${total}. The full list is linked at the end of this email.`,
    overdueDays: (days) => (days === 1 ? '1 day overdue' : `${days} days overdue`),
    dueToday: 'due today',
    dueUpcoming: 'due in the next 24 hours',
    dueUnknown: 'due date could not be read — please check it in the app',
    unnamedPlant: "a plant whose name we couldn't load",
    unnamedTask: 'unnamed care task',
    taskTypes: { water: 'water', fertilize: 'fertilize', prune: 'prune', repot: 'repot' },
    coveringNamedUntil: (name, date) => `You're covering for ${name}, who is away until ${date}.`,
    coveringNamed: (name) => `You're covering for ${name} while they're away.`,
    coveringUnresolved:
      "You're also covering for a household member whose name we couldn't load — open the app to see who.",
    climateRain:
      "Rain is forecast for your area — outdoor plants likely don't need watering today.",
    climateFrost: (lowC) => `A low of ${lowC}°C is forecast tonight — bring tender plants indoors.`,
    footerHint: 'Open any plant above to log the care, or see everything here:',
  },
  es: {
    subjectPrefix: 'Recordatorio de cuidado de plantas',
    overdueFragment: { one: '1 atrasada', other: '{{count}} atrasadas' },
    todayFragment: { one: '1 para hoy', other: '{{count}} para hoy' },
    upcomingFragment: { one: '1 próxima', other: '{{count}} próximas' },
    unknownFragment: {
      one: '1 sin fecha legible',
      other: '{{count}} sin fecha legible',
    },
    unclaimedSuffix: (count, one) =>
      one ? ', incluida 1 que nadie ha tomado' : `, incluidas ${count} que nadie ha tomado`,
    fragmentJoin: ', ',
    fragmentLastJoin: ' y ',
    summarySentence: (summary) => `Así está el cuidado de plantas de tu hogar: ${summary}.`,
    assignedHeading: 'Tuyas, las más urgentes primero:',
    unclaimedHeading: 'Sin asignar: nadie las ha tomado todavía, así que cualquiera puede hacerlo:',
    showingSubset: (listed, total) =>
      `Mostrando ${listed} de ${total}. La lista completa está enlazada al final de este correo.`,
    overdueDays: (days) => (days === 1 ? '1 día de retraso' : `${days} días de retraso`),
    dueToday: 'para hoy',
    dueUpcoming: 'en las próximas 24 horas',
    dueUnknown: 'no se pudo leer la fecha; compruébala en la aplicación',
    unnamedPlant: 'una planta cuyo nombre no pudimos cargar',
    unnamedTask: 'tarea de cuidado sin nombre',
    taskTypes: { water: 'regar', fertilize: 'abonar', prune: 'podar', repot: 'trasplantar' },
    coveringNamedUntil: (name, date) =>
      `Estás cubriendo a ${name}, que está fuera hasta el ${date}.`,
    coveringNamed: (name) => `Estás cubriendo a ${name} mientras está fuera.`,
    coveringUnresolved:
      'También estás cubriendo a un miembro del hogar cuyo nombre no pudimos cargar; abre la aplicación para ver quién es.',
    climateRain:
      'Se espera lluvia en tu zona: las plantas de exterior probablemente no necesiten riego hoy.',
    climateFrost: (lowC) =>
      `Se prevé una mínima de ${lowC} °C esta noche: mete las plantas delicadas en casa.`,
    footerHint: 'Abre cualquier planta de arriba para registrar el cuidado, o velo todo aquí:',
  },
};

function plural(
  form: { one: string; other: string },
  count: number,
  locale: ReminderLocale
): string {
  const template = count === 1 ? form.one : form.other;
  return template.replace('{{count}}', new Intl.NumberFormat(locale).format(count));
}

function joinFragments(parts: string[], copy: Copy): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(copy.fragmentJoin)}${copy.fragmentLastJoin}${parts[parts.length - 1]}`;
}

/**
 * The counts sentence, with every zero omitted.
 *
 * The old body read `5 ready for some catch-up care, 0 coming up soon` — the
 * zero was arithmetic (`total - overdue`), not information, and it took up the
 * half of a one-line email that could have named a plant.
 */
function summaryFragments(counts: Counts, locale: ReminderLocale): string[] {
  const copy = COPY[locale];
  const parts: string[] = [];
  if (counts.overdue > 0) parts.push(plural(copy.overdueFragment, counts.overdue, locale));
  if (counts.today > 0) parts.push(plural(copy.todayFragment, counts.today, locale));
  if (counts.upcoming > 0) parts.push(plural(copy.upcomingFragment, counts.upcoming, locale));
  if (counts.unknown > 0) parts.push(plural(copy.unknownFragment, counts.unknown, locale));
  return parts;
}

/** The whole summary clause: the non-zero buckets, plus the claimable note. */
function summaryClause(counts: Counts, locale: ReminderLocale): string {
  const copy = COPY[locale];
  const joined = joinFragments(summaryFragments(counts, locale), copy);
  if (!joined || counts.unclaimed === 0) return joined;
  return (
    joined +
    copy.unclaimedSuffix(
      new Intl.NumberFormat(locale).format(counts.unclaimed),
      counts.unclaimed === 1
    )
  );
}

export function countRows(rows: ReminderTaskRow[]): Counts {
  const counts: Counts = {
    overdue: 0,
    today: 0,
    upcoming: 0,
    unknown: 0,
    unclaimed: 0,
    total: rows.length,
  };
  for (const row of rows) {
    if (row.upForGrabs) counts.unclaimed += 1;
    counts[row.due.kind] += 1;
  }
  return counts;
}

function dueLabel(due: DueState, locale: ReminderLocale): string {
  const copy = COPY[locale];
  switch (due.kind) {
    case 'overdue':
      return copy.overdueDays(due.days);
    case 'today':
      return copy.dueToday;
    case 'upcoming':
      return copy.dueUpcoming;
    default:
      return copy.dueUnknown;
  }
}

/** Localised task-type label. Custom tasks keep the household's own wording. */
export function taskLabelFor(
  type: 'water' | 'fertilize' | 'prune' | 'repot' | 'custom',
  customType: string | null,
  locale: ReminderLocale
): string | null {
  if (type === 'custom') {
    const trimmed = customType?.trim();
    // No label recorded. Return null so the composer says so, rather than
    // printing the enum value `custom` as if it were the task's name — the
    // bug `digest.taskTypeLabel` still has.
    return trimmed ? trimmed : null;
  }
  // An unrecognised type is also "no label", never the raw stored value.
  return COPY[locale].taskTypes[type] ?? null;
}

function renderRow(row: ReminderTaskRow, locale: ReminderLocale, bullet: string): string {
  const copy = COPY[locale];
  const plant = row.plantName ?? copy.unnamedPlant;
  const task = row.taskLabel ?? copy.unnamedTask;
  // Continuation indent matches the bullet width so the URL lines up under
  // the row it belongs to in both the numbered and the dashed section.
  const indent = ' '.repeat(bullet.length + 1);
  return `${bullet} ${plant} — ${task}, ${dueLabel(row.due, locale)}\n${indent}${row.url}`;
}

function formatAwayUntil(iso: string, locale: ReminderLocale, timeZone: string): string | null {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  try {
    return new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone,
    }).format(new Date(parsed));
  } catch {
    // A corrupt stored timezone must not lose the whole reminder. Re-render in
    // UTC and say nothing about the zone rather than dropping the sentence.
    return new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(parsed));
  }
}

function coveringLines(
  covering: CoverageNote[],
  locale: ReminderLocale,
  timeZone: string
): string[] {
  const copy = COPY[locale];
  const lines: string[] = [];
  let sawUnresolved = false;
  for (const note of covering) {
    if (note.name === null) {
      // A failed member lookup. Say that, once, instead of inventing a person.
      sawUnresolved = true;
      continue;
    }
    const until = note.awayUntil ? formatAwayUntil(note.awayUntil, locale, timeZone) : null;
    lines.push(until ? copy.coveringNamedUntil(note.name, until) : copy.coveringNamed(note.name));
  }
  if (sawUnresolved) lines.push(copy.coveringUnresolved);
  return lines;
}

function climateLines(climate: ReminderClimate, locale: ReminderLocale): string[] {
  // `unavailable` renders nothing at all. Silence is the only honest output
  // for a forecast we could not read; "no rain expected" would be a claim.
  if (climate.status !== 'read') return [];
  const copy = COPY[locale];
  const lines: string[] = [];
  if (climate.rain) lines.push(copy.climateRain);
  if (climate.frostLowC !== null) {
    lines.push(
      copy.climateFrost(new Intl.NumberFormat(locale).format(Math.round(climate.frostLowC)))
    );
  }
  return lines;
}

/**
 * Build the reminder's subject, body and one-line short form.
 *
 * `input.rows` is the member's complete list. The body lists at most
 * `MAX_LISTED_ASSIGNED` / `MAX_LISTED_UNCLAIMED` rows per section and states
 * each section's real total whenever it is showing a subset.
 */
export function composeReminderEmail(input: ReminderEmailInput): ReminderComposition {
  const { locale, timeZone } = input;
  const copy = COPY[locale];
  const counts = countRows(input.rows);
  const summary = summaryClause(counts, locale);

  const subject = summary ? `${copy.subjectPrefix}: ${summary}` : copy.subjectPrefix;

  const assigned = input.rows.filter((r) => !r.upForGrabs);
  const unclaimed = input.rows.filter((r) => r.upForGrabs);

  const blocks: string[] = [];
  if (summary) blocks.push(copy.summarySentence(summary));

  if (assigned.length > 0) {
    const listed = assigned.slice(0, MAX_LISTED_ASSIGNED);
    const section = [
      copy.assignedHeading,
      '',
      ...listed.map((row, i) => renderRow(row, locale, `${i + 1}.`)),
    ];
    if (listed.length < assigned.length) {
      section.push('', copy.showingSubset(listed.length, assigned.length));
    }
    blocks.push(section.join('\n'));
  }

  if (unclaimed.length > 0) {
    const listed = unclaimed.slice(0, MAX_LISTED_UNCLAIMED);
    const section = [
      copy.unclaimedHeading,
      '',
      ...listed.map((row) => renderRow(row, locale, '-')),
    ];
    if (listed.length < unclaimed.length) {
      section.push('', copy.showingSubset(listed.length, unclaimed.length));
    }
    blocks.push(section.join('\n'));
  }

  const covering = coveringLines(input.covering, locale, timeZone);
  if (covering.length > 0) blocks.push(covering.join('\n'));

  const climate = climateLines(input.climate, locale);
  if (climate.length > 0) blocks.push(climate.join('\n'));

  blocks.push(copy.footerHint);

  return {
    subject,
    body: blocks.join('\n\n'),
    // SMS is capped at one 140-byte segment and a browser-push body is a
    // couple of lines, so those channels get the counts sentence only.
    shortBody: summary || copy.subjectPrefix,
  };
}

/**
 * Resolve one away-assignee's display name.
 *
 * Returns `null` — not a placeholder — when the roster has no row for the user
 * AND the task carries no denormalized name. The previous
 * `?? 'a housemate'` turned exactly that failure into a person's name.
 */
export function resolveCoveredName(
  members: readonly HouseholdMember[],
  userId: string,
  denormalizedName: string | null
): string | null {
  const fromRoster = members.find((m) => m.userId === userId)?.name?.trim();
  if (fromRoster) return fromRoster;
  const fromTask = denormalizedName?.trim();
  return fromTask ? fromTask : null;
}

export const __testing = { COPY, summaryFragments, formatAwayUntil };
