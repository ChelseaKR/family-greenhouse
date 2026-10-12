/**
 * What a reminder says when there is room for a title and a sentence or two:
 * the words a push notification shows, which web push, the native shells and
 * the email's heading can all share.
 *
 * `reminderEmail.ts` composes the long form: the full list, the cover note,
 * the weather line. This module composes the short form from the same rows,
 * and it is pure for the same reason: no DynamoDB, no clock, no environment,
 * and no transport. It does not know what a URL, an APNs category or a
 * service worker is. `reminders.ts` attaches the destination and the task it
 * names; `notifier.ts` and the transports decide how that travels.
 *
 * ## The rules this file holds
 *
 * 1. **The title names the action and the plant.** "Water the Monstera", not
 *    "Plant care reminder: 1 due today". Several tasks name what they have
 *    in common ("2 plants need water") or, failing that, the count.
 *
 * 2. **The body says when, and what happens next.** "Due today. Mark it done
 *    once you have, or snooze it until tomorrow."
 *
 * 3. **Overdue is stated, never shouted.** "Due 3 days ago" is a date;
 *    "3 DAYS OVERDUE" is a verdict. The household that is behind is the one
 *    the product must not nag (docs/user-research.md; the far edge of the
 *    due window in reminders.ts exists for the same reason).
 *
 * 4. **Many tasks get a count and the first two names, not a wall.**
 *    `NAMED_ROWS` caps the names; the count is always the real total.
 *
 * 5. **Nothing private.** `ReminderCopyRow` has no field that could carry a
 *    plant's `notes`, its care rule, a person's name or an address, so the
 *    words cannot contain them. A push payload crosses Apple's, Google's or a
 *    browser vendor's servers and the lock screen of whoever holds the phone;
 *    it is a third-party surface. `reminderCopy.test.ts` renders a fixture
 *    carrying every one of those fields and asserts none of it appears.
 *
 * 6. **Both languages, written as themselves.** The Spanish single-task title
 *    is "Monstera necesita riego", because "Riega la Monstera" would need the
 *    gender of a name the household chose.
 *
 * 7. **A failed read is never rendered as a value** (ADR 0010). A null plant
 *    name, a null task label and an unreadable due date each get the same
 *    wording the email uses, through `reminderEmail.describeRow`.
 */
import { describeRow, type DueState, type ReminderLocale } from './reminderEmail.js';

export type ReminderTaskType = 'water' | 'fertilize' | 'prune' | 'repot' | 'custom';

/**
 * One task, reduced to what the short form may say about it. Deliberately
 * not `ReminderTaskRow`: that type carries a URL, and this module must not
 * know about destinations. There is no place here for a note, a rule, a
 * person or an address, which is rule 5 enforced by the type rather than by
 * care.
 */
export interface ReminderCopyRow {
  /** Null ONLY when the plant's name could not be resolved. Never a fallback. */
  plantName: string | null;
  /**
   * The localised task label, as `reminderEmail.taskLabelFor` returns it:
   * null only when a custom task carries no name.
   */
  taskLabel: string | null;
  /** The task's type, so rows of one kind can be summed up ("2 plants need water"). */
  taskType: ReminderTaskType;
  due: DueState;
  /** Nobody is assigned, so any member may claim it. */
  upForGrabs: boolean;
}

export interface ReminderCopyInput {
  /**
   * The member's complete list for today, most urgent first, in the order
   * `reminders.ts` already sorts them. The composer names the first few and
   * counts the rest.
   */
  rows: readonly ReminderCopyRow[];
  locale: ReminderLocale;
}

/** The labels of the two things a person can do from the notification itself. */
export interface ReminderActionCopy {
  done: string;
  snoozeUntilTomorrow: string;
}

export interface ReminderShortCopy {
  /** The notification title. */
  title: string;
  /** Two or three short sentences: when, and what happens next. */
  body: string;
  /**
   * `single` when the reminder is about exactly one task, which is the only
   * case an action on the notification can act on; `several` otherwise.
   */
  kind: 'single' | 'several';
  /**
   * Localised labels for the Done and Snooze actions. Present only for a
   * `single` reminder: with several tasks, "Done" would have no referent.
   */
  actions: ReminderActionCopy | null;
}

/** How many rows the body names before it counts the rest (rule 4). */
export const NAMED_ROWS = 2;

interface Copy {
  /** The single-task title for each built-in type. `plant` is already resolved. */
  singleTitle: Record<Exclude<ReminderTaskType, 'custom'>, (plant: string) => string>;
  /** The single-task title when the plant's name could not be loaded. */
  singleTitleUnnamedPlant: Record<Exclude<ReminderTaskType, 'custom'>, (plant: string) => string>;
  /** A custom task keeps the household's own wording: "Monstera: mist the leaves". */
  singleTitleCustom: (plant: string, task: string) => string;
  /** Several tasks of one built-in type, one per plant. */
  severalSameType: Record<Exclude<ReminderTaskType, 'custom'>, (count: string) => string>;
  /** Several tasks, all on one plant. */
  severalOnePlant: (plant: string, count: string) => string;
  /** Several tasks, one per plant, of mixed kinds. */
  severalPlants: (count: string) => string;
  /** Several tasks that fit none of the above. */
  severalTasks: (count: string) => string;
  dueToday: string;
  dueLaterToday: string;
  dueYesterday: string;
  dueDaysAgo: (days: string) => string;
  dueUnknown: string;
  singleUnclaimed: string;
  singleNext: string;
  namesTwo: (first: string, second: string) => string;
  namesAndMore: (names: string, more: string) => string;
  countOverdue: { one: string; other: string };
  countToday: { one: string; other: string };
  countUnknown: { one: string; other: string };
  countJoin: string;
  countLastJoin: string;
  severalUnclaimed: (count: string) => string;
  severalNext: string;
  actions: ReminderActionCopy;
}

const COPY: Record<ReminderLocale, Copy> = {
  en: {
    singleTitle: {
      water: (plant) => `Water the ${plant}`,
      fertilize: (plant) => `Fertilize the ${plant}`,
      prune: (plant) => `Prune the ${plant}`,
      repot: (plant) => `Repot the ${plant}`,
    },
    singleTitleUnnamedPlant: {
      water: (plant) => `Water ${plant}`,
      fertilize: (plant) => `Fertilize ${plant}`,
      prune: (plant) => `Prune ${plant}`,
      repot: (plant) => `Repot ${plant}`,
    },
    singleTitleCustom: (plant, task) => `${plant}: ${task}`,
    severalSameType: {
      water: (count) => `${count} plants need water`,
      fertilize: (count) => `${count} plants need fertilizer`,
      prune: (count) => `${count} plants need pruning`,
      repot: (count) => `${count} plants need repotting`,
    },
    severalOnePlant: (plant, count) => `${plant}: ${count} care tasks`,
    severalPlants: (count) => `${count} plants need care`,
    severalTasks: (count) => `${count} care tasks`,
    dueToday: 'Due today.',
    dueLaterToday: 'Due later today.',
    dueYesterday: 'Due yesterday.',
    dueDaysAgo: (days) => `Due ${days} days ago.`,
    dueUnknown: 'We could not read its due date; please check it in the app.',
    singleUnclaimed: 'Nobody has claimed it yet, so anyone can.',
    singleNext: 'Mark it done once you have, or snooze it until tomorrow.',
    namesTwo: (first, second) => `${first} and ${second}`,
    namesAndMore: (names, more) => `${names} and ${more} more`,
    countOverdue: { one: '1 overdue', other: '{{count}} overdue' },
    countToday: { one: '1 due today', other: '{{count}} due today' },
    countUnknown: {
      one: '1 with no readable due date',
      other: '{{count}} with no readable due date',
    },
    countJoin: ', ',
    countLastJoin: ' and ',
    severalUnclaimed: (count) => `Nobody has claimed ${count} of them.`,
    severalNext: 'Tap to see the list.',
    actions: { done: 'Done', snoozeUntilTomorrow: 'Snooze until tomorrow' },
  },
  es: {
    singleTitle: {
      water: (plant) => `${plant} necesita riego`,
      fertilize: (plant) => `${plant} necesita abono`,
      prune: (plant) => `${plant} necesita poda`,
      repot: (plant) => `${plant} necesita trasplante`,
    },
    singleTitleUnnamedPlant: {
      water: (plant) => `${capitalize(plant)} necesita riego`,
      fertilize: (plant) => `${capitalize(plant)} necesita abono`,
      prune: (plant) => `${capitalize(plant)} necesita poda`,
      repot: (plant) => `${capitalize(plant)} necesita trasplante`,
    },
    singleTitleCustom: (plant, task) => `${capitalize(plant)}: ${task}`,
    severalSameType: {
      water: (count) => `${count} plantas necesitan riego`,
      fertilize: (count) => `${count} plantas necesitan abono`,
      prune: (count) => `${count} plantas necesitan poda`,
      repot: (count) => `${count} plantas necesitan trasplante`,
    },
    severalOnePlant: (plant, count) => `${capitalize(plant)}: ${count} tareas de cuidado`,
    severalPlants: (count) => `${count} plantas necesitan cuidados`,
    severalTasks: (count) => `${count} tareas de cuidado`,
    dueToday: 'Toca hoy.',
    dueLaterToday: 'Toca hoy, más tarde.',
    dueYesterday: 'Tocaba ayer.',
    dueDaysAgo: (days) => `Tocaba hace ${days} días.`,
    dueUnknown: 'No pudimos leer su fecha; compruébala en la aplicación.',
    singleUnclaimed: 'Nadie la ha tomado todavía, así que cualquiera puede hacerlo.',
    singleNext: 'Márcala como hecha cuando la hagas, o pospónla hasta mañana.',
    namesTwo: (first, second) => `${first} y ${second}`,
    namesAndMore: (names, more) => `${names} y ${more} más`,
    countOverdue: { one: '1 atrasada', other: '{{count}} atrasadas' },
    countToday: { one: '1 para hoy', other: '{{count}} para hoy' },
    countUnknown: { one: '1 sin fecha legible', other: '{{count}} sin fecha legible' },
    countJoin: ', ',
    countLastJoin: ' y ',
    severalUnclaimed: (count) => `Nadie ha tomado ${count} de ellas.`,
    severalNext: 'Toca para ver la lista.',
    actions: { done: 'Hecho', snoozeUntilTomorrow: 'Posponer hasta mañana' },
  },
};

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toLocaleUpperCase() + text.slice(1);
}

function formatCount(count: number, locale: ReminderLocale): string {
  return new Intl.NumberFormat(locale).format(count);
}

function plural(form: { one: string; other: string }, count: number, locale: ReminderLocale) {
  return (count === 1 ? form.one : form.other).replace('{{count}}', formatCount(count, locale));
}

/**
 * The "when" sentence for one task. Rule 3: a date, not a verdict. `today`
 * and `upcoming` are the two halves of the due day (`reminders.dueStateFor`),
 * and `unknown` says the date could not be read rather than inventing one.
 */
function dueSentence(due: DueState, locale: ReminderLocale): string {
  const copy = COPY[locale];
  switch (due.kind) {
    case 'today':
      return copy.dueToday;
    case 'upcoming':
      return copy.dueLaterToday;
    case 'overdue':
      return due.days === 1 ? copy.dueYesterday : copy.dueDaysAgo(formatCount(due.days, locale));
    default:
      return copy.dueUnknown;
  }
}

type BuiltInTaskType = Exclude<ReminderTaskType, 'custom'>;

const BUILT_IN_TYPES: ReadonlySet<string> = new Set(['water', 'fertilize', 'prune', 'repot']);

/**
 * A type with a verb of its own. `custom` and anything unrecognised (a row
 * whose type did not load, or a type newer than this catalog) take the
 * plant-first shape, where the label says what is known, including when
 * nothing is: "Monstera: unnamed care task", never the raw stored value.
 */
function builtInType(type: ReminderTaskType): BuiltInTaskType | null {
  return BUILT_IN_TYPES.has(type) ? (type as BuiltInTaskType) : null;
}

function singleTitle(row: ReminderCopyRow, locale: ReminderLocale): string {
  const copy = COPY[locale];
  const described = describeRow(row, locale);
  const type = builtInType(row.taskType);
  if (type === null) {
    return copy.singleTitleCustom(described.plant, described.task);
  }
  // A loaded name is a proper noun ("Water the Monstera"); the unloaded-name
  // phrase is a description, and "Water the a plant whose name..." is not a
  // sentence.
  return row.plantName === null
    ? copy.singleTitleUnnamedPlant[type](described.plant)
    : copy.singleTitle[type](described.plant);
}

function singleBody(row: ReminderCopyRow, locale: ReminderLocale): string {
  const copy = COPY[locale];
  const sentences = [dueSentence(row.due, locale)];
  if (row.upForGrabs) sentences.push(copy.singleUnclaimed);
  sentences.push(copy.singleNext);
  return sentences.join(' ');
}

function severalTitle(rows: readonly ReminderCopyRow[], locale: ReminderLocale): string {
  const copy = COPY[locale];
  const count = formatCount(rows.length, locale);
  const plants = new Set(rows.map((row) => describeRow(row, locale).plant));
  if (plants.size === 1) {
    return copy.severalOnePlant(describeRow(rows[0], locale).plant, count);
  }
  const onePerPlant = plants.size === rows.length;
  const type = builtInType(rows[0].taskType);
  if (onePerPlant && type !== null && rows.every((row) => row.taskType === type)) {
    return copy.severalSameType[type](count);
  }
  return onePerPlant ? copy.severalPlants(count) : copy.severalTasks(count);
}

/**
 * The first `NAMED_ROWS` plants, then the number of rows not named (rule 4).
 * Two rows on one plant name it once; the remainder is counted in rows, so
 * the reader knows how many tasks are waiting, not how many plants.
 */
function namesSentence(rows: readonly ReminderCopyRow[], locale: ReminderLocale): string {
  const copy = COPY[locale];
  const named = rows.slice(0, NAMED_ROWS).map((row) => describeRow(row, locale).plant);
  const distinct = [...new Set(named)];
  const names =
    distinct.length === 1
      ? capitalize(distinct[0])
      : copy.namesTwo(capitalize(distinct[0]), distinct[1]);
  const more = rows.length - named.length;
  return `${more > 0 ? copy.namesAndMore(names, formatCount(more, locale)) : names}.`;
}

/** The counts sentence, every zero omitted, the same way the email's summary is built. */
function countsSentence(rows: readonly ReminderCopyRow[], locale: ReminderLocale): string {
  const copy = COPY[locale];
  let overdue = 0;
  let today = 0;
  let unknown = 0;
  for (const row of rows) {
    if (row.due.kind === 'overdue') overdue += 1;
    else if (row.due.kind === 'unknown') unknown += 1;
    else today += 1;
  }
  const parts: string[] = [];
  if (overdue > 0) parts.push(plural(copy.countOverdue, overdue, locale));
  if (today > 0) parts.push(plural(copy.countToday, today, locale));
  if (unknown > 0) parts.push(plural(copy.countUnknown, unknown, locale));
  const joined =
    parts.length <= 1
      ? (parts[0] ?? '')
      : `${parts.slice(0, -1).join(copy.countJoin)}${copy.countLastJoin}${parts[parts.length - 1]}`;
  return `${capitalize(joined)}.`;
}

function severalBody(rows: readonly ReminderCopyRow[], locale: ReminderLocale): string {
  const copy = COPY[locale];
  const sentences = [namesSentence(rows, locale), countsSentence(rows, locale)];
  const unclaimed = rows.filter((row) => row.upForGrabs).length;
  if (unclaimed > 0) sentences.push(copy.severalUnclaimed(formatCount(unclaimed, locale)));
  sentences.push(copy.severalNext);
  return sentences.join(' ');
}

/**
 * The short form of a reminder: its title, its body and, when it is about one
 * task, the labels of the actions a notification can offer on it.
 *
 * `rows` must be non-empty: a reminder with nothing to say is not sent, and
 * `reminders.ts` never reaches composition for one.
 */
export function composeReminderShortCopy(input: ReminderCopyInput): ReminderShortCopy {
  const { rows, locale } = input;
  if (rows.length === 0) {
    throw new Error('composeReminderShortCopy: a reminder needs at least one row');
  }
  if (rows.length === 1) {
    return {
      title: singleTitle(rows[0], locale),
      body: singleBody(rows[0], locale),
      kind: 'single',
      actions: { ...COPY[locale].actions },
    };
  }
  return {
    title: severalTitle(rows, locale),
    body: severalBody(rows, locale),
    kind: 'several',
    actions: null,
  };
}

/** The action labels on their own, for a surface that registers them ahead of any reminder. */
export function reminderActionCopy(locale: ReminderLocale): ReminderActionCopy {
  return { ...COPY[locale].actions };
}

export const __testing = { COPY, dueSentence, namesSentence, countsSentence };
